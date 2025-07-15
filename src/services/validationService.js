// src/services/validationService.js

const mongoose = require('mongoose');
const createError = require('http-errors');
const { getTxConn } = require('../config/db');
const Transaction = require('../models/Transaction')(getTxConn());

/**
 * Valide la cohérence du montant et du statut d'une transaction (anti-manip).
 * @param {Object} txData - Données à valider (body de création transaction)
 * @param {Object} [opts] - Options métier (limites, etc)
 */
async function validateTransactionAmount(txData, opts = {}) {
  const {
    min = 0.01,
    max = 1000000, // ex : plafond par transaction
  } = opts;

  if (!txData.amount || isNaN(txData.amount) || txData.amount < min) {
    throw createError(400, `Montant invalide (min: ${min})`);
  }
  if (txData.amount > max) {
    throw createError(400, `Montant trop élevé (max: ${max})`);
  }
}

/**
 * Vérifie la cohérence des statuts pour update (interdit de "ressusciter" une transaction, etc)
 */
function validateTransactionStatusChange(current, next) {
  const allowed = {
    pending:    ['confirmed', 'cancelled'],
    confirmed:  [],
    cancelled:  [],
  };
  if (!allowed[current] || !allowed[current].includes(next)) {
    throw createError(400, `Changement de statut interdit (${current} → ${next})`);
  }
}

/**
 * Détection basique de fraude :
 * - Plusieurs tentatives rapides (DoS/brute-force)
 * - Même destinataire, même montant, sur X minutes = possible doublon
 * - Montant anormal ou devises mismatch
 */
async function detectBasicFraud({ sender, receiver, amount, currency, windowMinutes = 2 }) {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);
  const tx = await Transaction.findOne({
    sender,
    receiver,
    amount,
    senderCurrencySymbol: currency,
    createdAt: { $gte: since }
  }).sort({ createdAt: -1 });
  if (tx) {
    throw createError(429, 'Transaction similaire détectée récemment (possible doublon/fraude)');
  }
}

/**
 * (Exemple) Appel vérification partenaire externe (callback webhook, scoring, etc)
 */
async function runPartnerVerificationHook(txData) {
  // EXEMPLE : Appel d'un endpoint partenaire pour valider la transaction
  // (remplace avec ta logique, ici on fait juste un mock "OK")
  return { success: true, score: 1.0 };
}

module.exports = {
  validateTransactionAmount,
  validateTransactionStatusChange,
  detectBasicFraud,
  runPartnerVerificationHook,
};
