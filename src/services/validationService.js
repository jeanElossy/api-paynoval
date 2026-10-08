// src/services/validationService.js
'use strict';

const mongoose = require('mongoose');
const createError = require('http-errors');
const { getTxConn } = require('../config/db');

/**
 * Résolution PARESSEUSE du modèle.
 *
 * Ce fichier faisait `require('../models/Transaction')(getTxConn())` au premier
 * niveau. `getTxConn()` lève tant que `connectTransactionsDB()` n'a pas tourné :
 * charger ce module dans un test était donc impossible, et par ricochet tout
 * contrôleur qui en dépend.
 *
 * C'est le même défaut que celui corrigé dans `src/config.js`, une couche plus
 * bas : une dépendance d'entrée/sortie résolue à l'import. La règle est la même
 * — on résout au premier usage, dans le handler, jamais au chargement.
 */
let _Transaction = null;

function getTransactionModel() {
  if (!_Transaction) {
    _Transaction = require('../models/Transaction')(getTxConn());
  }

  return _Transaction;
}

function isEmailLike(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return parseFloat(x.toFixed(2));
}

function dec2(n) {
  return mongoose.Types.Decimal128.fromString(round2(n).toFixed(2));
}

/**
 * Valide la cohérence du montant et du statut d'une transaction (anti-manip).
 */
async function validateTransactionAmount(txData, opts = {}) {
  const { min = 0.01, max = 1000000 } = opts;

  const amt = Number(txData.amount);
  if (!amt || Number.isNaN(amt) || amt < min) {
    throw createError(400, `Montant invalide (min: ${min})`);
  }
  if (amt > max) {
    throw createError(400, `Montant trop élevé (max: ${max})`);
  }
}

/**
 * Vérifie la cohérence des statuts pour update
 */
function validateTransactionStatusChange(current, next) {
  const allowed = {
    pending: ['confirmed', 'cancelled'],
    confirmed: [],
    cancelled: [],
    refunded: [],
    relaunch: [],
    rejected: [],
  };
  if (!allowed[current] || !allowed[current].includes(next)) {
    throw createError(400, `Changement de statut interdit (${current} → ${next})`);
  }
}

/**
 * Détection basique de doublon / fraude : même INITIATEUR, même flow, même
 * montant, même devise dans une fenêtre courte (2 min) — et, pour un virement
 * interne, même destinataire.
 *
 * ⚠️ CORRIGÉ LE 2026-10-08. La version précédente exigeait un `sender`
 * ObjectId et un `receiverEmail` au format e-mail :
 *   - un DÉPÔT lui passait le numéro du payeur externe comme `sender` :
 *     « Sender invalide pour anti-fraude » à CHAQUE dépôt ;
 *   - un RETRAIT ou un transfert vers mobile money lui passait le numéro du
 *     bénéficiaire comme `receiverEmail` : « receiverEmail invalide » à chaque
 *     fois.
 * Aucune opération externe ne pouvait aboutir. L'initiateur est désormais
 * toujours le COMPTE PayNoval à l'origine (l'expéditeur d'un envoi, le
 * titulaire d'un dépôt) ; la contrepartie externe (numéro, carte) n'est pas un
 * champ interrogeable de la transaction, le flow la remplace. Le double appui
 * reste couvert par la clé d'idempotence (`middleware/idempotency.js`).
 *
 * Échoue en FERMETURE sur une entrée illisible (règle B.2).
 */
async function detectBasicFraud({
  initiator,
  sender,
  receiver,
  receiverEmail,
  flow,
  amount,
  currency,
  windowMinutes = 2,
  Model = null,
}) {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);
  const initiatorId = String(initiator || sender || '').trim();

  if (!initiatorId || !mongoose.Types.ObjectId.isValid(initiatorId)) {
    throw createError(400, 'Initiateur invalide pour anti-fraude');
  }

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw createError(400, 'Montant invalide pour anti-fraude');
  }

  const query = {
    $or: [{ userId: initiatorId }, { sender: initiatorId }],
    senderCurrencySymbol: String(currency || '').trim(),
    amount: dec2(amt), // match exact 2 décimales (cohérent avec Decimal128)
    createdAt: { $gte: since },
  };

  if (flow) query.flow = String(flow);

  const email = receiverEmail ? String(receiverEmail).trim().toLowerCase() : null;

  if (email && isEmailLike(email)) {
    query.recipientEmail = email;
  } else if (receiver && mongoose.Types.ObjectId.isValid(String(receiver).trim())) {
    query.receiver = String(receiver).trim();
  } else if (!flow) {
    // Sans contrepartie NI flow, la requête comparerait tout et n'importe quoi.
    throw createError(400, 'Contrepartie ou flow requis pour anti-fraude');
  }

  const TransactionModel = Model || getTransactionModel();
  const tx = await TransactionModel.findOne(query).sort({ createdAt: -1 }).lean();
  if (tx) {
    throw createError(429, 'Transaction similaire détectée récemment (possible doublon/fraude)');
  }
}

async function runPartnerVerificationHook(_txData) {
  return { success: true, score: 1.0 };
}

module.exports = {
  validateTransactionAmount,
  validateTransactionStatusChange,
  detectBasicFraud,
  runPartnerVerificationHook,
};
