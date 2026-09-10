// File: src/middleware/aml.js
"use strict";

const logger = require("../utils/logger");

const {
  logTransaction,
  getUserTransactionsStats,
  getPEPOrSanctionedStatus,
  getBusinessKYBStatus,
} = require("../services/aml");

const { sendFraudAlert } = require("../utils/alert");

const {
  getCurrencySymbolByCode,
  getCurrencyCodeByCountry,
} = require("../tools/currency");

const {
  getDailyLimit,
  getSingleTxLimit,
  AmlLimitUnavailableError,
} = require("../tools/amlLimits");

/**
 * Moteur de risque : liste noire dynamique, vélocité Redis, score déterministe.
 * Voir `services/risk/index.js` — tout y est paresseux et rien n'y lève.
 */
const riskEngine = require("../services/risk");

const RISKY_COUNTRIES_ISO = new Set([
  "IR",
  "KP",
  "SD",
  "SY",
  "CU",
  "RU",
  "AF",
  "SO",
  "YE",
  "VE",
  "LY",
]);

const ALLOWED_STRIPE_CURRENCY_CODES = ["EUR", "USD", "CAD"];

const EMPTY_BLACKLIST = Object.freeze({
  emails: [],
  ibans: [],
  phones: [],
  userIds: [],
  countries: [],
  names: [],
});

/* -------------------------------------------------------------------------- */
/* Blacklist                                                                  */
/* -------------------------------------------------------------------------- */

function toArrayOfStrings(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function loadBlacklist() {
  try {
    // eslint-disable-next-line global-require
    const loaded = require("../aml/blacklist.json");

    return {
      emails: toArrayOfStrings(loaded?.emails),
      ibans: toArrayOfStrings(loaded?.ibans),
      phones: toArrayOfStrings(loaded?.phones),
      userIds: toArrayOfStrings(loaded?.userIds),
      countries: toArrayOfStrings(loaded?.countries),
      names: toArrayOfStrings(loaded?.names),
    };
  } catch (err) {
    logger.warn("[AML] blacklist.json absent ou invalide, fallback vide", {
      error: err?.message || String(err),
    });

    return { ...EMPTY_BLACKLIST };
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeIban(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function normalizePhone(value) {
  return String(value || "")
    .trim()
    .replace(/[^\d+]/g, "");
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function makeSet(list, normalizer) {
  return new Set(toArrayOfStrings(list).map(normalizer).filter(Boolean));
}

/**
 * ============================================================================
 * ⚠️ `BLACKLIST` N'EST PLUS LA SOURCE DE VÉRITÉ — VOIR `services/risk/`
 * ============================================================================
 *
 * Ces ensembles étaient construits UNE FOIS, au chargement du module, depuis
 * `aml/blacklist.json`. Inscrire un compte frauduleux exigeait donc un commit
 * et un déploiement ; `require` mettait le fichier en cache, si bien que le
 * réécrire sur le disque ne changeait rien ; et à plusieurs instances chacune
 * gardait sa copie figée à l'instant de son démarrage.
 *
 * Ils sont CONSERVÉS comme repli : `riskEngine.blacklist()` rend un magasin
 * inerte tant que `initRiskEngine()` n'a pas tourné (tests, scripts, démarrage
 * partiel). Dans ce cas la liste statique continue de s'appliquer — jamais
 * moins de protection qu'avant ce chantier.
 */
const blacklistRaw = loadBlacklist();

const BLACKLIST = {
  emails: makeSet(blacklistRaw.emails, normalizeEmail),
  ibans: makeSet(blacklistRaw.ibans, normalizeIban),
  phones: makeSet(blacklistRaw.phones, normalizePhone),
  userIds: makeSet(blacklistRaw.userIds, (v) => String(v || "").trim()),
  countries: makeSet(blacklistRaw.countries, (v) =>
    String(v || "").trim().toUpperCase()
  ),
  names: makeSet(blacklistRaw.names, normalizeName),
};

/* -------------------------------------------------------------------------- */
/* Utils                                                                      */
/* -------------------------------------------------------------------------- */

function maskSensitive(obj) {
  const SENSITIVE_FIELDS = [
    "password",
    "cardNumber",
    "iban",
    "cvc",
    "securityCode",
    "securityAnswer",
    "otp",
    "code",
    "pin",
    "amlSecurityAnswer",
  ];

  if (!obj || typeof obj !== "object") return obj;

  const out = Array.isArray(obj) ? [] : {};

  for (const k of Object.keys(obj)) {
    if (SENSITIVE_FIELDS.includes(k)) {
      out[k] = "***";
    } else if (obj[k] && typeof obj[k] === "object") {
      out[k] = maskSensitive(obj[k]);
    } else {
      out[k] = obj[k];
    }
  }

  return out;
}

function parseAmount(v) {
  if (v == null) return 0;

  if (typeof v === "number") {
    return Number.isFinite(v) ? v : 0;
  }

  const s = String(v).replace(/\s/g, "").replace(",", ".").trim();
  const n = parseFloat(s);

  return Number.isFinite(n) ? n : 0;
}

function normalizeText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeStatus(value = "") {
  return normalizeText(value).replace(/\s+/g, "_");
}

function isApprovedStatus(value) {
  const status = normalizeStatus(value);

  return [
    "validé",
    "valide",
    "verified",
    "verifie",
    "validated",
    "approved",
    "complete",
    "completed",
    "success",
    "accepted",
    "active",
  ].includes(status);
}

function isPositiveFlag(value) {
  if (value === true) return true;

  if (value instanceof Date) {
    return Number.isFinite(value.getTime());
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0;
  }

  return isApprovedStatus(value);
}

function isEmailVerified(user = {}) {
  return (
    isPositiveFlag(user.emailVerified) ||
    isPositiveFlag(user.isEmailVerified) ||
    isPositiveFlag(user.emailVerifiedAt) ||
    isPositiveFlag(user.emailVerification?.verified) ||
    isPositiveFlag(user.emailVerification?.status) ||
    isPositiveFlag(user.verifications?.email?.verified) ||
    isPositiveFlag(user.verifications?.email?.status) ||
    isPositiveFlag(user.profile?.emailVerified) ||
    isPositiveFlag(user.profile?.emailVerifiedAt)
  );
}

function isPhoneVerified(user = {}) {
  return (
    isPositiveFlag(user.phoneVerified) ||
    isPositiveFlag(user.isPhoneVerified) ||
    isPositiveFlag(user.phoneVerifiedAt) ||
    isPositiveFlag(user.phoneVerification?.verified) ||
    isPositiveFlag(user.phoneVerification?.status) ||
    isPositiveFlag(user.verifications?.phone?.verified) ||
    isPositiveFlag(user.verifications?.phone?.status) ||
    isPositiveFlag(user.profile?.phoneVerified) ||
    isPositiveFlag(user.profile?.phoneVerifiedAt)
  );
}

function isBusinessUser(user = {}) {
  const userType = normalizeStatus(
    user.userType || user.type || user.accountType || user.profile?.userType
  );
  const role = normalizeStatus(user.role);

  return (
    user.isBusiness === true ||
    userType === "business" ||
    userType === "entreprise" ||
    userType === "company" ||
    role === "business"
  );
}

function isKycValid(user = {}) {
  const level = Number(user.kycLevel || user.profile?.kycLevel || 0);

  return (
    level >= 2 ||
    isApprovedStatus(user.kycStatus) ||
    isApprovedStatus(user.kyc?.status) ||
    isApprovedStatus(user.kyc?.verificationStatus) ||
    isApprovedStatus(user.verifications?.kyc?.status) ||
    isPositiveFlag(user.kycVerified) ||
    isPositiveFlag(user.isKycVerified)
  );
}

async function isKybValid(user = {}) {
  const level = Number(
    user.businessKYBLevel ||
      user.business?.businessKYBLevel ||
      user.kybLevel ||
      0
  );

  if (
    level >= 2 ||
    isApprovedStatus(user.kybStatus) ||
    isApprovedStatus(user.businessStatus) ||
    isApprovedStatus(user.kyb?.status) ||
    isApprovedStatus(user.kyb?.verificationStatus) ||
    isApprovedStatus(user.business?.kybStatus) ||
    isApprovedStatus(user.business?.businessStatus) ||
    isPositiveFlag(user.kybVerified) ||
    isPositiveFlag(user.isKybVerified)
  ) {
    return true;
  }

  if (typeof getBusinessKYBStatus === "function") {
    try {
      const kybStatus = await getBusinessKYBStatus(
        user.businessId || user._id || user.id
      );

      return isApprovedStatus(kybStatus);
    } catch {
      return false;
    }
  }

  return false;
}

function normalizeCountryToISO(country) {
  if (!country) return "";

  const raw = String(country).trim();
  if (!raw) return "";

  if (/^[A-Z]{2}$/i.test(raw)) {
    return raw.toUpperCase();
  }

  const n = normalizeText(raw);

  const map = {
    france: "FR",
    "cote d'ivoire": "CI",
    "cote d ivoire": "CI",
    "cote divoire": "CI",
    "ivory coast": "CI",
    "burkina faso": "BF",
    mali: "ML",
    senegal: "SN",
    cameroun: "CM",
    cameroon: "CM",
    belgique: "BE",
    belgium: "BE",
    allemagne: "DE",
    germany: "DE",
    usa: "US",
    "etats-unis": "US",
    "etats unis": "US",
    "united states": "US",
    canada: "CA",
    uk: "GB",
    "royaume-uni": "GB",
    "royaume uni": "GB",
    "united kingdom": "GB",
    russie: "RU",
    russia: "RU",
  };

  return map[n] || "";
}

function resolveProvider(req) {
  const rp = String(req.routedProvider || "").trim().toLowerCase();
  if (rp) return rp;

  const b = req.body || {};

  const p =
    String(b.provider || "").trim().toLowerCase() ||
    String(b.metadata?.provider || "").trim().toLowerCase() ||
    String(b.destination || "").trim().toLowerCase() ||
    String(b.funds || "").trim().toLowerCase();

  return p || "paynoval";
}

function normalizeCurrencyISO(v) {
  const s0 = String(v || "").trim().toUpperCase();
  if (!s0) return "";

  const s = s0.replace(/\u00A0/g, " ");

  if (s === "FCFA" || s === "CFA" || s === "F CFA" || s.includes("CFA")) {
    return "XOF";
  }

  if (s === "€") return "EUR";
  if (s === "$") return "USD";
  if (s === "£") return "GBP";

  const letters = s.replace(/[^A-Z]/g, "");

  if (["CAD", "USD", "EUR", "GBP", "XOF", "XAF"].includes(letters)) {
    return letters;
  }

  if (/^[A-Z]{3}$/.test(letters)) return letters;
  if (/^[A-Z]{3}$/.test(s)) return s;

  return "";
}

function resolveCurrencyCode(req) {
  const b = req.body || {};
  const user = req.user || {};

  const candidate =
    b.money?.source?.currency ||
    b.senderCurrencySymbol ||
    b.currencySource ||
    b.senderCurrencyCode ||
    b.currencyCode ||
    b.currencySender ||
    b.currency ||
    b.selectedCurrency ||
    b.fromCurrency ||
    "";

  let iso = normalizeCurrencyISO(candidate);

  if (!iso) {
    const senderCountry =
      user?.selectedCountry || user?.country || user?.countryCode || "";
    iso = normalizeCurrencyISO(getCurrencyCodeByCountry(senderCountry));
  }

  if (!iso) {
    const lastResortCountry =
      b.senderCountry || b.originCountry || b.fromCountry || b.country || "";
    iso = normalizeCurrencyISO(getCurrencyCodeByCountry(lastResortCountry));
  }

  if (!/^[A-Z]{3}$/.test(iso)) iso = "USD";

  return iso;
}

function resolveDestinationCountryISO(req) {
  const b = req.body || {};
  const user = req.user || {};

  const raw =
    b.destinationCountry ||
    b.countryTarget ||
    b.toCountry ||
    b.country ||
    user?.country ||
    user?.selectedCountry ||
    "";

  return normalizeCountryToISO(raw);
}

function resolveTargetIdentifiers(body = {}) {
  const recipientInfo =
    body.recipientInfo && typeof body.recipientInfo === "object"
      ? body.recipientInfo
      : {};

  const toEmail =
    body.toEmail ||
    body.email ||
    body.recipientEmail ||
    recipientInfo.email ||
    recipientInfo.mail ||
    "";

  const iban =
    body.iban ||
    body.toIBAN ||
    body.recipientIban ||
    recipientInfo.iban ||
    "";

  const phoneNumber =
    body.phoneNumber ||
    body.toPhone ||
    body.phone ||
    body.recipientPhone ||
    recipientInfo.phone ||
    recipientInfo.numero ||
    "";

  const names = [
    body.toName,
    body.recipientName,
    body.accountHolder,
    body.cardHolder,
    recipientInfo.name,
    recipientInfo.accountHolderName,
    recipientInfo.holder,
  ].filter(Boolean);

  return {
    toEmail: String(toEmail || "").trim(),
    iban: String(iban || "").trim(),
    phoneNumber: String(phoneNumber || "").trim(),
    names,
  };
}

function getUserId(user = {}) {
  return String(user._id || user.id || user.userId || "").trim();
}

function getEligibilitySnapshot(req) {
  const txEligibility = req.transactionEligibility || {};

  if (txEligibility.user && typeof txEligibility.user === "object") {
    return txEligibility.user;
  }

  return txEligibility && typeof txEligibility === "object"
    ? txEligibility
    : {};
}

function buildEffectiveAmlUser(req) {
  const baseUser =
    req.verifiedUserProfile && typeof req.verifiedUserProfile === "object"
      ? req.verifiedUserProfile
      : req.user && typeof req.user === "object"
      ? req.user
      : {};

  const snapshot = getEligibilitySnapshot(req);

  const emailVerified =
    snapshot.emailVerified === true ||
    baseUser.emailVerified === true ||
    baseUser.isEmailVerified === true ||
    isEmailVerified(baseUser);

  const phoneVerified =
    snapshot.phoneVerified === true ||
    baseUser.phoneVerified === true ||
    baseUser.isPhoneVerified === true ||
    isPhoneVerified(baseUser);

  const businessUser =
    snapshot.isBusiness === true ||
    baseUser.isBusiness === true ||
    isBusinessUser(baseUser);

  const kycVerified =
    snapshot.kycVerified === true ||
    baseUser.kycVerified === true ||
    baseUser.isKycVerified === true ||
    isKycValid(baseUser);

  const kybVerified =
    snapshot.kybVerified === true ||
    baseUser.kybVerified === true ||
    baseUser.isKybVerified === true ||
    isPositiveFlag(baseUser.kybStatus) ||
    isPositiveFlag(baseUser.businessStatus) ||
    Number(baseUser.businessKYBLevel || 0) >= 2;

  const userId = getUserId(baseUser);

  return {
    ...baseUser,
    _id: baseUser._id || userId,
    id: baseUser.id || userId,
    userId,
    emailVerified,
    isEmailVerified: emailVerified,
    phoneVerified,
    isPhoneVerified: phoneVerified,
    isBusiness: businessUser,
    kycVerified,
    isKycVerified: kycVerified,
    kybVerified,
    isKybVerified: kybVerified,
  };
}

/**
 * Âge du compte en jours, ou `null` si la date de création est absente.
 *
 * `null` et non `0` : « je ne sais pas » et « créé aujourd'hui » sont deux
 * choses différentes, et le score les traite différemment — le second est un
 * signal de risque, le premier une incertitude.
 */
function accountAgeInDays(user) {
  const created = user?.createdAt ? new Date(user.createdAt).getTime() : null;
  if (!created || Number.isNaN(created)) return null;

  return Math.max(0, Math.floor((Date.now() - created) / 86400000));
}

function findBlacklistHit({
  user,
  toEmail,
  iban,
  phoneNumber,
  destinationCountryISO,
  names,
}) {
  const userId = getUserId(user);
  const email = normalizeEmail(toEmail);
  const normIban = normalizeIban(iban);
  const phone = normalizePhone(phoneNumber);
  const country = String(destinationCountryISO || "").trim().toUpperCase();

  /**
   * Deux sources, réunies par un OU : le magasin dynamique (base + pub/sub) et
   * les ensembles statiques hérités. Jamais une intersection — une entrée
   * présente d'un seul côté doit bloquer, sinon la migration d'un système vers
   * l'autre ouvrirait une fenêtre pendant laquelle les deux se neutralisent.
   */
  const store = riskEngine.blacklist();
  const listed = (type, value, set, normalized) =>
    Boolean(value) && (store.has(type, value) || set.has(normalized));

  if (listed("userId", userId, BLACKLIST.userIds, userId)) {
    return { blocked: true, code: "BLACKLISTED_USER", field: "userId" };
  }

  if (listed("email", email, BLACKLIST.emails, email)) {
    return { blocked: true, code: "BLACKLISTED_EMAIL", field: "email" };
  }

  if (listed("iban", normIban, BLACKLIST.ibans, normIban)) {
    return { blocked: true, code: "BLACKLISTED_IBAN", field: "iban" };
  }

  if (listed("phone", phone, BLACKLIST.phones, phone)) {
    return { blocked: true, code: "BLACKLISTED_PHONE", field: "phone" };
  }

  if (listed("country", country, BLACKLIST.countries, country)) {
    return { blocked: true, code: "BLACKLISTED_COUNTRY", field: "country" };
  }

  for (const name of names || []) {
    const normalizedName = normalizeName(name);

    if (listed("name", normalizedName, BLACKLIST.names, normalizedName)) {
      return { blocked: true, code: "BLACKLISTED_NAME", field: "name" };
    }
  }

  const senderEmail = normalizeEmail(user?.email);
  const senderPhone = normalizePhone(user?.phone || user?.phoneNumber);

  if (listed("email", senderEmail, BLACKLIST.emails, senderEmail)) {
    return {
      blocked: true,
      code: "BLACKLISTED_SENDER_EMAIL",
      field: "senderEmail",
    };
  }

  if (listed("phone", senderPhone, BLACKLIST.phones, senderPhone)) {
    return {
      blocked: true,
      code: "BLACKLISTED_SENDER_PHONE",
      field: "senderPhone",
    };
  }

  return { blocked: false, code: "", field: "" };
}

async function safeSendFraudAlert(payload) {
  try {
    await sendFraudAlert(payload);
  } catch (err) {
    logger.warn("[AML] sendFraudAlert ignoré", {
      error: err?.message || String(err),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Criblage sanctions / PEP / listes de surveillance                          */
/* -------------------------------------------------------------------------- */

const {
  screenTransactionCounterparties,
} = require("../services/risk/sanctionsScreening");

/**
 * ============================================================================
 * LE CRIBLAGE VIT ICI, PAS AU BORD — ET IL ÉCHOUE EN FERMETURE
 * ============================================================================
 *
 * ── D'où il vient ───────────────────────────────────────────────────────────
 *
 * Ce contrôle a vécu jusqu'au 2026-09-10 dans `middlewares/aml.js` de la
 * passerelle, qui en était le SEUL porteur : Tx-Core n'avait aucun criblage.
 * Il existait donc deux AML — 1 530 lignes au bord, 1 533 ici, 1 234 lignes de
 * divergence — que chaque virement traversait tous les deux, et un seul des
 * deux criblait.
 *
 * Un contrôle de conformité au bord protège ce qui passe par le bord. Ici, il
 * est adjacent au grand livre : aucun chemin ne déplace d'argent sans l'avoir
 * traversé (invariant A12).
 *
 * ── Pourquoi cette enveloppe existe ─────────────────────────────────────────
 *
 * `screenTransactionCounterparties` gère lui-même l'indisponibilité de son
 * fournisseur, en honorant `SANCTIONS_SCREENING_FAIL_CLOSED`. Ce qu'il ne gère
 * pas, c'est SA PROPRE exception — un défaut de code, une réponse inattendue,
 * un `undefined` déréférencé.
 *
 * La version du bord répondait à ce cas par `blocked: false, reviewRequired:
 * true` : autrement dit, une panne du criblage laissait passer l'opération.
 * C'est un repli silencieux sur le chemin de l'argent (règles B.1 et B.2). Ici
 * la posture d'exception suit la MÊME variable que la posture d'indisponibilité :
 * si l'exploitant a demandé la fermeture, une exception ferme.
 */
function screeningFailClosed() {
  const brut = process.env.SANCTIONS_SCREENING_FAIL_CLOSED;

  /**
   * Défaut `false` — identique à celui du service lui-même. Le relever ici
   * ferait diverger deux réponses à la même question, ce qui est précisément
   * le défaut qu'on referme. La conséquence d'un défaut à `false` est annoncée
   * au démarrage par `server.js`.
   */
  if (brut === undefined || String(brut).trim() === "") return false;

  return ["1", "true", "yes", "on"].includes(String(brut).trim().toLowerCase());
}

async function runSanctionsScreening({
  user,
  body,
  provider,
  amount,
  currencyCode,
  toEmail,
  iban,
  phoneNumber,
  destinationCountryISO,
  names,
}) {
  try {
    return await screenTransactionCounterparties({
      user,
      body,
      provider,
      amount,
      currencyCode,
      toEmail,
      iban,
      phoneNumber,
      destinationCountryISO,
      names,
    });
  } catch (err) {
    const ferme = screeningFailClosed();

    logger.error("[AML] Criblage sanctions — exception", {
      provider,
      userId: getUserId(user),
      failClosed: ferme,
      error: err?.message || String(err),
    });

    return {
      enabled: false,
      checked: false,
      blocked: ferme,
      reviewRequired: true,
      reason: "SANCTIONS_SCREENING_EXCEPTION",
      hits: [],
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Middleware AML                                                             */
/* -------------------------------------------------------------------------- */

module.exports = async function amlMiddleware(req, res, next) {
  const provider = resolveProvider(req);
  let user = buildEffectiveAmlUser(req);
  const body = req.body || {};

  const { toEmail, iban, phoneNumber, names } = resolveTargetIdentifiers(body);
  const destinationCountryISO = resolveDestinationCountryISO(req);

  const amount = parseAmount(
    body.amountSource ?? body.amount ?? body.money?.source?.amount
  );

  const currencyCode = resolveCurrencyCode(req);
  const currencySymbol = getCurrencySymbolByCode(currencyCode);
  const userId = getUserId(user);

  try {
    if (!user || !userId) {
      logger.warn("[AML] User manquant", { provider });

      await logTransaction({
        userId: null,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "User manquant",
        ip: req.ip,
      });

      return res.status(401).json({
        success: false,
        error: "Merci de vous connecter pour poursuivre.",
        code: "AUTH_REQUIRED",
      });
    }

    req.user = user;

    /**
     * Important :
     * La vérification email/téléphone/KYC/KYB est déjà faite dans
     * requireTransactionEligibility juste avant AML.
     *
     * Ici on garde seulement un fallback de sécurité si AML est utilisé seul
     * sur une route sans req.transactionEligibility.ok.
     */
    const alreadyEligibilityChecked = req.transactionEligibility?.ok === true;

    if (!alreadyEligibilityChecked) {
      if (!isEmailVerified(user)) {
        await logTransaction({
          userId,
          type: "initiate",
          provider,
          amount,
          currency: currencyCode,
          toEmail,
          details: maskSensitive(body),
          flagged: true,
          flagReason: "Email non vérifié",
          ip: req.ip,
        });

        return res.status(428).json({
          success: false,
          error:
            "Veuillez vérifier votre adresse email avant d’effectuer une transaction.",
          code: "EMAIL_NOT_VERIFIED",
        });
      }

      if (!isPhoneVerified(user)) {
        await logTransaction({
          userId,
          type: "initiate",
          provider,
          amount,
          currency: currencyCode,
          toEmail,
          details: maskSensitive(body),
          flagged: true,
          flagReason: "Téléphone non vérifié",
          ip: req.ip,
        });

        return res.status(428).json({
          success: false,
          error:
            "Veuillez vérifier votre numéro de téléphone avant d’effectuer une transaction.",
          code: "PHONE_NOT_VERIFIED",
        });
      }

      if (isBusinessUser(user)) {
        const kybValid = await isKybValid(user);

        if (!kybValid) {
          logger.warn("[AML] KYB insuffisant", {
            provider,
            user: user.email,
            kybStatus: user.kybStatus,
            businessStatus: user.businessStatus,
          });

          await logTransaction({
            userId,
            type: "initiate",
            provider,
            amount,
            currency: currencyCode,
            toEmail,
            details: maskSensitive(body),
            flagged: true,
            flagReason: "KYB insuffisant",
            ip: req.ip,
          });

          await safeSendFraudAlert({
            user,
            type: "kyb_insuffisant",
            provider,
          });

          return res.status(403).json({
            success: false,
            error:
              "L’accès aux transactions est temporairement restreint. Merci de compléter la vérification d’entreprise.",
            code: "KYB_REQUIRED",
          });
        }
      } else if (!isKycValid(user)) {
        logger.warn("[AML] KYC insuffisant", {
          provider,
          user: user.email,
          kycStatus: user.kycStatus,
          kycLevel: user.kycLevel,
        });

        await logTransaction({
          userId,
          type: "initiate",
          provider,
          amount,
          currency: currencyCode,
          toEmail,
          details: maskSensitive(body),
          flagged: true,
          flagReason: "KYC insuffisant",
          ip: req.ip,
        });

        await safeSendFraudAlert({
          user,
          type: "kyc_insuffisant",
          provider,
        });

        return res.status(403).json({
          success: false,
          error: "Votre vérification d’identité (KYC) n’est pas finalisée.",
          code: "KYC_REQUIRED",
        });
      }
    }

    const pepStatus = await getPEPOrSanctionedStatus(user, {
      toEmail,
      iban,
      phoneNumber,
    });

    if (pepStatus && pepStatus.sanctioned) {
      logger.error("[AML] PEP/Sanction detected", {
        user: user.email,
        reason: pepStatus.reason,
      });

      await logTransaction({
        userId,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: pepStatus.reason,
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "pep_sanction",
        provider,
        reason: pepStatus.reason,
      });

      return res.status(403).json({
        success: false,
        error:
          "Impossible d’effectuer la transaction : bénéficiaire sur liste de surveillance.",
        code: "PEP_SANCTIONED",
      });
    }

    /**
     * Le criblage se place APRÈS la porte PEP interne et AVANT la liste noire :
     * l'ordre du bord, conservé tel quel. Le déplacer changerait le code
     * d'erreur rendu à un utilisateur qui déclenche plusieurs portes à la fois
     * — ce que le back-office de conformité lit pour trier ses dossiers.
     */
    const sanctionsScreening = await runSanctionsScreening({
      user,
      body,
      provider,
      amount,
      currencyCode,
      toEmail,
      iban,
      phoneNumber,
      destinationCountryISO,
      names,
    });

    req.sanctionsScreening = sanctionsScreening;

    if (sanctionsScreening.blocked) {
      logger.warn("[AML] Criblage sanctions bloquant", {
        provider,
        userId,
        reason: sanctionsScreening.reason,
        maxScore: sanctionsScreening.maxScore,
      });

      await logTransaction({
        userId,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive({
          ...body,
          sanctionsScreening: {
            reason: sanctionsScreening.reason,
            maxScore: sanctionsScreening.maxScore,
            hits: sanctionsScreening.hits?.slice?.(0, 5) || [],
          },
        }),
        flagged: true,
        flagReason: `Sanctions screening: ${sanctionsScreening.reason}`,
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "sanctions_screening_blocked",
        provider,
        reason: sanctionsScreening.reason,
        hits: sanctionsScreening.hits?.slice?.(0, 3) || [],
      });

      return res.status(403).json({
        success: false,
        error:
          "Transaction bloquée pour vérification conformité. Veuillez contacter le support.",
        code: "SANCTIONS_SCREENING_BLOCKED",
      });
    }

    if (sanctionsScreening.reviewRequired) {
      logger.warn("[AML] Criblage sanctions — revue manuelle requise", {
        provider,
        userId,
        reason: sanctionsScreening.reason,
        maxScore: sanctionsScreening.maxScore,
      });

      await logTransaction({
        userId,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive({
          ...body,
          sanctionsScreening: {
            reason: sanctionsScreening.reason,
            maxScore: sanctionsScreening.maxScore,
            hits: sanctionsScreening.hits?.slice?.(0, 5) || [],
          },
        }),
        flagged: true,
        flagReason: `Revue conformité requise: ${sanctionsScreening.reason}`,
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "sanctions_screening_review",
        provider,
        reason: sanctionsScreening.reason,
        hits: sanctionsScreening.hits?.slice?.(0, 3) || [],
      });

      return res.status(428).json({
        success: false,
        error:
          "Transaction mise en attente pour revue conformité. Notre équipe vérifiera votre opération.",
        code: "COMPLIANCE_REVIEW_REQUIRED",
      });
    }

    const blacklistHit = findBlacklistHit({
      user,
      toEmail,
      iban,
      phoneNumber,
      destinationCountryISO,
      names,
    });

    if (blacklistHit.blocked) {
      logger.warn("[AML] Cible blacklistée", {
        provider,
        field: blacklistHit.field,
        code: blacklistHit.code,
      });

      await logTransaction({
        userId,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive({
          ...body,
          blacklistHit: {
            field: blacklistHit.field,
            code: blacklistHit.code,
          },
        }),
        flagged: true,
        flagReason: `Blacklist: ${blacklistHit.code}`,
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "blacklist",
        provider,
        field: blacklistHit.field,
        code: blacklistHit.code,
      });

      return res.status(403).json({
        success: false,
        error: "Transaction interdite : restriction conformité (AML).",
        code: blacklistHit.code || "BLACKLISTED",
      });
    }

    if (destinationCountryISO && RISKY_COUNTRIES_ISO.has(destinationCountryISO)) {
      logger.warn("[AML] Pays à risque détecté", {
        provider,
        user: user.email,
        destinationCountryISO,
        destinationCountryRaw: body.destinationCountry || body.country || null,
      });

      await logTransaction({
        userId,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Pays à risque",
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "pays_risque",
        provider,
        country: destinationCountryISO,
      });

      return res.status(403).json({
        success: false,
        error: "Transaction bloquée : pays de destination non autorisé.",
        code: "RISKY_COUNTRY",
        details: {
          country: destinationCountryISO,
        },
      });
    }

    const singleTxLimit = getSingleTxLimit(provider, currencyCode);

    if (amount > singleTxLimit) {
      logger.warn("[AML] Plafond single dépassé", {
        provider,
        user: user.email,
        amount,
        max: singleTxLimit,
      });

      await logTransaction({
        userId,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: `Plafond single dépassé (${amount} > ${singleTxLimit} ${currencyCode})`,
        ip: req.ip,
      });

      return res.status(403).json({
        success: false,
        error: `Plafond par transaction: ${singleTxLimit} ${currencySymbol}.`,
        code: "AML_SINGLE_LIMIT",
        details: {
          max: singleTxLimit,
          currencyCode,
          currencySymbol,
          provider,
        },
      });
    }

    const dailyLimit = getDailyLimit(provider, currencyCode);

    let stats = null;

    try {
      stats = await getUserTransactionsStats(userId, provider, currencyCode);
    } catch (err) {
      /**
       * ⚠️ REPLI OUVERT ASSUMÉ, ET DÉSORMAIS NOMMÉ.
       *
       * `stats` reste `null`, donc `dailyTotal` vaut 0 quelques lignes plus
       * bas, donc le plafond JOURNALIER ne s'applique plus — et les contrôles
       * de volume et de fractionnement sont sautés avec lui. Une panne
       * d'agrégation Mongo lève ainsi une frontière de conformité en silence.
       *
       * Le choix est un arbitrage de DISPONIBILITÉ : refuser tout paiement dès
       * le premier hoquet de la base est l'autre extrême. Il n'a jamais été
       * tranché explicitement — il est ici nommé, avec sa conséquence, pour
       * qu'il puisse l'être (règle B.6) plutôt que de rester la retombée
       * involontaire d'un `catch`.
       *
       * Le plafond PAR ENVOI, lui, s'applique toujours : il ne dépend d'aucune
       * lecture en base.
       */
      logger.warn(
        "[AML] Cumul journalier NON VÉRIFIÉ — statistiques indisponibles, " +
          "le plafond journalier et les contrôles de fractionnement sont SAUTÉS",
        {
          error: err?.message || String(err),
          provider,
          userId,
          dailyLimit,
        }
      );
    }

    const dailyTotal = Number.isFinite(Number(stats?.dailyTotal))
      ? Number(stats.dailyTotal)
      : 0;

    const futureTotal = dailyTotal + (amount || 0);

    if (futureTotal > dailyLimit) {
      logger.warn("[AML] Plafond journalier dépassé", {
        provider,
        user: user.email,
        dailyTotal,
        amount,
        dailyLimit,
      });

      await logTransaction({
        userId,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: `Plafond journalier dépassé (${dailyTotal} + ${amount} > ${dailyLimit} ${currencyCode})`,
        ip: req.ip,
      });

      return res.status(403).json({
        success: false,
        error: `Plafond journalier atteint (${dailyLimit} ${currencySymbol}). Réessayez demain.`,
        code: "AML_DAILY_LIMIT",
        details: {
          max: dailyLimit,
          currencyCode,
          currencySymbol,
          provider,
          dailyTotal,
        },
      });
    }

    const userQuestions = Array.isArray(user.securityQuestions)
      ? user.securityQuestions
      : [];

    const needAmlChallenge =
      typeof amount === "number" &&
      amount >= dailyLimit * 0.9 &&
      userQuestions.length > 0;

    if (needAmlChallenge) {
      const amlQ = body.amlSecurityQuestion;
      const amlA = body.amlSecurityAnswer;

      if (!amlQ || !amlA) {
        const qIdx = Math.floor(Math.random() * userQuestions.length);

        return res.status(428).json({
          success: false,
          error: "AML_SECURITY_CHALLENGE",
          code: "AML_SECURITY_CHALLENGE",
          need_security_answer: true,
          amlSecurityQuestion: userQuestions[qIdx].question,
        });
      }

      const idx = userQuestions.findIndex((q) => q.question === amlQ);

      if (idx === -1) {
        return res.status(403).json({
          success: false,
          error: "Question AML inconnue.",
          code: "AML_QUESTION_UNKNOWN",
        });
      }

      const ok =
        String(userQuestions[idx].answer || "").trim().toLowerCase() ===
        String(amlA || "").trim().toLowerCase();

      if (!ok) {
        logger.warn("[AML] Réponse AML incorrecte", {
          user: user.email,
        });

        await logTransaction({
          userId,
          type: "initiate",
          provider,
          amount,
          currency: currencyCode,
          toEmail,
          details: maskSensitive(body),
          flagged: true,
          flagReason: "AML Sécurité question échouée",
          ip: req.ip,
        });

        await safeSendFraudAlert({
          user,
          type: "aml_security_failed",
          provider,
        });

        return res.status(403).json({
          success: false,
          error: "Réponse AML incorrecte.",
          code: "AML_SECURITY_FAILED",
        });
      }
    }

    if (stats && Number(stats.lastHour || 0) > 10) {
      logger.warn("[AML] Volume suspect sur 1h", {
        provider,
        user: user.email,
        lastHour: stats.lastHour,
      });

      await logTransaction({
        userId,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Volume élevé 1h",
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "volume_1h",
        provider,
        count: stats.lastHour,
      });

      return res.status(403).json({
        success: false,
        error: "Trop de transactions sur 1h, vérification requise.",
        code: "AML_RATE_LIMIT_1H",
        details: {
          count: stats.lastHour,
        },
      });
    }

    if (stats && Number(stats.sameDestShortTime || 0) > 3) {
      logger.warn("[AML] Structuring suspect", {
        provider,
        user: user.email,
        count: stats.sameDestShortTime,
      });

      await logTransaction({
        userId,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Pattern structuring",
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "structuring",
        provider,
        count: stats.sameDestShortTime,
      });

      return res.status(403).json({
        success: false,
        error: "Activité inhabituelle détectée. Vérification requise.",
        code: "AML_STRUCTURING",
        details: {
          count: stats.sameDestShortTime,
        },
      });
    }

    /**
     * Cette règle visait le rail `stripe`, retiré du périmètre le 2026-09-08.
     * Elle est conservée en la RECIBLANT sur le rail carte : la contrainte de
     * devise vient du réseau, pas du prestataire, et elle survit donc au
     * changement de partenaire. La liste `ALLOWED_STRIPE_CURRENCY_CODES` garde
     * son nom pour l'instant — la renommer est une tâche de nommage, pas de
     * sécurité, et la mêler à ce correctif brouillerait la relecture.
     */
    if (
      ["visa_direct", "card"].includes(provider) &&
      currencyCode &&
      !ALLOWED_STRIPE_CURRENCY_CODES.includes(currencyCode)
    ) {
      logger.warn("[AML] Devise Stripe non autorisée", {
        user: user.email,
        currencyCode,
      });

      await logTransaction({
        userId,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Devise interdite Stripe",
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "devise_interdite",
        provider,
        currencyCode,
      });

      return res.status(403).json({
        success: false,
        error: "Devise non autorisée.",
        code: "STRIPE_CURRENCY_NOT_ALLOWED",
        details: {
          currencyCode,
          currencySymbol,
        },
      });
    }

    /* ========================================================================
     * SCORE DE RISQUE — DÉTERMINISTE, ET UNE ISSUE QUI N'EXISTAIT PAS
     * ========================================================================
     *
     * Ce bloc appelait `getMLScore`, qui renvoyait `Math.random() * 0.4`, et
     * bloquait en 403 au-delà de 0.9. Deux défauts imbriqués :
     *
     *   - le tirage plafonnait à 0.4 : la branche « aléatoire » ne bloquait
     *     JAMAIS. Le seul signal réel était « montant au-dessus de la limite »,
     *     qui renvoyait 0.92 en dur ;
     *   - il n'y avait que DEUX issues : passer, ou refuser sèchement. Un 403
     *     dit « non » à un client légitime sans recours, sans explication, et
     *     sans laisser de dossier qu'un opérateur puisse reprendre.
     *
     * Désormais trois bandes, et chaque point de score NOMME son motif :
     *
     *   allow  → on continue ;
     *   review → la transaction est CRÉÉE, en `pending_review`. C'est le
     *            handler qui applique l'état : ce middleware s'exécute avant
     *            que la transaction existe, il pose donc son verdict sur `req` ;
     *   block  → refus, réservé aux signaux DURS (liste noire, sanction).
     */
    const velocityCounters = await riskEngine
      .velocity()
      .read({ userId, destination: toEmail || phoneNumber || iban || null });

    const riskVerdict = riskEngine.computeRiskScore({
      amount,
      singleTxLimit: getSingleTxLimit(provider, currencyCode),
      velocity: velocityCounters,
      stats: stats || null,
      accountAgeDays: accountAgeInDays(user),
      isNewBeneficiary: false,
      kycLevel: user?.kycLevel,
      // Les signaux durs ont déjà rendu la main plus haut : s'ils sont encore
      // là, c'est qu'ils sont négatifs.
      sanctioned: false,
      blacklistHit: null,
    });

    const riskExplanation = riskEngine.explainRisk(riskVerdict);

    /**
     * Le verdict voyage sur `req` : le handler `/initiate` en a besoin pour
     * décider de l'état initial, et le dossier de revue pour être lisible.
     */
    req.riskVerdict = riskVerdict;

    if (riskVerdict.band === "block") {
      logger.warn("[AML] risque BLOQUANT", {
        user: user.email,
        score: riskVerdict.score,
        motifs: riskExplanation,
      });

      await logTransaction({
        userId,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: `Risque bloquant : ${riskExplanation}`,
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "risk_block",
        provider,
        score: riskVerdict.score,
      });

      return res.status(403).json({
        success: false,
        error:
          "Transaction bloquée pour vérification supplémentaire (sécurité renforcée).",
        code: "AML_RISK_BLOCK",
        details: { score: riskVerdict.score },
      });
    }

    if (riskVerdict.band === "review") {
      /**
       * ⚠️ ON NE REFUSE PAS. La transaction sera créée en `pending_review` par
       * le handler. Le client voit un virement « en cours de vérification »
       * plutôt qu'un refus sec, et un opérateur dispose d'un dossier motivé.
       *
       * Le journal AML est écrit ICI, marqué `flagged`, pour que la file de
       * revue existe même si la création échoue plus loin.
       */
      logger.warn("[AML] risque -> REVUE MANUELLE", {
        user: user.email,
        score: riskVerdict.score,
        motifs: riskExplanation,
      });

      await logTransaction({
        userId,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: `Revue manuelle : ${riskExplanation}`,
        ip: req.ip,
      });
    }

    /**
     * Enregistrement de la vélocité — APRÈS les contrôles, et sans attendre son
     * résultat : perdre un compteur dégrade un signal futur, faire échouer ce
     * virement-ci serait bien pire.
     */
    riskEngine
      .velocity()
      .record({
        userId,
        amount,
        destination: toEmail || phoneNumber || iban || null,
      })
      .catch(() => {});

    await logTransaction({
      userId,
      type: "initiate",
      provider,
      amount,
      currency: currencyCode,
      toEmail,
      details: maskSensitive(body),
      flagged: false,
      flagReason: "",
      ip: req.ip,
    });

    req.aml = {
      status: "passed",
      provider,
      amount,
      currency: currencyCode,
      destinationCountryISO,
      checkedAt: new Date().toISOString(),
      stats: stats || null,
      blacklistChecked: true,
    };

    logger.info("[AML] AML OK", {
      provider,
      user: user.email,
      amount,
      currencyCode,
      destinationCountryISO,
      toEmail,
      iban: iban ? "***" : "",
      phoneNumber: phoneNumber ? "***" : "",
      eligibilityAlreadyChecked: alreadyEligibilityChecked,
    });

    return next();
  } catch (e) {
    /**
     * Un plafond introuvable est un REFUS DE POLITIQUE, pas une panne.
     *
     * Sans cette branche le refus sortait en « AML_SYSTEM_ERROR / 500 », ce qui
     * est un mensonge de journal (règle B.6) : l'exploitation cherche une panne
     * qui n'existe pas, pendant que la vraie cause — un rail ou une devise hors
     * politique — reste invisible. Le blocage était correct ; c'est sa
     * DÉSIGNATION qui ne l'était pas.
     */
    if (e instanceof AmlLimitUnavailableError || String(e?.code || "").startsWith("AML_")) {
      logger.warn("[AML] Plafond indéterminable — transaction REFUSÉE", {
        provider,
        currency: currencyCode,
        code: e?.code,
      });

      try {
        await logTransaction({
          userId: getUserId(user) || null,
          type: "initiate",
          provider,
          amount,
          currency: currencyCode,
          toEmail,
          details: maskSensitive(body),
          flagged: true,
          flagReason: `Plafond indéterminable (${e?.code || "AML_LIMIT_UNAVAILABLE"})`,
          ip: req.ip,
        });
      } catch {}

      return res.status(403).json({
        success: false,
        error: "Ce moyen de paiement n'est pas disponible pour cette devise.",
        code: e?.code || "AML_LIMIT_UNAVAILABLE",
      });
    }

    logger.error("[AML] Exception", {
      err: e?.message || e,
      user: user?.email,
    });

    try {
      await logTransaction({
        userId: getUserId(user) || null,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive({
          ...body,
          error: e?.message,
        }),
        flagged: true,
        flagReason: "Erreur système AML",
        ip: req.ip,
      });
    } catch {}

    return res.status(500).json({
      success: false,
      error: "Erreur système AML",
      code: "AML_SYSTEM_ERROR",
    });
  }
};