"use strict";

/**
 * ============================================================================
 * SERVICE DE DEVIS — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
 * ============================================================================
 *
 * ── Le défaut d'architecture que ce déplacement ferme ───────────────────────
 *
 * Le calcul du prix vivait dans la passerelle. Tx-Core — le moteur d'argent —
 * lui demandait chaque devis EN HTTP :
 *
 *     Mobile ──► Gateway ──► Tx-Core ──► Gateway ──► base tarification
 *                                          ▲
 *                              le moteur rappelle le bord
 *
 * Tx-Core l'annonçait lui-même au démarrage : « GATEWAY_URL absente ⇒ toute
 * transaction nécessitant un devis échouera en 503 ». Autrement dit, une panne
 * de la passerelle n'empêchait pas seulement les clients d'entrer : **elle
 * arrêtait les virements depuis l'intérieur du moteur**, et la passerelle ne
 * pouvait plus être déployée ni redémarrée indépendamment.
 *
 * Stripe, PayPal et Adyen tiennent tous la même règle : les dépendances
 * DESCENDENT. Bord → services → moteur, jamais l'inverse. Le bord route,
 * authentifie et limite ; il ne possède aucun domaine et ne détient aucune
 * base — c'est la surface la plus exposée d'Internet.
 *
 * Le devis est donc devenu un APPEL DE FONCTION dans le processus qui en a
 * besoin. Un saut réseau de moins sur le chemin de l'argent, et un mode de
 * défaillance de moins.
 *
 * ── Ce fichier ne connaît pas HTTP ──────────────────────────────────────────
 *
 * Il rend des objets et LÈVE des erreurs portant un `status`. La traduction en
 * réponse HTTP appartient au contrôleur, et à lui seul : c'est ce qui permet à
 * `services/transactions/shared/pricing.js` d'appeler `computeFullQuote`
 * directement, sans fabriquer un faux `req`/`res`.
 *
 * ── Modèle résolu PARESSEUSEMENT ────────────────────────────────────────────
 *
 * `PricingQuote` était requis au chargement, ce qui marchait parce que la
 * passerelle liait ses modèles à la connexion Mongoose GLOBALE. Tx-Core ouvre
 * des connexions NOMMÉES, dont aucune n'existe au moment du `require`.
 *
 * ── `crypto.randomUUID` plutôt que le paquet `uuid` ─────────────────────────
 *
 * La passerelle dépendait de `uuid`. Tx-Core ne l'a pas, et Node 22 rend la
 * fonction nativement : ajouter une dépendance pour une ligne serait payer une
 * surface d'approvisionnement supplémentaire pour rien.
 */

const crypto = require("crypto");

const { getActiveRules } = require("./ruleCache");
const { recordCoverageGap } = require("./coverage");
const { getExchangeRate } = require("./exchangeRateService");

const {
  computeQuote,
  roundMoney,
  normalizeCountryISO2,
} = require("./pricingEngine");

const { getPricingModel } = require("../../config/db");

/** Résolu à l'appel : la connexion n'existe pas au chargement du module. */
const modelePricingQuote = () => getPricingModel("PricingQuote");

const uuidv4 = () => crypto.randomUUID();

const LOCK_TTL_MIN_RAW = Number(process.env.PRICING_LOCK_TTL_MIN || 10);
const LOCK_TTL_MIN =
  Number.isFinite(LOCK_TTL_MIN_RAW) && LOCK_TTL_MIN_RAW > 0
    ? LOCK_TTL_MIN_RAW
    : 10;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function pickBody(req) {
  return req.body && Object.keys(req.body).length ? req.body : req.query || {};
}

const normStr = (v) => String(v ?? "").trim();
const upper = (v) => normStr(v).toUpperCase();
const lower = (v) => normStr(v).toLowerCase();

function cleanId(v) {
  const s = normStr(v);
  return s || undefined;
}

function compactObject(obj = {}) {
  const out = {};

  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }

  return out;
}

function normalizeTxType(v) {
  const raw = upper(v);
  if (!raw) return "";

  if (["TRANSFER", "DEPOSIT", "WITHDRAW"].includes(raw)) return raw;

  const low = lower(v);

  if (["send", "p2p", "transfer", "transfert"].includes(low)) {
    return "TRANSFER";
  }

  if (["deposit", "depot", "dépôt", "cashin", "topup"].includes(low)) {
    return "DEPOSIT";
  }

  if (
    ["withdraw", "withdrawal", "cashout", "retrait", "payout"].includes(low)
  ) {
    return "WITHDRAW";
  }

  return raw;
}

function normalizeMethod(v) {
  const raw = upper(v).replace(/[\s-]+/g, "_");
  if (!raw) return "";

  if (["MOBILEMONEY", "MOBILE_MONEY", "MOMO", "MM"].includes(raw)) {
    return "MOBILEMONEY";
  }

  if (["BANK", "WIRE", "TRANSFER_BANK", "VIREMENT"].includes(raw)) {
    return "BANK";
  }

  if (
    [
      "CARD",
      "VISA",
      "VISA_DIRECT",
      "MASTERCARD",
      "CARTE",
    ].includes(raw)
  ) {
    return "CARD";
  }

  if (["INTERNAL", "WALLET", "PAYNOVAL"].includes(raw)) {
    return "INTERNAL";
  }

  return raw;
}

function normalizeCountryForStore(country) {
  if (!country) return null;

  const iso2 = normalizeCountryISO2(country);
  return upper(iso2 || country);
}

function pickRequestId(req) {
  return (
    req.get("x-request-id") ||
    req.get("x-correlation-id") ||
    req.get("x-amzn-trace-id") ||
    null
  );
}

function pickCurrency(...values) {
  for (const value of values) {
    const s = upper(value);
    if (!s) continue;

    if (s === "€" || s.includes("EUR")) return "EUR";
    if (s === "$" || s.includes("USD")) return "USD";
    if (s.includes("CAD")) return "CAD";
    if (s.includes("GBP") || s.includes("£")) return "GBP";
    if (s.includes("XOF") || s.includes("FCFA") || s.includes("CFA")) {
      return "XOF";
    }
    if (s.includes("XAF")) return "XAF";

    const letters = s.replace(/[^A-Z]/g, "");
    if (letters.length === 3) return letters;
  }

  return "";
}

async function getMarketRateDirect(from, to, { requestId } = {}) {
  if (upper(from) === upper(to)) return 1;

  const out = await getExchangeRate(from, to, { requestId });
  const rate = Number(out?.rate ?? out);

  return Number.isFinite(rate) ? rate : null;
}

/**
 * Convertit un montant vers la devise admin CAD.
 */
async function convertToAdminCurrency({
  amount,
  fromCurrency,
  adminCurrency = "CAD",
  requestId,
}) {
  const safeAmount = Number(amount || 0);
  const from = upper(fromCurrency);
  const admin = upper(adminCurrency);

  if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
    return {
      adminCurrency: admin,
      amountAdmin: 0,
      conversionRate: 0,
    };
  }

  if (from === admin) {
    return {
      adminCurrency: admin,
      amountAdmin: roundMoney(safeAmount, admin),
      conversionRate: 1,
    };
  }

  const rate = await getMarketRateDirect(from, admin, { requestId });

  if (!Number.isFinite(rate) || rate <= 0) {
    return {
      adminCurrency: admin,
      amountAdmin: 0,
      conversionRate: 0,
    };
  }

  return {
    adminCurrency: admin,
    amountAdmin: roundMoney(safeAmount * rate, admin),
    conversionRate: Number(rate),
  };
}

function buildRequest(body = {}) {
  const txType = normalizeTxType(
    body.txType || body.transactionType || body.flow || body.type
  );

  const method = normalizeMethod(
    body.method || body.methodType || body.rail || body.paymentMethod
  );

  const amount = Number(
    body.amount ??
      body.amountSource ??
      body.grossFrom ??
      body.netFrom ??
      body.sourceAmount
  );

  const fromCurrency = pickCurrency(
    body.fromCurrency,
    body.currencySource,
    body.senderCurrencyCode,
    body.currency,
    body.sourceCurrency,
    body.selectedCurrency
  );

  const toCurrency =
    pickCurrency(
      body.toCurrency,
      body.currencyTarget,
      body.localCurrencyCode,
      body.targetCurrency,
      body.destinationCurrency,
      body.localCurrencySymbol
    ) || fromCurrency;

  return {
    txType,
    method,
    amount,
    fromCurrency,
    toCurrency,

    country: normalizeCountryForStore(
      body.country || body.destinationCountry || body.toCountry
    ),

    operator: body.operator
      ? lower(body.operator)
      : body.operatorName
      ? lower(body.operatorName)
      : body.mobileMoney
      ? lower(body.mobileMoney)
      : null,

    provider: body.provider ? lower(body.provider) : null,

    fromCountry: normalizeCountryForStore(
      body.fromCountry || body.sourceCountry
    ),

    toCountry: normalizeCountryForStore(
      body.toCountry || body.targetCountry || body.destinationCountry
    ),
  };
}

function validateRequest(request) {
  if (!request.txType) return "txType est requis";

  if (
    !request.amount ||
    !Number.isFinite(request.amount) ||
    request.amount <= 0
  ) {
    return "amount doit être un nombre > 0";
  }

  if (!request.fromCurrency) return "fromCurrency est requis";
  if (!request.toCurrency) return "toCurrency est requis";

  return null;
}

function buildPricingAliases(quoteId) {
  const id = cleanId(quoteId);

  return compactObject({
    quoteId: id,
    pricingId: id,
    pricingLockId: id,
    lockId: id,
    effectivePricingId: id,
  });
}

function buildDebugPayload({ request, quote, requestId }) {
  const fee = Number(quote?.result?.fee || 0);
  const grossFrom = Number(quote?.result?.grossFrom || request?.amount || 0);
  const netFrom = Number(quote?.result?.netFrom || 0);

  const marketRate =
    quote?.result?.marketRate != null ? Number(quote.result.marketRate) : null;

  const appliedRate =
    quote?.result?.appliedRate != null ? Number(quote.result.appliedRate) : null;

  const netTo = Number(quote?.result?.netTo || 0);

  const feeRevenueCAD = Number(quote?.result?.feeRevenue?.amountCAD || 0);
  const fxRevenueTo = Number(quote?.result?.fxRevenue?.amount || 0);
  const fxRevenueCAD = Number(quote?.result?.fxRevenue?.amountCAD || 0);

  return {
    requestId: requestId || null,

    requestNormalized: {
      txType: request?.txType || null,
      method: request?.method || null,
      amount: Number(request?.amount || 0),
      fromCurrency: request?.fromCurrency || null,
      toCurrency: request?.toCurrency || null,
      country: request?.country || null,
      fromCountry: request?.fromCountry || null,
      toCountry: request?.toCountry || null,
      provider: request?.provider || null,
      operator: request?.operator || null,
    },

    feeSource: fee,

    feeComputation: {
      grossFrom,
      fee,
      netFrom,
      formula:
        Number.isFinite(grossFrom) && Number.isFinite(fee)
          ? `${grossFrom} - ${fee} = ${netFrom}`
          : null,
    },

    feeRuleApplied: quote?.ruleApplied || null,
    fxRuleApplied: quote?.fxRuleApplied || null,

    feeRevenueCAD,

    fxComputation: {
      marketRate,
      appliedRate,
      spreadPerUnit:
        Number.isFinite(marketRate) && Number.isFinite(appliedRate)
          ? Math.max(0, marketRate - appliedRate)
          : null,
      marginDelta:
        Number.isFinite(marketRate) && Number.isFinite(appliedRate)
          ? appliedRate - marketRate
          : null,
      netTo,
      fxRevenueTo,
      fxRevenueToCurrency: quote?.result?.fxRevenue?.toCurrency || null,
      fxRevenueCAD,
      fxConversionRateToCAD: Number(
        quote?.result?.fxRevenue?.conversionRateToCAD || 0
      ),
      formula:
        Number.isFinite(netFrom) && Number.isFinite(appliedRate)
          ? `${netFrom} * ${appliedRate} = ${netTo}`
          : null,
      gainFormula:
        Number.isFinite(netFrom) &&
        Number.isFinite(marketRate) &&
        Number.isFinite(appliedRate)
          ? `${netFrom} * (${marketRate} - ${appliedRate}) = ${fxRevenueTo}`
          : null,
    },

    feeBreakdown: quote?.result?.feeBreakdown || null,
    feeRevenue: quote?.result?.feeRevenue || null,
    fxRevenue: quote?.result?.fxRevenue || null,
  };
}

async function computeFullQuote({ request, requestId }) {
  // Lecture servie par le cache, invalidé à chaque publication tarifaire.
  const rules = await getActiveRules();

  const quote = await computeQuote({
    req: request,
    rules,
    getMarketRate: async (from, to) =>
      getMarketRateDirect(from, to, { requestId }),
  });

  quote.result = quote.result || {};

  const feeRevenueAdmin = await convertToAdminCurrency({
    amount: Number(quote?.result?.fee || 0),
    fromCurrency: request.fromCurrency,
    adminCurrency: "CAD",
    requestId,
  });

  quote.result.feeRevenue = {
    sourceCurrency: request.fromCurrency,
    amount: Number(quote?.result?.fee || 0),
    adminCurrency: feeRevenueAdmin.adminCurrency,
    amountCAD: feeRevenueAdmin.amountAdmin,
    conversionRateToCAD: feeRevenueAdmin.conversionRate,
    calculatedAt: new Date().toISOString(),
  };

  const fxRevenueTo = Number(quote?.result?.fxRevenue?.amount || 0);
  const fxRevenueToCurrency =
    quote?.result?.fxRevenue?.toCurrency || request.toCurrency;

  const fxRevenueAdmin = await convertToAdminCurrency({
    amount: fxRevenueTo,
    fromCurrency: fxRevenueToCurrency,
    adminCurrency: "CAD",
    requestId,
  });

  quote.result.fxRevenue = {
    ...(quote.result.fxRevenue || {}),
    adminCurrency: fxRevenueAdmin.adminCurrency,
    amountCAD: fxRevenueAdmin.amountAdmin,
    conversionRateToCAD: fxRevenueAdmin.conversionRate,
    calculatedAt: new Date().toISOString(),
  };

  quote.debug = buildDebugPayload({
    request,
    quote,
    requestId,
  });

  return quote;
}

function buildQuoteResponsePayload({ quote, mode = "QUOTE" }) {
  return {
    success: true,
    ok: true,
    mode,
    request: quote.request,
    result: quote.result,
    feeSource: quote.debug?.feeSource ?? Number(quote?.result?.fee || 0),
    ruleApplied: quote.ruleApplied || null,
    fxRuleApplied: quote.fxRuleApplied || null,
    debug: quote.debug || null,
  };
}

function buildLockResponsePayload({ doc }) {
  const aliases = buildPricingAliases(doc.quoteId);

  const base = {
    success: true,
    ok: true,
    mode: "LOCKED",

    ...aliases,

    expiresAt: doc.expiresAt,
    request: doc.request,
    result: doc.result,
    feeSource: doc.debug?.feeSource ?? Number(doc?.result?.fee || 0),
    ruleApplied: doc.ruleApplied || null,
    fxRuleApplied: doc.fxRuleApplied || null,
    debug: doc.debug || null,
  };

  return {
    ...base,

    /**
     * Compat front :
     * - axios normalizeResponse peut retourner {...data}
     * - certains appels lisent lockRes.data
     * - d'autres lisent lockRes.data.data
     */
    data: {
      ...base,
    },
  };
}

/**
 * ============================================================================
 * VERROU DE PRIX
 * ============================================================================
 *
 * Fige un devis pour `PRICING_LOCK_TTL_MIN` minutes. C'est ce qui garantit que
 * le prix affiché au client est celui qui sera prélevé : sans verrou, le taux
 * peut bouger entre l'écran de confirmation et l'écriture comptable, et
 * l'utilisateur paie autre chose que ce qu'il a accepté.
 *
 * ⚠️ `userId` est OBLIGATOIRE : un verrou est un engagement de prix envers
 * quelqu'un. Un verrou anonyme serait réutilisable par n'importe qui, ce qui en
 * ferait un moyen de figer un taux favorable et de l'appliquer à un autre.
 */
async function lockQuote({ request, requestId, userId }) {
  if (!userId) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }

  const computed = await computeFullQuote({ request, requestId });

  const quoteId = uuidv4();
  const expiresAt = new Date(Date.now() + LOCK_TTL_MIN * 60 * 1000);

  const doc = await modelePricingQuote().create({
    quoteId,
    userId,
    status: "ACTIVE",
    request: {
      txType: computed.request.txType,
      method: computed.request.method || null,
      amount: Number(computed.request.amount),
      fromCurrency: upper(computed.request.fromCurrency),
      toCurrency: upper(computed.request.toCurrency),
      country: normalizeCountryForStore(computed.request.country),
      fromCountry: normalizeCountryForStore(computed.request.fromCountry),
      toCountry: normalizeCountryForStore(computed.request.toCountry),
      operator: computed.request.operator
        ? lower(computed.request.operator)
        : null,
      provider: computed.request.provider
        ? lower(computed.request.provider)
        : null,
    },
    result: computed.result,
    ruleApplied: computed.ruleApplied || null,
    fxRuleApplied: computed.fxRuleApplied || null,
    debug: computed.debug || null,
    expiresAt,
  });

  return doc;
}

module.exports = {
  buildRequest,
  validateRequest,
  computeFullQuote,
  lockQuote,
  buildQuoteResponsePayload,
  buildLockResponsePayload,
  recordCoverageGap,
  normalizeCountryForStore,
  LOCK_TTL_MIN,
};
