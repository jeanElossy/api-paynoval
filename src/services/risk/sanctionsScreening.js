// File: src/services/risk/sanctionsScreening.js
"use strict";

/**
 * --------------------------------------------------------------------------
 * PayNoval — Sanctions / PEP / Watchlist Screening Service
 * --------------------------------------------------------------------------
 *
 * Providers supportés :
 * - mock
 * - opensanctions / yente
 * - sumsub
 * - complyadvantage
 * - complyadvantage_mesh
 *
 * ENV principales :
 *
 * SANCTIONS_SCREENING_ENABLED=true
 * SANCTIONS_SCREENING_PROVIDER=mock
 * SANCTIONS_SCREENING_THRESHOLD=0.85
 * SANCTIONS_SCREENING_REVIEW_THRESHOLD=0.70
 * SANCTIONS_SCREENING_TIMEOUT_MS=8000
 * SANCTIONS_SCREENING_FAIL_CLOSED=true
 * SANCTIONS_SCREENING_BLOCK_PEP=false
 *
 * OpenSanctions / Yente :
 * SANCTIONS_SCREENING_BASE_URL=http://localhost:8000
 * SANCTIONS_SCREENING_DATASET=default
 * SANCTIONS_SCREENING_API_KEY=
 * SANCTIONS_SCREENING_AUTH_SCHEME=ApiKey
 *
 * Sumsub :
 * SUMSUB_BASE_URL=https://api.sumsub.com
 * SUMSUB_APP_TOKEN=
 * SUMSUB_SECRET_KEY=
 * SUMSUB_REQUIRE_APPLICANT_ID=true
 * SUMSUB_REVIEW_ON_TRIGGER=false
 *
 * ComplyAdvantage classique :
 * COMPLYADVANTAGE_BASE_URL=https://api.complyadvantage.com
 * COMPLYADVANTAGE_API_KEY=
 * COMPLYADVANTAGE_SEARCH_PROFILE=
 * COMPLYADVANTAGE_FUZZINESS=0.6
 * COMPLYADVANTAGE_EXACT_MATCH=false
 *
 * ComplyAdvantage Mesh :
 * COMPLYADVANTAGE_MESH_BASE_URL=https://api.mesh.complyadvantage.com
 * COMPLYADVANTAGE_MESH_USERNAME=
 * COMPLYADVANTAGE_MESH_PASSWORD=
 * COMPLYADVANTAGE_MESH_REALM=
 * COMPLYADVANTAGE_MESH_SCREENING_PROFILE_IDENTIFIER=
 */

const axios = require("axios");
const crypto = require("crypto");

/**
 * Chargement DIRECT, sans `try/catch`. La version du bord se repliait en
 * silence sur `console` quand le logger ne se résolvait pas : un criblage de
 * sanctions qui journalise dans le vide est un criblage qu'on ne peut pas
 * auditer, et personne ne l'aurait su. Si ce `require` échoue, le service ne
 * démarre pas — c'est la bonne conséquence (règle B.1).
 */
const logger = require("../../utils/logger");

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_THRESHOLD = 0.85;
const DEFAULT_REVIEW_THRESHOLD = 0.7;

let complyAdvantageMeshTokenCache = {
  accessToken: "",
  expiresAt: 0,
};

/* -------------------------------------------------------------------------- */
/* Helpers config                                                             */
/* -------------------------------------------------------------------------- */

function safeString(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function low(value) {
  return safeString(value).toLowerCase();
}

function normalizeText(value = "") {
  return safeString(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  return ["true", "1", "yes", "oui", "on"].includes(
    String(value).trim().toLowerCase()
  );
}

function isEnabled() {
  return toBool(process.env.SANCTIONS_SCREENING_ENABLED, false);
}

function getProvider() {
  return low(process.env.SANCTIONS_SCREENING_PROVIDER || "mock");
}

function getBaseUrl() {
  return safeString(process.env.SANCTIONS_SCREENING_BASE_URL).replace(/\/+$/, "");
}

function getDataset() {
  return safeString(process.env.SANCTIONS_SCREENING_DATASET, "default");
}

function getThreshold() {
  return Math.min(
    1,
    Math.max(0, toNumber(process.env.SANCTIONS_SCREENING_THRESHOLD, DEFAULT_THRESHOLD))
  );
}

function getReviewThreshold() {
  return Math.min(
    1,
    Math.max(
      0,
      toNumber(process.env.SANCTIONS_SCREENING_REVIEW_THRESHOLD, DEFAULT_REVIEW_THRESHOLD)
    )
  );
}

function getTimeoutMs() {
  return Math.max(
    1000,
    toNumber(process.env.SANCTIONS_SCREENING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  );
}

function shouldFailClosed() {
  if (process.env.SANCTIONS_SCREENING_FAIL_CLOSED !== undefined) {
    return toBool(process.env.SANCTIONS_SCREENING_FAIL_CLOSED, false);
  }

  return process.env.NODE_ENV === "production";
}

function shouldBlockPep() {
  return toBool(process.env.SANCTIONS_SCREENING_BLOCK_PEP, false);
}

function normalizeCountry(value) {
  const raw = safeString(value).toUpperCase();
  if (/^[A-Z]{2}$/.test(raw)) return raw;

  const text = normalizeText(value);

  const map = {
    "cote d'ivoire": "CI",
    "cote d ivoire": "CI",
    "cote divoire": "CI",
    "ivory coast": "CI",
    france: "FR",
    canada: "CA",
    belgique: "BE",
    belgium: "BE",
    germany: "DE",
    allemagne: "DE",
    senegal: "SN",
    mali: "ML",
    "burkina faso": "BF",
    cameroun: "CM",
    cameroon: "CM",
    usa: "US",
    "united states": "US",
    "etats unis": "US",
  };

  return map[text] || "";
}

function normalizeDateOnly(value) {
  if (!value) return "";

  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return "";

  return d.toISOString().slice(0, 10);
}

function normalizeBirthYear(value) {
  const date = normalizeDateOnly(value);
  if (date) return date.slice(0, 4);

  const raw = safeString(value);
  const match = raw.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : "";
}

function normalizePhone(value) {
  return safeString(value).replace(/[^\d+]/g, "");
}

function normalizeEmail(value) {
  return low(value);
}

function normalizeIban(value) {
  return safeString(value).replace(/\s+/g, "").toUpperCase();
}

function uniq(list) {
  return Array.from(
    new Set(
      (Array.isArray(list) ? list : [])
        .map((x) => safeString(x))
        .filter(Boolean)
    )
  );
}

function getUserId(user = {}) {
  return safeString(user._id || user.id || user.userId);
}

function getClientRef(prefix, value) {
  const clean = safeString(value || crypto.randomBytes(8).toString("hex"))
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);

  return `${prefix}_${clean}`.slice(0, 100);
}

/* -------------------------------------------------------------------------- */
/* Entities                                                                   */
/* -------------------------------------------------------------------------- */

function buildPersonEntity({ name, email, phone, birthDate, country, iban }) {
  const properties = {};

  const names = uniq(Array.isArray(name) ? name : [name]);
  if (names.length) properties.name = names;

  const emails = uniq([normalizeEmail(email)]);
  if (emails.length) properties.email = emails;

  const phones = uniq([normalizePhone(phone)]);
  if (phones.length) properties.phone = phones;

  const birth = normalizeDateOnly(birthDate);
  if (birth) properties.birthDate = [birth];

  const countryCode = normalizeCountry(country);
  if (countryCode) {
    properties.country = [countryCode];
    properties.nationality = [countryCode];
  }

  const ibanValue = normalizeIban(iban);
  if (ibanValue) properties.iban = [ibanValue];

  if (!properties.name && !properties.email && !properties.phone && !properties.iban) {
    return null;
  }

  return {
    schema: "Person",
    properties,
  };
}

function buildCompanyEntity({ name, country, registrationNumber, iban }) {
  const properties = {};

  const names = uniq(Array.isArray(name) ? name : [name]);
  if (names.length) properties.name = names;

  const countryCode = normalizeCountry(country);
  if (countryCode) {
    properties.country = [countryCode];
    properties.jurisdiction = [countryCode];
  }

  const reg = safeString(registrationNumber);
  if (reg) properties.registrationNumber = [reg];

  const ibanValue = normalizeIban(iban);
  if (ibanValue) properties.iban = [ibanValue];

  if (!properties.name && !properties.registrationNumber && !properties.iban) {
    return null;
  }

  return {
    schema: "Company",
    properties,
  };
}

function getRecipientNames(body = {}, names = []) {
  const recipientInfo =
    body.recipientInfo && typeof body.recipientInfo === "object"
      ? body.recipientInfo
      : {};

  return uniq([
    ...names,
    body.toName,
    body.recipientName,
    body.accountHolder,
    body.cardHolder,
    recipientInfo.name,
    recipientInfo.accountHolderName,
    recipientInfo.holder,
    recipientInfo.summary,
  ]);
}

function buildScreeningQueries({
  user = {},
  body = {},
  toEmail = "",
  iban = "",
  phoneNumber = "",
  destinationCountryISO = "",
  names = [],
}) {
  const queries = {};

  const senderIsBusiness =
    user.isBusiness === true ||
    String(user.userType || "").toLowerCase() === "entreprise" ||
    String(user.role || "").toLowerCase() === "business";

  const senderName =
    user.fullName ||
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.name ||
    user.email ||
    "";

  const senderEntity = senderIsBusiness
    ? buildCompanyEntity({
        name: user.businessName || user.companyName || user.fullName || senderName,
        country: user.registrationCountry || user.country || user.countryCode,
        registrationNumber: user.registrationNumber,
      })
    : buildPersonEntity({
        name: senderName,
        email: user.email,
        phone: user.phone || user.phoneNumber,
        birthDate: user.dateOfBirth || user.birthDate,
        country: user.country || user.countryCode,
      });

  if (senderEntity) queries.sender = senderEntity;

  const recipientNames = getRecipientNames(body, names);

  const recipientEntity = buildPersonEntity({
    name: recipientNames,
    email: toEmail,
    phone: phoneNumber,
    iban,
    country:
      body.destinationCountry ||
      body.countryTarget ||
      body.toCountry ||
      body.country ||
      destinationCountryISO,
  });

  if (recipientEntity) queries.recipient = recipientEntity;

  const companyRecipient = buildCompanyEntity({
    name: body.companyName || body.businessName || body.recipientCompanyName,
    country:
      body.destinationCountry ||
      body.countryTarget ||
      body.toCountry ||
      body.country ||
      destinationCountryISO,
    registrationNumber: body.registrationNumber,
    iban,
  });

  if (companyRecipient) queries.recipientCompany = companyRecipient;

  return queries;
}

function getPrimaryNameFromEntity(entity = {}) {
  const name = entity.properties?.name;
  if (Array.isArray(name) && name[0]) return safeString(name[0]);
  if (typeof name === "string") return safeString(name);
  return "";
}

function getCountryFromEntity(entity = {}) {
  const country =
    entity.properties?.country ||
    entity.properties?.nationality ||
    entity.properties?.jurisdiction;

  if (Array.isArray(country) && country[0]) return safeString(country[0]);
  if (typeof country === "string") return safeString(country);
  return "";
}

function getBirthDateFromEntity(entity = {}) {
  const birth = entity.properties?.birthDate;
  if (Array.isArray(birth) && birth[0]) return safeString(birth[0]);
  if (typeof birth === "string") return safeString(birth);
  return "";
}

/* -------------------------------------------------------------------------- */
/* Common hit parsing                                                         */
/* -------------------------------------------------------------------------- */

function getResultScore(result = {}) {
  return (
    toNumber(result.score, 0) ||
    toNumber(result.match, 0) ||
    toNumber(result.matchScore, 0) ||
    toNumber(result.risk_score, 0) ||
    toNumber(result.features?.score, 0) ||
    0
  );
}

function collectTextDeep(value, out = []) {
  if (value == null) return out;

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    out.push(String(value));
    return out;
  }

  if (Array.isArray(value)) {
    value.forEach((x) => collectTextDeep(x, out));
    return out;
  }

  if (typeof value === "object") {
    Object.values(value).forEach((x) => collectTextDeep(x, out));
  }

  return out;
}

function detectHitKind(result = {}) {
  const text = normalizeText(collectTextDeep(result).join(" "));

  const sanctionsMarkers = [
    "sanction",
    "sanctions",
    "asset freeze",
    "asset.freeze",
    "blocked",
    "sdn",
    "ofac",
    "un security council",
    "unsc",
    "eu financial sanctions",
    "canadian sanctions",
  ];

  const pepMarkers = [
    "politically exposed",
    "pep",
    "public office",
    "public figure",
  ];

  const wantedMarkers = [
    "wanted",
    "law enforcement",
    "interpol",
  ];

  const adverseMediaMarkers = [
    "adverse",
    "negative media",
    "adverse-media",
  ];

  if (sanctionsMarkers.some((m) => text.includes(m))) return "sanctions";
  if (wantedMarkers.some((m) => text.includes(m))) return "wanted";
  if (pepMarkers.some((m) => text.includes(m))) return "pep";
  if (adverseMediaMarkers.some((m) => text.includes(m))) return "adverse_media";

  return "watchlist";
}

function sanitizeHit(queryId, result = {}) {
  const entity = result.entity || result.target || result.doc || result;

  const id = safeString(
    result.id ||
      entity.id ||
      result.entity_id ||
      result.identifier ||
      result.ref ||
      result.search_id
  );

  const caption = safeString(
    result.caption ||
      result.name ||
      result.matching_name ||
      entity.caption ||
      entity.name ||
      entity.properties?.name?.[0] ||
      entity.name_original ||
      "Correspondance potentielle"
  );

  const score = getResultScore(result) || 0.9;
  const kind = detectHitKind(result);

  return {
    queryId,
    id,
    caption,
    score,
    kind,
    schema: safeString(result.schema || entity.schema || entity.entity_type),
    datasets: Array.isArray(result.datasets)
      ? result.datasets.slice(0, 10)
      : Array.isArray(entity.datasets)
      ? entity.datasets.slice(0, 10)
      : [],
    topics: Array.isArray(result.topics)
      ? result.topics.slice(0, 10)
      : Array.isArray(entity.topics)
      ? entity.topics.slice(0, 10)
      : Array.isArray(entity.types)
      ? entity.types.slice(0, 10)
      : [],
    rawType: safeString(result.type || entity.type || entity.entity_type),
  };
}

function decideScreeningOutcome(hits = []) {
  const threshold = getThreshold();
  const reviewThreshold = getReviewThreshold();
  const blockPep = shouldBlockPep();

  let blocked = false;
  let reviewRequired = false;
  let reason = "";
  let maxScore = 0;

  for (const hit of hits) {
    maxScore = Math.max(maxScore, hit.score);

    const highConfidence = hit.score >= threshold;
    const mediumConfidence = hit.score >= reviewThreshold;

    if (highConfidence && ["sanctions", "wanted"].includes(hit.kind)) {
      blocked = true;
      reason = `Correspondance ${hit.kind} détectée`;
      break;
    }

    if (highConfidence && hit.kind === "pep" && blockPep) {
      blocked = true;
      reason = "Correspondance PEP bloquée par configuration";
      break;
    }

    if (mediumConfidence) {
      reviewRequired = true;
      reason = `Correspondance potentielle ${hit.kind}`;
    }
  }

  return {
    blocked,
    reviewRequired: blocked ? false : reviewRequired,
    reason,
    maxScore,
  };
}

/* -------------------------------------------------------------------------- */
/* OpenSanctions / Yente                                                      */
/* -------------------------------------------------------------------------- */

function buildYentePayload(queries) {
  return {
    queries,
    limit: Math.max(1, Number(process.env.SANCTIONS_SCREENING_LIMIT || 5)),
  };
}

function getYenteAuthHeaders() {
  const apiKey = safeString(process.env.SANCTIONS_SCREENING_API_KEY);
  const authScheme = safeString(process.env.SANCTIONS_SCREENING_AUTH_SCHEME, "ApiKey");

  if (!apiKey) return {};

  return {
    Authorization: `${authScheme} ${apiKey}`,
  };
}

function extractHitsFromYenteResponse(payload = {}) {
  const hits = [];

  const responses =
    payload.responses && typeof payload.responses === "object"
      ? payload.responses
      : {};

  for (const [queryId, response] of Object.entries(responses)) {
    const results = Array.isArray(response?.results) ? response.results : [];

    for (const result of results) {
      const hit = sanitizeHit(queryId, result);
      if (hit.score > 0) hits.push(hit);
    }
  }

  if (!hits.length && Array.isArray(payload.results)) {
    for (const result of payload.results) {
      const hit = sanitizeHit("default", result);
      if (hit.score > 0) hits.push(hit);
    }
  }

  hits.sort((a, b) => b.score - a.score);

  return hits;
}

async function callOpenSanctionsYente(queries) {
  const baseUrl = getBaseUrl();

  if (!baseUrl) {
    const error = new Error("SANCTIONS_SCREENING_BASE_URL manquant");
    error.code = "SANCTIONS_BASE_URL_MISSING";
    throw error;
  }

  const dataset = encodeURIComponent(getDataset());
  const url = `${baseUrl}/match/${dataset}`;

  const response = await axios.post(url, buildYentePayload(queries), {
    timeout: getTimeoutMs(),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...getYenteAuthHeaders(),
    },
  });

  return response.data || {};
}

/* -------------------------------------------------------------------------- */
/* Sumsub                                                                     */
/* -------------------------------------------------------------------------- */

function getSumsubBaseUrl() {
  return safeString(process.env.SUMSUB_BASE_URL, "https://api.sumsub.com").replace(
    /\/+$/,
    ""
  );
}

function getSumsubApplicantIds(input = {}) {
  const user = input.user || {};
  const body = input.body || {};
  const recipientInfo =
    body.recipientInfo && typeof body.recipientInfo === "object"
      ? body.recipientInfo
      : {};

  const senderApplicantId = safeString(
    user.sumsubApplicantId ||
      user.sumsub?.applicantId ||
      user.kyc?.sumsubApplicantId ||
      user.kyb?.sumsubApplicantId ||
      user.profile?.sumsubApplicantId
  );

  const recipientApplicantId = safeString(
    body.recipientSumsubApplicantId ||
      body.receiverSumsubApplicantId ||
      recipientInfo.sumsubApplicantId ||
      recipientInfo.applicantId
  );

  return {
    senderApplicantId,
    recipientApplicantId,
  };
}

function buildSumsubHeaders(method, path, bodyString = "") {
  const appToken = safeString(process.env.SUMSUB_APP_TOKEN);
  const secretKey = safeString(process.env.SUMSUB_SECRET_KEY);

  if (!appToken || !secretKey) {
    const err = new Error("SUMSUB_APP_TOKEN ou SUMSUB_SECRET_KEY manquant");
    err.code = "SUMSUB_CREDENTIALS_MISSING";
    throw err;
  }

  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = `${ts}${String(method || "GET").toUpperCase()}${path}${bodyString || ""}`;

  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(payload)
    .digest("hex");

  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-App-Token": appToken,
    "X-App-Access-Ts": ts,
    "X-App-Access-Sig": signature,
  };
}

async function sumsubRequest({ method = "GET", path, body = null }) {
  const baseUrl = getSumsubBaseUrl();
  const bodyString = body ? JSON.stringify(body) : "";
  const headers = buildSumsubHeaders(method, path, bodyString);

  const response = await axios.request({
    method,
    url: `${baseUrl}${path}`,
    data: body || undefined,
    timeout: getTimeoutMs(),
    headers,
  });

  return response.data || {};
}

async function callSumsubAml(input = {}) {
  const { senderApplicantId, recipientApplicantId } = getSumsubApplicantIds(input);
  const applicantIds = uniq([senderApplicantId, recipientApplicantId]);

  const requireApplicantId =
    process.env.SUMSUB_REQUIRE_APPLICANT_ID !== undefined
      ? toBool(process.env.SUMSUB_REQUIRE_APPLICANT_ID, true)
      : process.env.NODE_ENV === "production";

  if (!applicantIds.length) {
    return {
      type: "sumsub",
      checked: false,
      hits: [],
      reason: "SUMSUB_APPLICANT_ID_MISSING",
      reviewRequired: requireApplicantId,
      raw: null,
    };
  }

  const results = [];

  for (const applicantId of applicantIds) {
    const path = `/resources/applicants/${encodeURIComponent(
      applicantId
    )}/recheck/aml`;

    const payload = await sumsubRequest({
      method: "POST",
      path,
    });

    results.push({
      applicantId,
      payload,
    });
  }

  const reviewOnTrigger = toBool(process.env.SUMSUB_REVIEW_ON_TRIGGER, false);

  return {
    type: "sumsub",
    checked: true,
    hits: [],
    reason: "SUMSUB_AML_RECHECK_TRIGGERED",
    reviewRequired: reviewOnTrigger,
    raw: results,
  };
}

/* -------------------------------------------------------------------------- */
/* ComplyAdvantage classique                                                  */
/* -------------------------------------------------------------------------- */

function getComplyBaseUrl() {
  return safeString(
    process.env.COMPLYADVANTAGE_BASE_URL,
    "https://api.complyadvantage.com"
  ).replace(/\/+$/, "");
}

function getComplyApiKey() {
  return safeString(process.env.COMPLYADVANTAGE_API_KEY);
}

function buildComplySearchPayload({ queryId, entity, input }) {
  const name = getPrimaryNameFromEntity(entity);
  const country = getCountryFromEntity(entity);
  const birthYear = normalizeBirthYear(getBirthDateFromEntity(entity));
  const searchProfile = safeString(process.env.COMPLYADVANTAGE_SEARCH_PROFILE);
  const fuzziness = toNumber(process.env.COMPLYADVANTAGE_FUZZINESS, 0.6);
  const exactMatch = toBool(process.env.COMPLYADVANTAGE_EXACT_MATCH, false);

  const filters = {};

  if (entity.schema === "Person") filters.entity_type = "person";
  if (entity.schema === "Company") filters.entity_type = "company";
  if (birthYear) filters.birth_year = birthYear;
  if (country) filters.country_codes = [country];

  const payload = {
    search_term: name,
    client_ref: getClientRef(
      `paynoval_${queryId}`,
      `${getUserId(input.user)}_${queryId}`
    ),
    fuzziness,
    filters,
    share_url: 1,
  };

  if (exactMatch) payload.exact_match = true;
  if (searchProfile) payload.search_profile = searchProfile;

  return payload;
}

function extractHitsFromComplyResponse(payload = {}, queryId = "default") {
  const content = payload.content || payload;
  const results = Array.isArray(content.results)
    ? content.results
    : Array.isArray(content.data)
    ? content.data
    : [];

  const hits = [];

  for (const result of results) {
    const resultHits = Array.isArray(result.hits) ? result.hits : [];

    for (const h of resultHits) {
      const details = Array.isArray(h.match_types_details)
        ? h.match_types_details
        : [];

      if (!details.length) {
        const hit = sanitizeHit(queryId, h);
        hit.score = hit.score || 0.9;
        hits.push(hit);
        continue;
      }

      for (const detail of details) {
        hits.push({
          queryId,
          id: safeString(h.doc?.id || h.id || detail.entity_id),
          caption: safeString(
            detail.matching_name || h.doc?.name || h.name || "Correspondance potentielle"
          ),
          score: 0.95,
          kind: detectHitKind({
            ...detail,
            ...h,
          }),
          schema: safeString(h.doc?.entity_type || h.entity_type),
          datasets: Array.isArray(detail.sources) ? detail.sources.slice(0, 10) : [],
          topics: Array.isArray(detail.aml_types) ? detail.aml_types.slice(0, 10) : [],
        });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}

async function callComplyAdvantageClassic(queries, input) {
  const apiKey = getComplyApiKey();

  if (!apiKey) {
    const error = new Error("COMPLYADVANTAGE_API_KEY manquant");
    error.code = "COMPLYADVANTAGE_API_KEY_MISSING";
    throw error;
  }

  const baseUrl = getComplyBaseUrl();
  const allHits = [];
  const raw = [];

  for (const [queryId, entity] of Object.entries(queries)) {
    const name = getPrimaryNameFromEntity(entity);
    if (!name) continue;

    const payload = buildComplySearchPayload({
      queryId,
      entity,
      input,
    });

    const response = await axios.post(`${baseUrl}/searches`, payload, {
      timeout: getTimeoutMs(),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Token ${apiKey}`,
      },
    });

    raw.push({
      queryId,
      payload,
      response: response.data,
    });

    allHits.push(...extractHitsFromComplyResponse(response.data, queryId));
  }

  return {
    type: "complyadvantage",
    checked: true,
    hits: allHits,
    raw,
  };
}

/* -------------------------------------------------------------------------- */
/* ComplyAdvantage Mesh                                                       */
/* -------------------------------------------------------------------------- */

function getComplyMeshBaseUrl() {
  return safeString(
    process.env.COMPLYADVANTAGE_MESH_BASE_URL,
    "https://api.mesh.complyadvantage.com"
  ).replace(/\/+$/, "");
}

async function getComplyMeshAccessToken() {
  const now = Date.now();

  if (
    complyAdvantageMeshTokenCache.accessToken &&
    complyAdvantageMeshTokenCache.expiresAt > now + 60_000
  ) {
    return complyAdvantageMeshTokenCache.accessToken;
  }

  const username = safeString(process.env.COMPLYADVANTAGE_MESH_USERNAME);
  const password = safeString(process.env.COMPLYADVANTAGE_MESH_PASSWORD);
  const realm = safeString(process.env.COMPLYADVANTAGE_MESH_REALM);

  if (!username || !password || !realm) {
    const error = new Error("Identifiants ComplyAdvantage Mesh manquants");
    error.code = "COMPLYADVANTAGE_MESH_CREDENTIALS_MISSING";
    throw error;
  }

  const baseUrl = getComplyMeshBaseUrl();

  const response = await axios.post(
    `${baseUrl}/v2/token`,
    {
      username,
      password,
      realm,
    },
    {
      timeout: getTimeoutMs(),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    }
  );

  const data = response.data || {};
  const accessToken =
    data.access_token ||
    data.accessToken ||
    data.token ||
    data.data?.access_token ||
    "";

  if (!accessToken) {
    const error = new Error("Token ComplyAdvantage Mesh introuvable");
    error.code = "COMPLYADVANTAGE_MESH_TOKEN_MISSING";
    throw error;
  }

  const expiresInSeconds = toNumber(data.expires_in || data.expiresIn, 86400);

  complyAdvantageMeshTokenCache = {
    accessToken,
    expiresAt: Date.now() + Math.max(60, expiresInSeconds - 60) * 1000,
  };

  return accessToken;
}

function buildComplyMeshCustomer({ queryId, entity, input }) {
  const name = getPrimaryNameFromEntity(entity);
  const country = getCountryFromEntity(entity);
  const birthDate = normalizeDateOnly(getBirthDateFromEntity(entity));

  const customer = {
    external_identifier: getClientRef(
      `paynoval_${queryId}`,
      `${getUserId(input.user)}_${queryId}`
    ),
    type: entity.schema === "Company" ? "COMPANY" : "PERSON",
  };

  if (entity.schema === "Company") {
    customer.company = {
      name,
      country_of_incorporation: country || undefined,
    };
  } else {
    customer.person = {
      full_name: name,
      date_of_birth: birthDate || undefined,
      nationality: country || undefined,
    };
  }

  return customer;
}

function extractHitsFromComplyMeshResponse(payload = {}, queryId = "default") {
  const stepDetails = payload.step_details || payload.stepDetails || {};
  const screening =
    stepDetails["customer-screening"] ||
    stepDetails.customer_screening ||
    stepDetails.screening ||
    {};

  const stepOutput = screening.step_output || screening.stepOutput || screening;
  const screeningResult = stepOutput.screening_result || stepOutput.screeningResult || {};

  const alerts =
    stepDetails.alerting?.step_output?.alerts ||
    stepDetails.alerting?.stepOutput?.alerts ||
    stepOutput.alerts ||
    payload.alerts ||
    [];

  const hits = [];

  const hasHits =
    screeningResult.has_hits === true ||
    screeningResult.hasHits === true ||
    Number(screeningResult.total_hits || screeningResult.totalHits || 0) > 0 ||
    (Array.isArray(alerts) && alerts.length > 0);

  if (Array.isArray(alerts) && alerts.length) {
    for (const alert of alerts) {
      hits.push({
        queryId,
        id: safeString(alert.identifier || alert.id),
        caption: safeString(alert.name || alert.title || "Alerte conformité"),
        score: 0.95,
        kind: detectHitKind(alert),
        schema: "",
        datasets: [],
        topics: [],
      });
    }
  } else if (hasHits) {
    hits.push({
      queryId,
      id: safeString(payload.workflow_execution_identifier || payload.identifier),
      caption: "Correspondance potentielle ComplyAdvantage Mesh",
      score: 0.9,
      kind: detectHitKind(payload),
      schema: "",
      datasets: [],
      topics: [],
    });
  }

  return hits;
}

async function callComplyAdvantageMesh(queries, input) {
  const baseUrl = getComplyMeshBaseUrl();
  const token = await getComplyMeshAccessToken();

  const screeningProfileIdentifier = safeString(
    process.env.COMPLYADVANTAGE_MESH_SCREENING_PROFILE_IDENTIFIER
  );

  const allHits = [];
  const raw = [];

  for (const [queryId, entity] of Object.entries(queries)) {
    const name = getPrimaryNameFromEntity(entity);
    if (!name) continue;

    const body = {
      customer: buildComplyMeshCustomer({
        queryId,
        entity,
        input,
      }),
      configuration: {},
    };

    if (screeningProfileIdentifier) {
      body.configuration.screening_profile_identifier = screeningProfileIdentifier;
    }

    const response = await axios.post(
      `${baseUrl}/v2/workflows/sync/create-and-screen?last_sync_step=ALERTING`,
      body,
      {
        timeout: getTimeoutMs(),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    raw.push({
      queryId,
      response: response.data,
    });

    allHits.push(...extractHitsFromComplyMeshResponse(response.data, queryId));
  }

  return {
    type: "complyadvantage_mesh",
    checked: true,
    hits: allHits,
    raw,
  };
}

/* -------------------------------------------------------------------------- */
/* Mock                                                                       */
/* -------------------------------------------------------------------------- */

async function mockScreening(queries) {
  const text = normalizeText(JSON.stringify(queries));

  if (
    text.includes("sanction test") ||
    text.includes("blocked test") ||
    text.includes("@sanction.test")
  ) {
    return {
      responses: {
        mock: {
          results: [
            {
              id: "mock-sanctions-hit",
              caption: "Sanction Test Person",
              score: 0.99,
              topics: ["sanctions"],
              datasets: ["mock"],
            },
          ],
        },
      },
    };
  }

  if (text.includes("pep test")) {
    return {
      responses: {
        mock: {
          results: [
            {
              id: "mock-pep-hit",
              caption: "PEP Test Person",
              score: 0.92,
              topics: ["pep"],
              datasets: ["mock"],
            },
          ],
        },
      },
    };
  }

  return {
    responses: {},
  };
}

/* -------------------------------------------------------------------------- */
/* Provider router                                                            */
/* -------------------------------------------------------------------------- */

async function runProviderScreening(queries, input) {
  const provider = getProvider();

  if (provider === "mock") {
    const payload = await mockScreening(queries);

    return {
      type: "mock",
      checked: true,
      hits: extractHitsFromYenteResponse(payload),
      raw: payload,
    };
  }

  if (provider === "opensanctions" || provider === "yente") {
    const payload = await callOpenSanctionsYente(queries);

    return {
      type: "opensanctions",
      checked: true,
      hits: extractHitsFromYenteResponse(payload),
      raw: payload,
    };
  }

  if (provider === "sumsub") {
    return callSumsubAml(input);
  }

  if (provider === "complyadvantage") {
    return callComplyAdvantageClassic(queries, input);
  }

  if (provider === "complyadvantage_mesh" || provider === "mesh") {
    return callComplyAdvantageMesh(queries, input);
  }

  const error = new Error(`Provider sanctions non supporté: ${provider}`);
  error.code = "SANCTIONS_PROVIDER_UNSUPPORTED";
  throw error;
}

/* -------------------------------------------------------------------------- */
/* Main API                                                                   */
/* -------------------------------------------------------------------------- */

async function screenTransactionCounterparties(input = {}) {
  if (!isEnabled()) {
    return {
      enabled: false,
      checked: false,
      blocked: false,
      reviewRequired: false,
      reason: "SANCTIONS_SCREENING_DISABLED",
      hits: [],
    };
  }

  const queries = buildScreeningQueries(input);
  const queryCount = Object.keys(queries).length;

  if (!queryCount) {
    return {
      enabled: true,
      checked: false,
      blocked: false,
      reviewRequired: false,
      reason: "NO_SCREENABLE_ENTITY",
      hits: [],
    };
  }

  try {
    const providerResult = await runProviderScreening(queries, input);
    const hits = Array.isArray(providerResult.hits) ? providerResult.hits : [];
    const outcome = decideScreeningOutcome(hits);

    const reviewRequired =
      outcome.reviewRequired || providerResult.reviewRequired === true;

    return {
      enabled: true,
      checked: providerResult.checked !== false,
      provider: getProvider(),
      dataset: getDataset(),
      threshold: getThreshold(),
      reviewThreshold: getReviewThreshold(),
      entitiesScreened: Object.keys(queries),
      blocked: outcome.blocked,
      reviewRequired: outcome.blocked ? false : reviewRequired,
      reason:
        outcome.reason ||
        providerResult.reason ||
        (hits.length ? "CORRESPONDANCE_POTENTIELLE" : ""),
      maxScore: outcome.maxScore,
      hits: hits.slice(0, 10),
      providerMeta: {
        type: providerResult.type,
      },
    };
  } catch (err) {
    logger.error?.("[SanctionsScreening] erreur provider", {
      provider: getProvider(),
      code: err?.code || null,
      message: err?.response?.data || err?.message || String(err),
    });

    if (shouldFailClosed()) {
      return {
        enabled: true,
        checked: false,
        blocked: true,
        reviewRequired: false,
        provider: getProvider(),
        reason: "SANCTIONS_SCREENING_UNAVAILABLE",
        error: "Service de screening indisponible",
        hits: [],
      };
    }

    return {
      enabled: true,
      checked: false,
      blocked: false,
      reviewRequired: true,
      provider: getProvider(),
      reason: "SANCTIONS_SCREENING_UNAVAILABLE_REVIEW",
      error: "Service de screening indisponible",
      hits: [],
    };
  }
}

module.exports = {
  screenTransactionCounterparties,
  buildScreeningQueries,

  // Exports utiles pour tests unitaires
  normalizeCountry,
  decideScreeningOutcome,
};