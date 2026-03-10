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
  PAYNOVAL_TO_BANK_PAYOUT: "PAYNOVAL_TO_BANK_PAYOUT",
  PAYNOVAL_TO_CARD_PAYOUT: "PAYNOVAL_TO_CARD_PAYOUT",
});

const INBOUND_EXTERNAL_FLOWS = Object.freeze({
  MOBILEMONEY_COLLECTION_TO_PAYNOVAL: "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
  BANK_TRANSFER_TO_PAYNOVAL: "BANK_TRANSFER_TO_PAYNOVAL",
  CARD_TOPUP_TO_PAYNOVAL: "CARD_TOPUP_TO_PAYNOVAL",
});

const ALL_EXTERNAL_FLOWS = new Set([
  ...Object.values(OUTBOUND_EXTERNAL_FLOWS),
  ...Object.values(INBOUND_EXTERNAL_FLOWS),
]);

function low(v) {
  return String(v || "").trim().toLowerCase();
}

function sanitizePlainObject(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
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

    if (["securityanswer", "securitycode", "validationcode", "cvc", "cvv", "pin", "otp"].includes(kk)) {
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

function resolveExternalFlow(body = {}) {
  const funds = low(body.funds);
  const destination = low(body.destination);
  const action = low(body.action || "send");

  if (funds === "paynoval" && destination === "mobilemoney" && (action === "send" || action === "withdraw")) {
    return OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT;
  }

  if (funds === "paynoval" && destination === "bank" && (action === "send" || action === "withdraw")) {
    return OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_BANK_PAYOUT;
  }

  if (
    funds === "paynoval" &&
    ["card", "stripe", "visa_direct"].includes(destination) &&
    (action === "send" || action === "withdraw")
  ) {
    return OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_CARD_PAYOUT;
  }

  if (funds === "mobilemoney" && destination === "paynoval" && action === "deposit") {
    return INBOUND_EXTERNAL_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL;
  }

  if (funds === "bank" && destination === "paynoval" && action === "deposit") {
    return INBOUND_EXTERNAL_FLOWS.BANK_TRANSFER_TO_PAYNOVAL;
  }

  if (
    ["card", "stripe", "visa_direct"].includes(funds) &&
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
  const hinted = low(
    body.provider ||
      body.providerSelected ||
      body.metadata?.provider ||
      body.operator ||
      ""
  );

  if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT) return "mobilemoney";
  if (flow === INBOUND_EXTERNAL_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL) return "mobilemoney";

  if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_BANK_PAYOUT) return "bank";
  if (flow === INBOUND_EXTERNAL_FLOWS.BANK_TRANSFER_TO_PAYNOVAL) return "bank";

  if (flow === INBOUND_EXTERNAL_FLOWS.CARD_TOPUP_TO_PAYNOVAL) return hinted === "visa_direct" ? "visa_direct" : "stripe";
  if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_CARD_PAYOUT) return hinted === "stripe" ? "stripe" : "visa_direct";

  return hinted || "paynoval";
}

function resolveCountries(body = {}, fallbackCountry = "") {
  const country = String(
    body.country ||
      body.destinationCountry ||
      body.toCountry ||
      body.fromCountry ||
      fallbackCountry ||
      ""
  ).trim();

  const fromCountry = String(body.fromCountry || fallbackCountry || country || "").trim();
  const toCountry = String(body.toCountry || body.destinationCountry || country || "").trim();

  return { country, fromCountry, toCountry };
}

function resolveCurrencies({ body = {}, normCur, country = "" }) {
  const currencySourceISO =
    normCur(
      body.senderCurrencyCode ||
        body.currencySource ||
        body.fromCurrency ||
        body.senderCurrencySymbol ||
        body.currency,
      country
    ) ||
    String(
      body.senderCurrencyCode ||
        body.currencySource ||
        body.fromCurrency ||
        body.senderCurrencySymbol ||
        body.currency ||
        ""
    )
      .trim()
      .toUpperCase();

  const currencyTargetISO =
    normCur(
      body.localCurrencyCode ||
        body.currencyTarget ||
        body.toCurrency ||
        body.localCurrencySymbol,
      country
    ) ||
    String(
      body.localCurrencyCode ||
        body.currencyTarget ||
        body.toCurrency ||
        body.localCurrencySymbol ||
        ""
    )
      .trim()
      .toUpperCase();

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
    method: body.method || null,
    txType: body.txType || null,
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
    recipientInfo: redactSensitiveFields(body.recipientInfo || {}),
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