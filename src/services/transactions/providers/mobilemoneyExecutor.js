"use strict";

const createError = require("http-errors");
const { exigerMontant, exigerDevise } = require("../../../utils/montant");
const { getProviderAdapter } = require("../../../providers/providerSelector");

function buildMobileMoneyPayoutPayload(tx) {
  const md = tx.metadata || {};
  const ext = md.externalRecipient || {};

  return {
    txReference: tx.reference,
    reference: tx.reference,
    idempotencyKey: tx.idempotencyKey || tx.reference,
    providerReference: tx.providerReference || null,
    flow: tx.flow,

    /** Règle B.2 — voir `utils/montant.js`. Absent ⇒ on ARRÊTE, pas 0. */
    amount: exigerMontant(
      tx.amountTarget ?? tx.localAmount,
      "mobilemoney.payout.amount"
    ),
    currency: exigerDevise(
      tx.currencyTarget ?? tx.localCurrencySymbol,
      "mobilemoney.payout.currency"
    ),

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
      /**
       * Pas de repli `|| "wave"` : voir `providerExecutorRegistry`. Un
       * opérateur non résolu doit lever en amont, pas être choisi ici.
       */
      provider: tx.provider || md.provider || ext.operator || null,
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

    /** Règle B.2 — voir `utils/montant.js`. */
    amount: exigerMontant(
      tx.amountSource ?? tx.amount,
      "mobilemoney.collect.amount"
    ),
    currency: exigerDevise(
      tx.currencySource ?? tx.senderCurrencySymbol,
      "mobilemoney.collect.currency"
    ),

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
      /**
       * Pas de repli `|| "wave"` : voir `providerExecutorRegistry`. Un
       * opérateur non résolu doit lever en amont, pas être choisi ici.
       */
      provider: tx.provider || md.provider || ext.operator || null,
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
    /**
     * ⚠️ `ok` DOIT REMONTER — c'est le verdict de l'opérateur.
     *
     * Il ne remontait pas. Le handler écrivait `pending → processing` sans
     * condition, y compris sur un refus explicite : la transaction restait
     * « en cours », fonds immobilisés, jusqu'au `SETTLEMENT_TIMEOUT` de 6 h
     * (`services/reconciliation/providerReconciliationRules.js`), alors que
     * l'opérateur avait déjà répondu non.
     */
    ok: result?.ok !== false,
    /**
     * `mock` remonte du bloc simulé de l'adapter (`raw.mock`). Sans lui,
     * une référence prestataire FABRIQUÉE est indiscernable d'une vraie
     * sur le document de transaction — même champ, même index. Un
     * booléen normalisé ne porte aucune donnée personnelle : il a sa
     * place dans la liste blanche de `sanitizeExecutionResult`.
     */
    mock: result?.raw?.mock === true || result?.mock === true,
    errorCode: result?.errorCode || null,
    errorMessage: result?.errorMessage || result?.message || null,

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
    /** Voir `executeMobileMoneyPayout` : le verdict de l'opérateur remonte. */
    ok: result?.ok !== false,
    /**
     * `mock` remonte du bloc simulé de l'adapter (`raw.mock`). Sans lui,
     * une référence prestataire FABRIQUÉE est indiscernable d'une vraie
     * sur le document de transaction — même champ, même index. Un
     * booléen normalisé ne porte aucune donnée personnelle : il a sa
     * place dans la liste blanche de `sanitizeExecutionResult`.
     */
    mock: result?.raw?.mock === true || result?.mock === true,
    errorCode: result?.errorCode || null,
    errorMessage: result?.errorMessage || result?.message || null,

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