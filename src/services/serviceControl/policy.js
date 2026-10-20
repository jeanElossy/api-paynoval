"use strict";

/**
 * ============================================================================
 * SERVICE CONTROL — RULE RESOLUTION (pure, no I/O)
 * ============================================================================
 *
 * Contract: docs/architecture/service-control.md (§3 to §9).
 *
 * ⚠️ THIS FILE EXISTS IN TWO REPOSITORIES, BYTE FOR BYTE:
 *
 *     paynoval-backend/services/serviceControl/policy.js
 *     api-paynoval/src/services/serviceControl/policy.js
 *
 * The backend writes the state and serves the app; Tx-Core enforces it on
 * every money operation. Both must reach the SAME decision for the same input,
 * or a feature switched off in the back office would stay open on one side.
 * Both repositories run the same vectors (`serviceControlPolicy` tests) and
 * check this file's fingerprint: change one copy, copy it to the other.
 *
 * What this module never does: touch money. It only answers "may this request
 * proceed, and if not, what does the user read?" (invariant: maintenance
 * blocks actions, it never modifies a balance, the ledger or a transaction).
 *
 * Reference behaviour: Stripe / PayPal / Wise status pages and degraded modes —
 * cut the smallest scope that removes the risk, keep reads open, say clearly
 * what is unavailable and until when, and never block what finishes or repairs
 * an operation already engaged.
 */

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                  */
/* -------------------------------------------------------------------------- */

const LEVELS = Object.freeze([
  "OPERATIONAL",
  "DEGRADED",
  "READ_ONLY",
  "MAINTENANCE",
  "EMERGENCY_LOCKDOWN",
]);

const LEVEL_RANK = Object.freeze(
  LEVELS.reduce((acc, level, index) => ({ ...acc, [level]: index }), {})
);

const SCOPE_TYPES = Object.freeze(["global", "platform", "feature", "provider", "country", "currency"]);

/** Higher = more specific: on equal level, the most specific rule speaks. */
const SCOPE_SPECIFICITY = Object.freeze({
  global: 1,
  platform: 2,
  currency: 3,
  country: 4,
  provider: 5,
  feature: 6,
});

const PLATFORMS = Object.freeze(["ios", "android", "web"]);

/**
 * `category: "money"` = a new operation moves money (refused in LOCKDOWN and,
 * when the state is unreadable, refused too). `flow` documents the direction.
 * `component` = public status page component (null = not public).
 */
const FEATURES = Object.freeze([
  { key: "auth.signup", category: "account", flow: "none", component: "account" },
  { key: "auth.login", category: "account", flow: "none", component: "account" },
  { key: "kyc.submit", category: "account", flow: "none", component: "account" },
  { key: "cards.add", category: "account", flow: "none", component: "cards", lockdown: true },
  { key: "money.deposit", category: "money", flow: "inflow", component: "deposits" },
  { key: "money.withdraw", category: "money", flow: "outflow", component: "withdrawals" },
  { key: "money.transfer.internal", category: "money", flow: "internal", component: "transfers" },
  { key: "money.transfer.mobilemoney", category: "money", flow: "outflow", component: "transfers" },
  { key: "money.transfer.card", category: "money", flow: "outflow", component: "transfers" },
  { key: "cagnotte.create", category: "account", flow: "none", component: "cagnottes" },
  { key: "cagnotte.participate", category: "money", flow: "internal", component: "cagnottes" },
  { key: "cagnotte.vault_withdraw", category: "money", flow: "internal", component: "cagnottes" },
  { key: "cagnotte.recurring", category: "money", flow: "internal", component: "cagnottes" },
  { key: "cagnotte.close", category: "money", flow: "internal", component: "cagnottes" },
  { key: "referral.payout", category: "money", flow: "internal", component: null },
]);

const FEATURE_INDEX = Object.freeze(
  FEATURES.reduce((acc, f) => ({ ...acc, [f.key]: Object.freeze({ ...f }) }), {})
);

/** Every strict prefix of a feature key is a group key (`money`, `money.transfer`…). */
const FEATURE_GROUPS = Object.freeze(
  Array.from(
    new Set(
      FEATURES.flatMap((f) => {
        const parts = f.key.split(".");
        const out = [];
        for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join("."));
        return out;
      })
    )
  ).sort()
);

const PROVIDERS = Object.freeze(["wave", "orange", "mtn", "moov", "card"]);

/** V1 account countries + mobile money destinations (Tx-Core COUNTRY_RULES). */
const COUNTRIES = Object.freeze(["CA", "US", "CI", "FR", "GB", "BE", "DE", "ES", "ML", "BF"]);

const CURRENCIES = Object.freeze(["XOF", "EUR", "CAD", "USD", "GBP"]);

const PHASES = Object.freeze(["read", "initiate", "confirm", "restore"]);

const STAFF_ROLES = Object.freeze([
  "support",
  "compliance",
  "admin",
  "superadmin",
  "security",
  "fraud-analyst",
]);

const CODES = Object.freeze({
  MAINTENANCE_ACTIVE: "MAINTENANCE_ACTIVE",
  FEATURE_UNAVAILABLE: "FEATURE_UNAVAILABLE",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  READ_ONLY_MODE: "READ_ONLY_MODE",
  SERVICE_LOCKDOWN: "SERVICE_LOCKDOWN",
  SERVICE_STATUS_UNAVAILABLE: "SERVICE_STATUS_UNAVAILABLE",
  UPDATE_REQUIRED: "UPDATE_REQUIRED",
});

const SERVICE_CONTROL_HEADER = "X-PayNoval-Service-Control";

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

function isLevel(level) {
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, level);
}

function rankOf(level) {
  return isLevel(level) ? LEVEL_RANK[level] : 0;
}

function maxLevel(a, b) {
  return rankOf(b) > rankOf(a) ? b : a;
}

function isValidScope(scopeType, scopeKey) {
  switch (scopeType) {
    case "global":
      return scopeKey === "all";
    case "platform":
      return PLATFORMS.includes(scopeKey);
    case "feature":
      return Boolean(FEATURE_INDEX[scopeKey]) || FEATURE_GROUPS.includes(scopeKey);
    case "provider":
      return PROVIDERS.includes(scopeKey);
    case "country":
      return COUNTRIES.includes(scopeKey);
    case "currency":
      return CURRENCIES.includes(scopeKey);
    default:
      return false;
  }
}

/** LOCKDOWN is global only: an emergency is not scoped (contract §3). */
function isAllowedLevelForScope(scopeType, level) {
  if (!isLevel(level)) return false;
  if (level === "EMERGENCY_LOCKDOWN") return scopeType === "global";
  return true;
}

/** A rule on `money` applies to `money.transfer.card`; on `money.transfer`, too. */
function featureMatches(ruleKey, featureKey) {
  return ruleKey === featureKey || String(featureKey).startsWith(`${ruleKey}.`);
}

/** Features covered by a feature/group key. */
function featuresUnder(scopeKey) {
  return FEATURES.filter((f) => featureMatches(scopeKey, f.key)).map((f) => f.key);
}

function toTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A planned window is active iff `startsAt <= now < endsAt` and not cancelled.
 * Computed at every read: no cron has to "switch it on", so a process that
 * was asleep at the start time still applies it on its first request.
 */
function isWindowActive(window, now) {
  if (!window || window.cancelledAt) return false;
  const start = toTime(window.startsAt);
  const end = toTime(window.endsAt);
  if (start === null || end === null) return false;
  return start <= now && now < end;
}

/**
 * Flattens the snapshot into effective rules: manual states that are not
 * OPERATIONAL, plus every scope of every active window.
 *
 * @param {{ states?: object[], windows?: object[] }} snapshot
 * @param {number} now epoch ms
 */
function collectRules(snapshot, now) {
  const rules = [];

  for (const s of (snapshot && snapshot.states) || []) {
    if (!s || !isLevel(s.level) || s.level === "OPERATIONAL") continue;
    if (!isValidScope(s.scopeType, s.scopeKey)) continue;
    if (!isAllowedLevelForScope(s.scopeType, s.level)) continue;

    rules.push({
      scopeType: s.scopeType,
      scopeKey: s.scopeKey,
      level: s.level,
      userMessage: s.userMessage || null,
      estimatedEndAt: s.estimatedEndAt || null,
      source: "manual",
      id: s.id ? String(s.id) : `${s.scopeType}:${s.scopeKey}`,
    });
  }

  for (const w of (snapshot && snapshot.windows) || []) {
    if (!isWindowActive(w, now)) continue;
    if (!isLevel(w.level) || w.level === "OPERATIONAL" || w.level === "EMERGENCY_LOCKDOWN") continue;

    for (const scope of w.scopes || []) {
      if (!scope || !isValidScope(scope.scopeType, scope.scopeKey)) continue;

      rules.push({
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        level: w.level,
        userMessage: w.userMessage || null,
        estimatedEndAt: w.endsAt || null,
        source: "window",
        id: w.id ? String(w.id) : null,
      });
    }
  }

  return rules;
}

/** Only the emergency lockdown survives an unreadable state (contract §7). */
function stickyRules(rules) {
  return (rules || []).filter((r) => r.level === "EMERGENCY_LOCKDOWN");
}

/**
 * @typedef {object} RequestContext
 * @property {string}   [platform]   ios | android | web
 * @property {string[]} [features]   catalogue keys concerned by the request
 * @property {string[]} [providers]
 * @property {string[]} [countries]
 * @property {string[]} [currencies]
 * @property {boolean}  [isStaff]
 */

function ruleApplies(rule, ctx) {
  const c = ctx || {};
  switch (rule.scopeType) {
    case "global":
      return true;
    case "platform":
      return Boolean(c.platform) && c.platform === rule.scopeKey;
    case "feature":
      return (c.features || []).some((f) => featureMatches(rule.scopeKey, f));
    case "provider":
      return (c.providers || []).includes(rule.scopeKey);
    case "country":
      return (c.countries || []).includes(rule.scopeKey);
    case "currency":
      return (c.currencies || []).includes(rule.scopeKey);
    default:
      return false;
  }
}

/**
 * The most restrictive applicable rule wins; on equal level, the most specific
 * scope provides the message. `rule` is null when everything is operational.
 */
function resolve(rules, ctx) {
  let winner = null;

  for (const rule of rules || []) {
    if (!ruleApplies(rule, ctx)) continue;

    if (
      !winner ||
      rankOf(rule.level) > rankOf(winner.level) ||
      (rankOf(rule.level) === rankOf(winner.level) &&
        SCOPE_SPECIFICITY[rule.scopeType] > SCOPE_SPECIFICITY[winner.scopeType])
    ) {
      winner = rule;
    }
  }

  return { level: winner ? winner.level : "OPERATIONAL", rule: winner };
}

/* -------------------------------------------------------------------------- */
/* Decision                                                                   */
/* -------------------------------------------------------------------------- */

function touchesMoney(features) {
  return (features || []).some((f) => FEATURE_INDEX[f] && FEATURE_INDEX[f].category === "money");
}

function lockdownSensitive(features) {
  return (features || []).some(
    (f) => FEATURE_INDEX[f] && (FEATURE_INDEX[f].category === "money" || FEATURE_INDEX[f].lockdown === true)
  );
}

function isBypassActive(bypass, now) {
  if (!bypass || bypass.revokedAt) return false;
  const exp = toTime(bypass.expiresAt);
  return exp !== null && exp > now;
}

function maintenanceCode(rule) {
  if (!rule) return CODES.MAINTENANCE_ACTIVE;
  if (rule.scopeType === "global" || rule.scopeType === "platform") return CODES.MAINTENANCE_ACTIVE;
  if (rule.scopeType === "provider") return CODES.PROVIDER_UNAVAILABLE;
  return CODES.FEATURE_UNAVAILABLE;
}

function allow(resolution, extra = {}) {
  return { allowed: true, code: null, level: resolution.level, rule: resolution.rule, ...extra };
}

function refuse(resolution, code) {
  return { allowed: false, code, level: resolution.level, rule: resolution.rule, httpStatus: 503 };
}

/**
 * The decision table of contract §5.
 *
 * @param {object} input
 * @param {object[]} input.rules          from `collectRules` (or `stickyRules`)
 * @param {RequestContext} input.ctx
 * @param {"read"|"initiate"|"confirm"|"restore"} input.phase
 * @param {object|null} [input.bypass]    `{ expiresAt, revokedAt, allowLockdown }`
 * @param {"fresh"|"stale"|"unavailable"} [input.controlStatus]
 * @param {number} input.now
 */
function decide({ rules, ctx, phase, bypass = null, controlStatus = "fresh", now }) {
  const context = ctx || {};
  const resolution = resolve(rules, context);

  // What finishes or repairs an operation is never blocked.
  if (phase === "restore") return allow(resolution);

  const money = touchesMoney(context.features);

  // `auth.login` never applies to staff; nor does any non-money control: the
  // console must stay usable to lift the very incident being handled.
  if (context.isStaff === true && !money && resolution.level !== "EMERGENCY_LOCKDOWN") {
    return allow(resolution, { staffExempt: resolution.level !== "OPERATIONAL" });
  }

  if (resolution.level === "EMERGENCY_LOCKDOWN") {
    const blocks = (phase === "initiate" || phase === "confirm") && lockdownSensitive(context.features);
    if (!blocks) return allow(resolution);
    if (isBypassActive(bypass, now) && bypass.allowLockdown === true) {
      return allow(resolution, { bypassed: true });
    }
    return refuse(resolution, CODES.SERVICE_LOCKDOWN);
  }

  // State unreadable beyond the grace period: money closes, the rest stays open.
  if (controlStatus === "unavailable" && money && (phase === "initiate" || phase === "confirm")) {
    return refuse({ level: "MAINTENANCE", rule: null }, CODES.SERVICE_STATUS_UNAVAILABLE);
  }

  if (resolution.level === "OPERATIONAL" || resolution.level === "DEGRADED") return allow(resolution);

  if (isBypassActive(bypass, now)) return allow(resolution, { bypassed: true });

  if (resolution.level === "READ_ONLY") {
    return phase === "initiate" ? refuse(resolution, CODES.READ_ONLY_MODE) : allow(resolution);
  }

  // MAINTENANCE
  const broad = resolution.rule && (resolution.rule.scopeType === "global" || resolution.rule.scopeType === "platform");

  if (phase === "initiate" || phase === "confirm" || (phase === "read" && broad)) {
    return refuse(resolution, maintenanceCode(resolution.rule));
  }

  return allow(resolution);
}

/* -------------------------------------------------------------------------- */
/* User-facing refusal                                                        */
/* -------------------------------------------------------------------------- */

const DEFAULT_MESSAGES = Object.freeze({
  fr: Object.freeze({
    MAINTENANCE_ACTIVE:
      "PayNoval est en maintenance. Vos fonds sont en sécurité. Merci de réessayer un peu plus tard.",
    FEATURE_UNAVAILABLE:
      "Ce service est temporairement indisponible. Vos fonds sont en sécurité.",
    PROVIDER_UNAVAILABLE:
      "Ce moyen de paiement est temporairement indisponible. Vous pouvez en choisir un autre.",
    READ_ONLY_MODE:
      "Les nouvelles opérations sont momentanément suspendues. Votre solde et votre historique restent consultables.",
    SERVICE_LOCKDOWN:
      "Par mesure de sécurité, les opérations sont temporairement suspendues. Nous vous tiendrons informés.",
    SERVICE_STATUS_UNAVAILABLE:
      "Ce service est momentanément indisponible. Vos fonds sont en sécurité. Réessayez dans quelques minutes.",
    UPDATE_REQUIRED:
      "Une mise à jour de PayNoval est nécessaire pour continuer.",
  }),
  en: Object.freeze({
    MAINTENANCE_ACTIVE:
      "PayNoval is undergoing maintenance. Your funds are safe. Please try again a little later.",
    FEATURE_UNAVAILABLE: "This service is temporarily unavailable. Your funds are safe.",
    PROVIDER_UNAVAILABLE:
      "This payment method is temporarily unavailable. You can choose another one.",
    READ_ONLY_MODE:
      "New operations are temporarily paused. Your balance and history remain available.",
    SERVICE_LOCKDOWN:
      "As a security measure, operations are temporarily paused. We will keep you informed.",
    SERVICE_STATUS_UNAVAILABLE:
      "This service is temporarily unavailable. Your funds are safe. Please try again in a few minutes.",
    UPDATE_REQUIRED: "An update of PayNoval is required to continue.",
  }),
});

function normalizeLocale(locale) {
  const l = String(locale || "").trim().toLowerCase().slice(0, 2);
  return l === "en" ? "en" : "fr";
}

/** Picks a locale from an Accept-Language header or an explicit value. */
function pickLocale(explicit, acceptLanguage) {
  if (explicit) return normalizeLocale(explicit);
  const first = String(acceptLanguage || "").split(",")[0];
  return normalizeLocale(first);
}

function messageFor(code, rule, locale) {
  const l = normalizeLocale(locale);
  const custom = rule && rule.userMessage ? rule.userMessage[l] || rule.userMessage.fr || "" : "";
  const text = String(custom || "").trim();
  return text || DEFAULT_MESSAGES[l][code] || DEFAULT_MESSAGES[l].FEATURE_UNAVAILABLE;
}

/** Seconds until the announced end, bounded; null when no end is known. */
function retryAfterSec(estimatedEndAt, now) {
  const end = toTime(estimatedEndAt);
  if (end === null || end <= now) return null;
  return Math.min(86400, Math.max(30, Math.ceil((end - now) / 1000)));
}

/**
 * The HTTP refusal of contract §5: status, headers and body. No internal
 * reason, admin name or infrastructure detail can reach this object — the rule
 * carries only public fields by construction (`collectRules`).
 */
function buildRefusal({ decision, locale, now, requestId = null }) {
  const rule = decision.rule || null;
  const estimatedEndAt = rule && rule.estimatedEndAt ? new Date(toTime(rule.estimatedEndAt)).toISOString() : null;
  const retry = retryAfterSec(estimatedEndAt, now);
  const message = messageFor(decision.code, rule, locale);

  const headers = {
    [SERVICE_CONTROL_HEADER]: decision.code,
    "Cache-Control": "no-store",
  };
  if (retry) headers["Retry-After"] = String(retry);

  const publicScope = rule && rule.scopeType !== "global" ? rule.scopeType : rule ? "global" : null;
  const publicKey = rule && rule.scopeType !== "global" ? rule.scopeKey : null;

  return {
    status: decision.httpStatus || 503,
    headers,
    body: {
      success: false,
      code: decision.code,
      message,
      error: message,
      serviceControl: {
        level: decision.level,
        scope: publicScope,
        key: publicKey,
        estimatedEndAt,
        retryAfterSec: retry,
      },
      requestId: requestId || null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* App version policy                                                         */
/* -------------------------------------------------------------------------- */

/** "1.4.2", "v1.4", "1.4.2-beta" → [1, 4, 2]; anything else → null. */
function parseVersion(raw) {
  const m = String(raw || "").trim().match(/^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:[-+].*)?$/);
  if (!m) return null;
  return [m[1], m[2], m[3], m[4]].map((p) => (p === undefined ? 0 : Number(p)));
}

function compareVersions(a, b) {
  for (let i = 0; i < 4; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function sameVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  return Boolean(pa && pb) && compareVersions(pa, pb) === 0;
}

/**
 * Decision of contract §9. An UNKNOWN version (absent or unreadable header) is
 * never blocked: locking someone out of their money because a header could not
 * be read is the worst possible outcome; letting an old version through one
 * more session is recoverable.
 *
 * @param {object|null} policy  `{ minimumVersion, recommendedVersion, blockedVersions, blockedUpdateIds, storeUrl, message }`
 * @param {{ version?: string, updateId?: string }} client
 */
function resolveVersionGate(policy, client = {}) {
  const base = {
    updateRequired: false,
    updateAvailable: false,
    reason: null,
    minimumVersion: (policy && policy.minimumVersion) || null,
    recommendedVersion: (policy && policy.recommendedVersion) || null,
    storeUrl: (policy && policy.storeUrl) || null,
    message: (policy && policy.message) || null,
  };

  if (!policy) return base;

  const version = parseVersion(client.version);
  const updateId = String(client.updateId || "").trim().toLowerCase();

  if (updateId && updateId !== "embedded") {
    const blockedUpdates = (policy.blockedUpdateIds || []).map((u) => String(u).trim().toLowerCase());
    if (blockedUpdates.includes(updateId)) {
      return { ...base, updateRequired: true, updateAvailable: true, reason: "UPDATE_BLOCKED" };
    }
  }

  if (!version) return base;

  if ((policy.blockedVersions || []).some((v) => sameVersion(v, client.version))) {
    return { ...base, updateRequired: true, updateAvailable: true, reason: "VERSION_BLOCKED" };
  }

  const minimum = parseVersion(policy.minimumVersion);
  if (minimum && compareVersions(version, minimum) < 0) {
    return { ...base, updateRequired: true, updateAvailable: true, reason: "BELOW_MINIMUM" };
  }

  const recommended = parseVersion(policy.recommendedVersion);
  if (recommended && compareVersions(version, recommended) < 0) {
    return { ...base, updateAvailable: true, reason: "BELOW_RECOMMENDED" };
  }

  return base;
}

function buildUpdateRefusal({ gate, locale, requestId = null }) {
  const l = normalizeLocale(locale);
  const custom = gate.message ? String(gate.message[l] || gate.message.fr || "").trim() : "";
  const message = custom || DEFAULT_MESSAGES[l].UPDATE_REQUIRED;

  return {
    status: 426,
    headers: { [SERVICE_CONTROL_HEADER]: CODES.UPDATE_REQUIRED, "Cache-Control": "no-store" },
    body: {
      success: false,
      code: CODES.UPDATE_REQUIRED,
      message,
      error: message,
      update: {
        minimumVersion: gate.minimumVersion || null,
        storeUrl: gate.storeUrl || null,
        reason: gate.reason,
      },
      requestId: requestId || null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Feature mapping helpers (shared by the backend gate and Tx-Core)            */
/* -------------------------------------------------------------------------- */

const OPERATOR_ALIASES = Object.freeze({
  wave: "wave",
  orange: "orange",
  "orange-money": "orange",
  orange_money: "orange",
  orangemoney: "orange",
  om: "orange",
  mtn: "mtn",
  "mtn-momo": "mtn",
  mtn_momo: "mtn",
  momo: "mtn",
  moov: "moov",
  "moov-money": "moov",
  moov_money: "moov",
  flooz: "moov",
  card: "card",
  visa: "card",
  visa_direct: "card",
  mastercard: "card",
});

/** Operator / provider name → catalogue provider key, or null. */
function normalizeProvider(raw) {
  const key = String(raw || "").trim().toLowerCase();
  return OPERATOR_ALIASES[key] || null;
}

function normalizePlatform(raw) {
  const p = String(raw || "").trim().toLowerCase();
  return PLATFORMS.includes(p) ? p : null;
}

function normalizeCountry(raw) {
  const c = String(raw || "").trim().toUpperCase();
  return COUNTRIES.includes(c) ? c : null;
}

function normalizeCurrency(raw) {
  const c = String(raw || "").trim().toUpperCase();
  return CURRENCIES.includes(c) ? c : null;
}

/**
 * Money operation (Tx-Core vocabulary) → catalogue features.
 *
 * An outbound operation whose type is unknown is evaluated against BOTH
 * withdraw and transfer: never under-controlled (the limit engine applies the
 * same rule to un-typed history).
 *
 * @param {{ funds?: string, destination?: string, txType?: string }} op
 * @returns {string[]}
 */
function featuresForMoneyOperation({ funds, destination, txType } = {}) {
  const f = String(funds || "").trim().toLowerCase();
  const d = String(destination || "").trim().toLowerCase();
  const t = String(txType || "").trim().toUpperCase();

  if (f === "paynoval" && d === "paynoval") return ["money.transfer.internal"];

  const externalIn = f && f !== "paynoval" && d === "paynoval";
  if (externalIn) return ["money.deposit"];

  const outbound = f === "paynoval" && d && d !== "paynoval";
  if (outbound) {
    const rail = d === "card" || d === "visa_direct" ? "card" : "mobilemoney";
    if (t === "WITHDRAW") return ["money.withdraw"];
    if (t === "TRANSFER") return [`money.transfer.${rail}`];
    return ["money.withdraw", `money.transfer.${rail}`];
  }

  // Unreadable direction: evaluate every money feature (fail closed on control).
  return ["money.deposit", "money.withdraw", "money.transfer.internal", "money.transfer.mobilemoney", "money.transfer.card"];
}

/** Tx-Core flow (stored on a transaction) → catalogue features. */
function featuresForFlow(flow, operationType) {
  const t = String(operationType || "").trim().toUpperCase();
  switch (String(flow || "")) {
    case "PAYNOVAL_INTERNAL_TRANSFER":
      return ["money.transfer.internal"];
    case "MOBILEMONEY_COLLECTION_TO_PAYNOVAL":
    case "CARD_TOPUP_TO_PAYNOVAL":
      return ["money.deposit"];
    case "PAYNOVAL_TO_MOBILEMONEY_PAYOUT":
      return featuresForMoneyOperation({ funds: "paynoval", destination: "mobilemoney", txType: t });
    case "PAYNOVAL_TO_CARD_PAYOUT":
      return featuresForMoneyOperation({ funds: "paynoval", destination: "card", txType: t });
    default:
      return featuresForMoneyOperation({});
  }
}

module.exports = {
  LEVELS,
  LEVEL_RANK,
  SCOPE_TYPES,
  SCOPE_SPECIFICITY,
  PLATFORMS,
  FEATURES,
  FEATURE_INDEX,
  FEATURE_GROUPS,
  PROVIDERS,
  COUNTRIES,
  CURRENCIES,
  PHASES,
  STAFF_ROLES,
  CODES,
  SERVICE_CONTROL_HEADER,
  DEFAULT_MESSAGES,

  isLevel,
  rankOf,
  maxLevel,
  isValidScope,
  isAllowedLevelForScope,
  featureMatches,
  featuresUnder,
  isWindowActive,
  collectRules,
  stickyRules,
  ruleApplies,
  resolve,
  touchesMoney,
  isBypassActive,
  decide,

  normalizeLocale,
  pickLocale,
  messageFor,
  retryAfterSec,
  buildRefusal,

  parseVersion,
  compareVersions,
  resolveVersionGate,
  buildUpdateRefusal,

  normalizeProvider,
  normalizePlatform,
  normalizeCountry,
  normalizeCurrency,
  featuresForMoneyOperation,
  featuresForFlow,
};
