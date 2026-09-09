"use strict";

/**
 * Helpers partagés pour les flows TX Core externes.
 * - résolution flow
 * - sécurité/sanitation metadata
 * - devise/pays
 * - payload pricing
 */

const createError = require("http-errors");

const OUTBOUND_EXTERNAL_FLOWS = Object.freeze({
  PAYNOVAL_TO_MOBILEMONEY_PAYOUT: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  PAYNOVAL_TO_CARD_PAYOUT: "PAYNOVAL_TO_CARD_PAYOUT",
});

const INBOUND_EXTERNAL_FLOWS = Object.freeze({
  MOBILEMONEY_COLLECTION_TO_PAYNOVAL: "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
  CARD_TOPUP_TO_PAYNOVAL: "CARD_TOPUP_TO_PAYNOVAL",
});

const ALL_EXTERNAL_FLOWS = new Set([
  ...Object.values(OUTBOUND_EXTERNAL_FLOWS),
  ...Object.values(INBOUND_EXTERNAL_FLOWS),
]);

function low(v) {
  return String(v || "").trim().toLowerCase();
}

function up(v) {
  return String(v || "").trim().toUpperCase();
}

function sanitizePlainObject(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function normalizeCountryValue(v) {
  return String(v || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function normalizeCountryISO(v) {
  const s = normalizeCountryValue(v);

  const map = {
    "COTE D'IVOIRE": "CI",
    "COTE DIVOIRE": "CI",
    "IVORY COAST": "CI",
    CI: "CI",

    FRANCE: "FR",
    FR: "FR",

    CANADA: "CA",
    CA: "CA",

    BELGIQUE: "BE",
    BELGIUM: "BE",
    BE: "BE",

    ALLEMAGNE: "DE",
    GERMANY: "DE",
    DE: "DE",

    SENEGAL: "SN",
    SN: "SN",

    MALI: "ML",
    ML: "ML",

    BURKINA: "BF",
    "BURKINA FASO": "BF",
    BF: "BF",

    CAMEROUN: "CM",
    CAMEROON: "CM",
    CM: "CM",

    USA: "US",
    "UNITED STATES": "US",
    US: "US",
  };

  return map[s] || s;
}

function maskPan(raw) {
  const s = String(raw || "").replace(/\D/g, "");
  if (s.length < 8) return null;
  return `${s.slice(0, 6)}******${s.slice(-4)}`;
}

function redactSensitiveFields(obj = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};

  for (const [k, v] of Object.entries(obj)) {
    const kk = low(k);

    if (
      [
        "securityanswer",
        "securitycode",
        "validationcode",
        "cvc",
        "cvv",
        "pin",
        "otp",
        "securityanswerhash",
      ].includes(kk)
    ) {
      continue;
    }

    if (kk === "cardnumber") {
      out.maskedCardNumber = maskPan(v);
      continue;
    }

    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactSensitiveFields(v);
      continue;
    }

    out[k] = v;
  }

  return out;
}

function normalizeProviderAlias(v) {
  const s = low(v);

  if (!s) return "";

  if (["mobilemoney", "mobile_money", "momo"].includes(s)) return "mobilemoney";
  if (["orange", "orange_money"].includes(s)) return "orange";
  if (["mtn", "mtn_momo", "mtn_money"].includes(s)) return "mtn";
  if (["moov", "moov_money", "flooz"].includes(s)) return "moov";
  if (["wave"].includes(s)) return "wave";

  if (["bank", "banque"].includes(s)) return "bank";

  if (["card", "visa", "stripe", "visa_direct"].includes(s)) return s;

  if (["paynoval", "internal"].includes(s)) return "paynoval";

  return s;
}

function normalizeFundsOrDestination(v) {
  const s = low(v);

  if (!s) return "";

  if (["mobilemoney", "mobile_money", "momo"].includes(s)) return "mobilemoney";
  if (["bank", "banque"].includes(s)) return "bank";
  if (["card", "visa", "stripe", "visa_direct"].includes(s)) return s;
  if (["paynoval", "internal"].includes(s)) return "paynoval";

  return s;
}

function normalizeAction(body = {}) {
  const action = low(body.action);
  if (action) {
    if (["withdraw", "retrait", "send", "payout"].includes(action)) return "withdraw";
    if (["deposit", "depot", "topup", "collection"].includes(action)) return "deposit";
    return action;
  }

  const txType = up(body.txType || body.transactionType || "");
  if (txType === "WITHDRAW") return "withdraw";
  if (txType === "DEPOSIT") return "deposit";

  return "send";
}

function resolveExternalFlow(body = {}) {
  const funds = normalizeFundsOrDestination(body.funds);
  const destination = normalizeFundsOrDestination(body.destination);
  const action = normalizeAction(body);

  if (
    funds === "paynoval" &&
    destination === "mobilemoney" &&
    ["send", "withdraw"].includes(action)
  ) {
    return OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT;
  }

  if (
    funds === "paynoval" &&
    destination === "bank" &&
    ["send", "withdraw"].includes(action)
  ) {
    return OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_BANK_PAYOUT;
  }

  if (
    funds === "paynoval" &&
    /* « stripe » retiré le 2026-09-09 : accepté ici, il était réécrit en
       `visa_direct` plus bas — un prestataire retiré nommé explicitement doit
       être REFUSÉ, pas substitué (règle B.2). */
    ["card", "visa", "visa_direct", "visadirect"].includes(destination) &&
    ["send", "withdraw"].includes(action)
  ) {
    return OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_CARD_PAYOUT;
  }

  if (
    funds === "mobilemoney" &&
    destination === "paynoval" &&
    action === "deposit"
  ) {
    return INBOUND_EXTERNAL_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL;
  }

  if (
    funds === "bank" &&
    destination === "paynoval" &&
    action === "deposit"
  ) {
    return INBOUND_EXTERNAL_FLOWS.BANK_TRANSFER_TO_PAYNOVAL;
  }

  if (
    /* « stripe » retiré le 2026-09-09 — voir ci-dessus. */
    ["card", "visa", "visa_direct", "visadirect"].includes(funds) &&
    destination === "paynoval" &&
    action === "deposit"
  ) {
    return INBOUND_EXTERNAL_FLOWS.CARD_TOPUP_TO_PAYNOVAL;
  }

  return "UNKNOWN_FLOW";
}

function isOutboundExternalFlow(flow) {
  return Object.values(OUTBOUND_EXTERNAL_FLOWS).includes(flow);
}

function isInboundExternalFlow(flow) {
  return Object.values(INBOUND_EXTERNAL_FLOWS).includes(flow);
}

function isExternalFlow(flow) {
  return ALL_EXTERNAL_FLOWS.has(flow);
}

function resolveProviderForFlow(flow, body = {}) {
  const hinted = normalizeProviderAlias(
    body.provider ||
      body.providerSelected ||
      body.operatorKey ||
      body.operatorName ||
      body.operator ||
      body.metadata?.provider ||
      body.meta?.provider ||
      body.beneficiary?.operatorKey ||
      body.beneficiary?.operatorName ||
      body.recipientInfo?.operatorKey ||
      body.recipientInfo?.operatorName ||
      ""
  );

  if (
    flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT ||
    flow === INBOUND_EXTERNAL_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL
  ) {
    if (["orange", "mtn", "moov", "wave"].includes(hinted)) return hinted;
    return "mobilemoney";
  }

  if (
    flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_BANK_PAYOUT ||
    flow === INBOUND_EXTERNAL_FLOWS.BANK_TRANSFER_TO_PAYNOVAL
  ) {
    return "bank";
  }

  /**
   * Les deux flux carte rendent le MÊME prestataire.
   *
   * Ils rendaient « stripe » selon le sens, y compris quand l'appelant le
   * suggérait explicitement. Stripe retiré du périmètre le 2026-09-08 : le rail carte, dans les DEUX
   sens, est servi par Visa Direct — et demain par le partenaire
   multi-réseaux. Un défaut pointant vers un prestataire supprimé faisait
   lever `getProviderAdapter`, donc échouait le dépôt par carte.
   */
  if (
    flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_CARD_PAYOUT ||
    flow === INBOUND_EXTERNAL_FLOWS.CARD_TOPUP_TO_PAYNOVAL
  ) {
    return "visa_direct";
  }

  return hinted || "paynoval";
}

function resolveCountries(body = {}, fallbackCountry = "") {
  const rawCountry =
    body.country ||
    body.destinationCountry ||
    body.toCountry ||
    body.targetCountry ||
    body.fromCountry ||
    body.sourceCountry ||
    fallbackCountry ||
    "";

  const rawFrom =
    body.fromCountry ||
    body.sourceCountry ||
    fallbackCountry ||
    rawCountry ||
    "";

  const rawTo =
    body.toCountry ||
    body.targetCountry ||
    body.destinationCountry ||
    fallbackCountry ||
    rawCountry ||
    "";

  return {
    country: normalizeCountryISO(rawCountry),
    fromCountry: normalizeCountryISO(rawFrom),
    toCountry: normalizeCountryISO(rawTo),
  };
}

function resolveCurrencies({ body = {}, normCur, country = "" }) {
  const sourceRaw =
    body.senderCurrencyCode ||
    body.currencySource ||
    body.fromCurrency ||
    body.senderCurrencySymbol ||
    body.currency ||
    "";

  const targetRaw =
    body.localCurrencyCode ||
    body.currencyTarget ||
    body.toCurrency ||
    body.localCurrencySymbol ||
    body.currency ||
    "";

  const currencySourceISO =
    normCur(sourceRaw, country) || up(sourceRaw);

  const currencyTargetISO =
    normCur(targetRaw, country) || up(targetRaw);

  if (!currencySourceISO || !currencyTargetISO) {
    throw createError(400, "Devises source/cible invalides");
  }

  return { currencySourceISO, currencyTargetISO };
}

function buildExternalMetadata({ flow, provider, body = {}, extra = {} }) {
  const safeBody = redactSensitiveFields(body);

  return sanitizePlainObject({
    provider,
    providerSelected: provider,
    operator: body.operator || null,
    operatorName: body.operatorName || null,
    operatorKey: body.operatorKey || null,
    method: body.method || null,
    methodType: body.methodType || null,
    txType: body.txType || body.transactionType || null,
    action: body.action || null,
    flow,
    requestSnapshot: safeBody,
    ...extra,
  });
}

function buildExternalMeta({ senderUser = null, receiverUser = null, body = {}, extra = {} }) {
  return sanitizePlainObject({
    ownerUserId: senderUser?._id || receiverUser?._id || null,
    senderUserId: senderUser?._id || null,
    receiverUserId: receiverUser?._id || null,
    requestOrigin: "tx-core",
    recipientInfo: redactSensitiveFields(
      body.recipientInfo || body.beneficiary || {}
    ),
    funds: body.funds || null,
    destination: body.destination || null,
    fundsUi: body.fundsUi || null,
    destinationUi: body.destinationUi || null,
    quoteId: body.quoteId || null,
    pricingId: body.pricingId || body.pricingLockId || null,
    effectivePricingId:
      body.effectivePricingId ||
      body.pricingId ||
      body.pricingLockId ||
      body.quoteId ||
      null,
    ...extra,
  });
}

module.exports = {
  OUTBOUND_EXTERNAL_FLOWS,
  INBOUND_EXTERNAL_FLOWS,
  resolveExternalFlow,
  isOutboundExternalFlow,
  isInboundExternalFlow,
  isExternalFlow,
  resolveProviderForFlow,
  resolveCountries,
  resolveCurrencies,
  buildExternalMetadata,
  buildExternalMeta,
  redactSensitiveFields,
  maskPan,
};