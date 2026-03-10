"use strict";

const createError = require("http-errors");
const { getProviderAdapter } = require("./providerSelector");

function buildBankPayoutPayload(tx) {
  const md = tx.metadata || {};
  const ext = md.externalRecipient || {};
  const provider = String(tx.provider || "bank_generic").trim().toLowerCase();

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
      name: ext.accountHolder || tx.nameDestinataire || null,
      iban: ext.iban || null,
      swift: ext.swift || null,
      bankName: ext.bankName || null,
      accountNumber: ext.accountNumber || null,
      bankCode: ext.bankCode || null,
      country: ext.country || tx.countryDest || null,
    },

    iban: ext.iban || null,
    swift: ext.swift || null,
    bankAccountName: ext.accountHolder || tx.nameDestinataire || null,
    bankCode: ext.bankCode || null,
    accountNumber: ext.accountNumber || null,

    sender: {
      id: tx.sender ? String(tx.sender) : null,
      email: tx.senderEmail || null,
      name: tx.senderName || null,
    },

    description: tx.description || "PayNoval bank payout",

    metadata: {
      ...(md || {}),
      provider,
      rail: "bank",
      txCoreReference: tx.reference,
      txCoreTransactionId: String(tx._id),
    },

    tx,
  };
}

function buildBankCollectionPayload(tx) {
  const md = tx.metadata || {};
  const ext = md.externalSource || {};
  const provider = String(tx.provider || "bank_generic").trim().toLowerCase();

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
      name: ext.accountHolder || tx.senderName || null,
      iban: ext.iban || null,
      swift: ext.swift || null,
      bankName: ext.bankName || null,
      accountNumber: ext.accountNumber || null,
      bankCode: ext.bankCode || null,
      country: ext.country || tx.countrySource || null,
    },

    iban: ext.iban || null,
    swift: ext.swift || null,
    bankAccountName: ext.accountHolder || tx.senderName || null,
    bankCode: ext.bankCode || null,
    accountNumber: ext.accountNumber || null,

    receiver: {
      id: tx.receiver ? String(tx.receiver) : null,
      email: tx.recipientEmail || null,
      name: tx.nameDestinataire || null,
    },

    description: tx.description || "PayNoval bank collection",

    metadata: {
      ...(md || {}),
      provider,
      rail: "bank",
      txCoreReference: tx.reference,
      txCoreTransactionId: String(tx._id),
    },

    tx,
  };
}

async function executeBankPayout({ req, transaction }) {
  const provider = String(transaction.provider || "bank_generic").trim().toLowerCase();

  const adapter = getProviderAdapter({
    rail: "bank",
    provider,
  });

  if (!adapter || typeof adapter.payout !== "function") {
    throw createError(500, `Adapter bank payout introuvable (${provider})`);
  }

  const payload = buildBankPayoutPayload(transaction);
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

async function startBankCollection({ req, transaction }) {
  const provider = String(transaction.provider || "bank_generic").trim().toLowerCase();

  const adapter = getProviderAdapter({
    rail: "bank",
    provider,
  });

  if (!adapter || typeof adapter.collect !== "function") {
    throw createError(500, `Adapter bank collection introuvable (${provider})`);
  }

  const payload = buildBankCollectionPayload(transaction);
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
  executeBankPayout,
  startBankCollection,
};