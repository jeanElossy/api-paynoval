// src/services/validationService.js
'use strict';

const mongoose = require('mongoose');
const createError = require('http-errors');
const { getTxConn } = require('../config/db');
const Transaction = require('../models/Transaction')(getTxConn());

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
 * Détection basique de fraude / doublon:
 * - Même expéditeur, même destinataire, même montant, même devise, dans une fenêtre courte.
 *
 * ✅ FIX IMPORTANT:
 * - receiver peut être un ObjectId OU un email.
 * - Si email => on filtre sur recipientEmail (string), PAS sur receiver (ObjectId).
 */
async function detectBasicFraud({
  sender,
  receiver,
  receiverEmail,
  amount,
  currency,
  windowMinutes = 2,
}) {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);

  if (!sender || !mongoose.Types.ObjectId.isValid(String(sender))) {
    throw createError(400, 'Sender invalide pour anti-fraude');
  }

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw createError(400, 'Montant invalide pour anti-fraude');
  }

  const query = {
    sender: String(sender),
    senderCurrencySymbol: String(currency || '').trim(),
    amount: dec2(amt), // match exact 2 décimales (cohérent avec Decimal128)
    createdAt: { $gte: since },
  };

  // Priorité: receiverEmail
  const email = receiverEmail ? String(receiverEmail).trim().toLowerCase() : null;

  if (email) {
    if (!isEmailLike(email)) {
      throw createError(400, 'receiverEmail invalide pour anti-fraude');
    }
    query.recipientEmail = email;
  } else if (receiver) {
    const r = String(receiver).trim();
    if (mongoose.Types.ObjectId.isValid(r)) {
      query.receiver = r;
    } else if (isEmailLike(r)) {
      query.recipientEmail = r.toLowerCase();
    } else {
      throw createError(400, 'receiver invalide pour anti-fraude');
    }
  } else {
    throw createError(400, 'receiver ou receiverEmail requis pour anti-fraude');
  }

  const tx = await Transaction.findOne(query).sort({ createdAt: -1 }).lean();
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
