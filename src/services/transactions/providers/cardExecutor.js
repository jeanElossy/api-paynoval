"use strict";

const createError = require("http-errors");
const { getProviderAdapter } = require("../../../providers/providerSelector");

function buildCardPayoutPayload(tx) {
  const md = tx.metadata || {};
  const ext = md.externalRecipient || {};
  const provider = String(tx.provider || "visa_direct").trim().toLowerCase();

  return {
    txReference: tx.reference,
    reference: tx.reference,
    idempotencyKey: tx.idempotencyKey || tx.reference,
    providerReference: tx.providerReference || null,
    flow: tx.flow,
    provider,

    amount: Number(tx.amountTarget || tx.localAmount || 0),
    currency: tx.currencyTarget || tx.localCurrencySymbol || null,

    recipient: {
      pan: ext.pan || null,
      maskedCardNumber: ext.maskedCardNumber || null,
      expiryMonth: ext.expiryMonth || null,
      expiryYear: ext.expiryYear || null,
      name: ext.cardHolder || tx.nameDestinataire || null,
    },

    pan: ext.pan || null,
    cardHolderName: ext.cardHolder || tx.nameDestinataire || null,

    sender: {
      id: tx.sender ? String(tx.sender) : null,
      email: tx.senderEmail || null,
      name: tx.senderName || null,
    },

    description: tx.description || "PayNoval card payout",

    metadata: {
      ...(md || {}),
      provider,
      rail: "card",
      txCoreReference: tx.reference,
      txCoreTransactionId: String(tx._id),
    },

    tx,
  };
}

function buildCardTopupPayload(tx) {
  const md = tx.metadata || {};
  const ext = md.externalSource || {};
  const provider = String(tx.provider || "stripe").trim().toLowerCase();

  return {
    txReference: tx.reference,
    reference: tx.reference,
    idempotencyKey: tx.idempotencyKey || tx.reference,
    providerReference: tx.providerReference || null,
    flow: tx.flow,
    provider,

    amount: Number(tx.amountSource || tx.amount || 0),
    currency: tx.currencySource || tx.senderCurrencySymbol || null,

    sender: {
      pan: ext.pan || null,
      maskedCardNumber: ext.maskedCardNumber || null,
      expiryMonth: ext.expiryMonth || null,
      expiryYear: ext.expiryYear || null,
      name: ext.cardHolder || tx.senderName || null,
    },

    paymentMethodId: ext.paymentMethodId || tx.paymentMethodId || null,
    cardToken: ext.cardToken || tx.cardToken || null,
    cardHolderName: ext.cardHolder || tx.senderName || null,

    receiver: {
      id: tx.receiver ? String(tx.receiver) : null,
      email: tx.recipientEmail || null,
      name: tx.nameDestinataire || null,
    },

    description: tx.description || "PayNoval card topup",

    metadata: {
      ...(md || {}),
      provider,
      rail: "card",
      txCoreReference: tx.reference,
      txCoreTransactionId: String(tx._id),
    },

    tx,
  };
}

async function executeCardPayout({ req, transaction }) {
  const provider = String(transaction.provider || "visa_direct").trim().toLowerCase();

  const adapter = getProviderAdapter({
    rail: "card",
    provider,
  });

  if (!adapter || typeof adapter.payout !== "function") {
    throw createError(500, `Adapter card payout introuvable (${provider})`);
  }

  const payload = buildCardPayoutPayload(transaction);
  const result = await adapter.payout(payload);

  return {
    providerStatus:
      result?.externalStatus ||
      result?.status ||
      "PROVIDER_SUBMITTED",
    providerReference:
      result?.providerReference ||
      transaction.providerReference ||
      null,
    raw: result?.raw || result || null,
  };
}

async function startCardTopup({ req, transaction }) {
  const provider = String(transaction.provider || "stripe").trim().toLowerCase();

  const adapter = getProviderAdapter({
    rail: "card",
    provider,
  });

  if (!adapter || typeof adapter.collect !== "function") {
    throw createError(500, `Adapter card topup introuvable (${provider})`);
  }

  const payload = buildCardTopupPayload(transaction);
  const result = await adapter.collect(payload);

  return {
    providerStatus:
      result?.externalStatus ||
      result?.status ||
      "AWAITING_PROVIDER_PAYMENT",
    providerReference:
      result?.providerReference ||
      transaction.providerReference ||
      null,
    raw: result?.raw || result || null,
  };
}

module.exports = {
  executeCardPayout,
  startCardTopup,
};