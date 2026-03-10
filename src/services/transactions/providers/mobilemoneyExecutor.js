"use strict";

const createError = require("http-errors");
const { getProviderAdapter } = require("./providerSelector");

function buildMobileMoneyPayoutPayload(tx) {
  const md = tx.metadata || {};
  const ext = md.externalRecipient || {};

  return {
    txReference: tx.reference,
    reference: tx.reference,
    idempotencyKey: tx.idempotencyKey || tx.reference,
    providerReference: tx.providerReference || null,
    flow: tx.flow,

    amount: Number(tx.amountTarget || tx.localAmount || 0),
    currency: tx.currencyTarget || tx.localCurrencySymbol || null,

    recipient: {
      phone: ext.phoneNumber || tx.recipientPhone || null,
      name: ext.recipientName || tx.nameDestinataire || null,
    },

    phone: ext.phoneNumber || tx.recipientPhone || null,
    country: tx.countryDest || md.countryDest || null,
    operator: ext.operator || tx.operator || md.provider || null,

    sender: {
      id: tx.sender ? String(tx.sender) : null,
      email: tx.senderEmail || null,
      name: tx.senderName || null,
    },

    description: tx.description || "PayNoval mobile money payout",

    metadata: {
      ...(md || {}),
      provider: tx.provider || md.provider || ext.operator || "wave",
      rail: "mobilemoney",
      txCoreReference: tx.reference,
      txCoreTransactionId: String(tx._id),
    },

    tx,
  };
}

function buildMobileMoneyCollectionPayload(tx) {
  const md = tx.metadata || {};
  const ext = md.externalSource || {};

  return {
    txReference: tx.reference,
    reference: tx.reference,
    idempotencyKey: tx.idempotencyKey || tx.reference,
    providerReference: tx.providerReference || null,
    flow: tx.flow,

    amount: Number(tx.amountSource || tx.amount || 0),
    currency: tx.currencySource || tx.senderCurrencySymbol || null,

    sender: {
      phone: ext.phoneNumber || tx.senderPhone || null,
      name: ext.senderName || tx.senderName || null,
    },

    phone: ext.phoneNumber || tx.senderPhone || null,
    country: tx.countrySource || md.countrySource || null,
    operator: ext.operator || tx.operator || md.provider || null,

    receiver: {
      id: tx.receiver ? String(tx.receiver) : null,
      email: tx.recipientEmail || null,
      name: tx.nameDestinataire || null,
    },

    description: tx.description || "PayNoval mobile money collection",

    metadata: {
      ...(md || {}),
      provider: tx.provider || md.provider || ext.operator || "wave",
      rail: "mobilemoney",
      txCoreReference: tx.reference,
      txCoreTransactionId: String(tx._id),
    },

    tx,
  };
}

async function executeMobileMoneyPayout({ req, transaction }) {
  const provider = String(
    transaction.provider ||
      transaction.metadata?.provider ||
      transaction.metadata?.externalRecipient?.operator ||
      transaction.operator ||
      "wave"
  )
    .trim()
    .toLowerCase();

  const adapter = getProviderAdapter({
    rail: "mobilemoney",
    provider,
  });

  if (!adapter || typeof adapter.payout !== "function") {
    throw createError(500, `Adapter mobile money payout introuvable (${provider})`);
  }

  const payload = buildMobileMoneyPayoutPayload(transaction);
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

async function startMobileMoneyCollection({ req, transaction }) {
  const provider = String(
    transaction.provider ||
      transaction.metadata?.provider ||
      transaction.metadata?.externalSource?.operator ||
      transaction.operator ||
      "wave"
  )
    .trim()
    .toLowerCase();

  const adapter = getProviderAdapter({
    rail: "mobilemoney",
    provider,
  });

  if (!adapter || typeof adapter.collect !== "function") {
    throw createError(500, `Adapter mobile money collection introuvable (${provider})`);
  }

  const payload = buildMobileMoneyCollectionPayload(transaction);
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
  executeMobileMoneyPayout,
  startMobileMoneyCollection,
};