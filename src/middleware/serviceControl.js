"use strict";

/**
 * ============================================================================
 * SERVICE CONTROL — TX-CORE IS THE MONEY AUTHORITY
 * ============================================================================
 *
 * Contract: docs/architecture/service-control.md (§2, §5, §7, §8, §9).
 *
 * The backend gate protects the routes it serves; THIS guard protects every
 * money operation, wherever it comes from — the app through the gateway, the
 * backend in service-to-service calls (cagnottes, recurring contributions,
 * referral payouts), the guest checkout. Same policy file as the backend,
 * byte for byte (src/services/serviceControl/policy.js).
 *
 * Mounted PER ROUTE with a describer that tells what the request is
 * (features, providers, countries, currencies, account). A describer returning
 * `null` means "not controlled" — used for replays of an already accepted
 * operation.
 *
 * Never mounted on: provider webhooks, settlement, cancellation, refunds,
 * reconciliation, replay (what finishes or repairs is never blocked).
 *
 * ⚠️ FAIL CLOSED: an error of the guard itself refuses the money operation
 * (503 SERVICE_STATUS_UNAVAILABLE, retryable). A 503 is never frozen by the
 * idempotency registry: the same key replayed later runs exactly once.
 */

const policy = require("../services/serviceControl/policy");
const runtime = require("../services/serviceControl/runtime");

let logger = console;
try {
  logger = require("../utils/logger");
} catch {
  /* console fallback */
}

let countryHelpers = null;
function countryKeyOf(raw) {
  if (!countryHelpers) countryHelpers = require("../services/transactions/handlers/corridorValidation");
  return countryHelpers.getCountryKey(raw);
}

function headerOf(req, name) {
  const v = req.headers ? req.headers[name] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** Country name or code → catalogue ISO code, or null (via COUNTRY_RULES aliases). */
function toCountryIso(raw) {
  const direct = policy.normalizeCountry(raw);
  if (direct) return direct;
  const s = String(raw || "").trim();
  if (!s) return null;

  try {
    const { COUNTRY_RULES } = countryHelpers || require("../services/transactions/handlers/corridorValidation");
    const rule = COUNTRY_RULES[countryKeyOf(s)];
    if (!rule) return null;
    const alias = (rule.aliases || []).find((a) => a.length === 2 && a !== "uk");
    return policy.normalizeCountry(alias);
  } catch {
    return null;
  }
}

function uniq(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

function currencyOf(raw) {
  return policy.normalizeCurrency(raw);
}

/* -------------------------------------------------------------------------- */
/* Describers                                                                 */
/* -------------------------------------------------------------------------- */

/** POST /transactions/initiate (after normalizeProviderRails / normalizeInitiateBody). */
function describeInitiate(req) {
  const b = req.body || {};
  const funds = String(b.funds || "").toLowerCase();
  const destination = String(b.destination || "").toLowerCase();
  const txType = b.txType || b.transactionType || b.operationType || null;

  const providers = uniq([
    policy.normalizeProvider(b.metadata && b.metadata.provider),
    policy.normalizeProvider(b.operator),
    policy.normalizeProvider(b.provider),
    funds === "card" || destination === "card" ? "card" : null,
  ]);

  return {
    features: policy.featuresForMoneyOperation({ funds, destination, txType }),
    providers,
    countries: uniq([
      toCountryIso(b.destinationCountry),
      toCountryIso(b.toCountry),
      toCountryIso(b.fromCountry),
      toCountryIso(b.country),
      toCountryIso(req.user && (req.user.country || req.user.selectedCountry)),
    ]),
    currencies: uniq([
      currencyOf(b.senderCurrencyCode || b.currencySource),
      currencyOf(b.localCurrencyCode || b.currencyTarget),
    ]),
    userId: req.user && (req.user._id || req.user.id) ? String(req.user._id || req.user.id) : null,
    platform: policy.normalizePlatform(headerOf(req, "x-app-platform")),
    versionGate: true,
  };
}

/**
 * POST /transactions/confirm — the operation is the STORED transaction (its
 * flow, provider, currency), never the confirm body.
 */
async function describeConfirm(req) {
  const id = String((req.body && (req.body.transactionId || req.body.txId)) || "").trim();
  let tx = null;

  if (id) {
    try {
      const { lazyModels } = require("../services/transactions/shared/runtime");
      const { Transaction } = lazyModels(["Transaction"]);
      tx = await Transaction.findById(id)
        .select("flow operationType provider metadata.provider currencySource currencyTarget destinationCountry country")
        .lean();
    } catch {
      tx = null; // unknown id: evaluated against every money feature below
    }
  }

  return {
    features: tx ? policy.featuresForFlow(tx.flow, tx.operationType) : policy.featuresForMoneyOperation({}),
    providers: tx ? uniq([policy.normalizeProvider(tx.metadata && tx.metadata.provider), policy.normalizeProvider(tx.provider)]) : [],
    countries: tx ? uniq([toCountryIso(tx.destinationCountry), toCountryIso(tx.country)]) : [],
    currencies: tx ? uniq([currencyOf(tx.currencySource), currencyOf(tx.currencyTarget)]) : [],
    userId: req.user && (req.user._id || req.user.id) ? String(req.user._id || req.user.id) : null,
    platform: policy.normalizePlatform(headerOf(req, "x-app-platform")),
    versionGate: true,
  };
}

/** Internal / cagnotte routes: fixed feature, account from the body. */
function describeFixed(features, { userField = "userId", currencyField = null, providerField = null, platform = null, skipIf = null } = {}) {
  return (req) => {
    const b = req.body || {};
    if (skipIf && skipIf(b)) return null;
    return {
      features: [...features],
      providers: providerField ? uniq([policy.normalizeProvider(b[providerField]), policy.normalizeProvider(b.rail)]) : [],
      countries: uniq([toCountryIso(b.country)]),
      currencies: currencyField ? uniq([currencyOf(b[currencyField])]) : [],
      userId: b[userField] ? String(b[userField]) : null,
      platform,
      versionGate: false,
    };
  };
}

/** POST /internal-payments — by kind; admin adjustments are the remediation tool. */
const INTERNAL_PAYMENT_FEATURES = Object.freeze({
  bonus: ["referral.payout"],
  cashback: ["referral.payout"],
  purchase: ["money.transfer.internal"],
  cagnotte_participation: ["cagnotte.participate"],
  cagnotte_withdrawal: ["cagnotte.vault_withdraw"],
});

function describeInternalPayment(req) {
  const b = req.body || {};
  const features = INTERNAL_PAYMENT_FEATURES[String(b.kind || "").trim()];
  if (!features) return null; // adjustment_credit / adjustment_debit: staff remediation, never blocked
  return {
    features: [...features],
    providers: [],
    countries: [],
    currencies: uniq([currencyOf(b.currencySymbol || b.currency)]),
    userId: b.fromUserId ? String(b.fromUserId) : null,
    platform: null,
    versionGate: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Decision                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Pure given a view: `{ pass: true }` or `{ pass: false, refusal }`.
 * Exported for the tests.
 */
function evaluate({ described, phase, view, req, now }) {
  const snapshot = (view && view.snapshot) || {};
  const locale = policy.pickLocale(null, headerOf(req, "accept-language"));
  const requestId = req.id || headerOf(req, "x-request-id") || null;

  if (described.versionGate && (described.platform === "ios" || described.platform === "android")) {
    const gate = policy.resolveVersionGate((snapshot.versionPolicies || {})[described.platform] || null, {
      version: headerOf(req, "x-app-version"),
      updateId: headerOf(req, "x-app-update-id"),
    });
    if (gate.updateRequired) {
      return { pass: false, refusal: policy.buildUpdateRefusal({ gate, locale, requestId }) };
    }
  }

  const status = view ? view.status : "unavailable";
  const all = policy.collectRules(snapshot, now);
  const rules = status === "unavailable" ? policy.stickyRules(all) : all;

  const decision = policy.decide({
    rules,
    ctx: {
      platform: described.platform,
      features: described.features,
      providers: described.providers,
      countries: described.countries,
      currencies: described.currencies,
    },
    phase,
    bypass: described.userId ? (snapshot.bypassByUser || {})[described.userId] || null : null,
    controlStatus: status,
    now,
  });

  if (decision.allowed) return { pass: true, decision };
  return { pass: false, decision, refusal: policy.buildRefusal({ decision, locale, now, requestId }) };
}

function send(res, refusal) {
  for (const [name, value] of Object.entries(refusal.headers)) res.setHeader(name, value);
  return res.status(refusal.status).json(refusal.body);
}

/**
 * @param {object} options
 * @param {"read"|"initiate"|"confirm"} options.phase
 * @param {(req) => object|null|Promise<object|null>} options.describe
 * @param {string} options.label  route label for the logs
 * @param {object} [options.store]
 */
function serviceControlGuard({ phase, describe, label, store = null, now = () => Date.now() }) {
  return async function serviceControlGuardMiddleware(req, res, next) {
    try {
      const described = await describe(req);
      if (!described) return next();

      const view = await (store || runtime.getStore()).ready();
      const outcome = evaluate({ described, phase, view, req, now: now() });
      if (outcome.pass) return next();

      logger.info?.("[service-control] opération refusée", {
        route: label,
        code: outcome.refusal.body.code,
        requestId: outcome.refusal.body.requestId,
      });
      return send(res, outcome.refusal);
    } catch (err) {
      logger.error?.("[service-control] garde en échec — opération d'argent REFUSÉE (fermeture)", {
        route: label,
        message: err && err.message,
      });
      const decision = { allowed: false, code: policy.CODES.SERVICE_STATUS_UNAVAILABLE, level: "MAINTENANCE", rule: null, httpStatus: 503 };
      return send(res, policy.buildRefusal({ decision, locale: "fr", now: now(), requestId: req.id || null }));
    }
  };
}

module.exports = {
  serviceControlGuard,
  evaluate,
  describeInitiate,
  describeConfirm,
  describeFixed,
  describeInternalPayment,
  toCountryIso,
  INTERNAL_PAYMENT_FEATURES,
};
