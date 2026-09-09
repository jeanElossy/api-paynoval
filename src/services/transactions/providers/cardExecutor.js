"use strict";

const createError = require("http-errors");
const { exigerMontant, exigerDevise } = require("../../../utils/montant");
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

    /** Règle B.2 — voir `utils/montant.js`. Absent ⇒ on ARRÊTE, pas 0. */
    amount: exigerMontant(
      tx.amountTarget ?? tx.localAmount,
      "card.payout.amount"
    ),
    currency: exigerDevise(
      tx.currencyTarget ?? tx.localCurrencySymbol,
      "card.payout.currency"
    ),

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
  // Défaut « stripe » remplacé le 2026-09-08 — voir `providerExecutorRegistry`.
  const provider = String(tx.provider || "visa_direct").trim().toLowerCase();

  return {
    txReference: tx.reference,
    reference: tx.reference,
    idempotencyKey: tx.idempotencyKey || tx.reference,
    providerReference: tx.providerReference || null,
    flow: tx.flow,
    provider,

    /** Règle B.2 — voir `utils/montant.js`. */
    amount: exigerMontant(
      tx.amountSource ?? tx.amount,
      "card.topup.amount"
    ),
    currency: exigerDevise(
      tx.currencySource ?? tx.senderCurrencySymbol,
      "card.topup.currency"
    ),

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
    /**
     * ⚠️ `ok` DOIT REMONTER — c'est le verdict du prestataire.
     *
     * Il ne remontait pas : l'exécuteur ne rendait que `providerStatus`,
     * `providerReference` et `raw`. Le handler écrivait alors
     * `pending → processing` SANS CONDITION, y compris sur un refus explicite.
     * Une transaction carte refusée restait « en cours », fonds immobilisés
     * chez l'expéditeur, jusqu'au `SETTLEMENT_TIMEOUT` de 6 h — alors que
     * l'information était disponible à la milliseconde.
     *
     * Sur ce rail le cas n'est pas marginal : `visaDirectAdapter` refuse TOUT
     * encaissement tant que `VISA_DIRECT_COLLECT_ENABLED` n'est pas posée, par
     * `failResult`. Tout dépôt par carte empruntait donc ce chemin.
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

async function startCardTopup({ req, transaction }) {
  // Défaut « stripe » remplacé le 2026-09-08 : l'adapter n'existe plus.
  const provider = String(transaction.provider || "visa_direct").trim().toLowerCase();

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
    /** Voir `executeCardPayout` : le verdict du prestataire doit remonter. */
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
  executeCardPayout,
  startCardTopup,
};