// src/services/transactions.js
'use strict';

const mongoose = require('mongoose');
const User = require('../models/User');
const Balance = require('../models/Balance');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decimal128 safe (2 décimales) - utile car Balance.amount est souvent en Decimal128
 */
function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return parseFloat(x.toFixed(2));
}

function dec2(n) {
  return mongoose.Types.Decimal128.fromString(round2(n).toFixed(2));
}

function withSessionOpts(opts = {}) {
  return opts && opts.session ? { session: opts.session } : {};
}

/**
 * Trouver un utilisateur par email (case insensitive)
 */
async function findUserByEmail(email, opts = {}) {
  const e = normalizeEmail(email);
  if (!e) throw new Error('Email requis');

  // ✅ Regex safe (anti injection regex)
  const re = new RegExp(`^${escapeRegex(e)}$`, 'i');

  return User.findOne({ email: { $regex: re } })
    .lean()
    .session(opts.session || null);
}

/**
 * Récupérer la balance d'un utilisateur par son ID
 */
async function findBalanceByUserId(userId, opts = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(userId))) throw new Error('userId invalide');

  return Balance.findOne({ user: userId })
    .session(opts.session || null);
}

/**
 * Débiter un utilisateur (retourne la nouvelle balance, gestion atomique)
 * ✅ Session supportée
 * ✅ Comparaison sur Decimal128 (2 décimales)
 */
async function debitUser(userId, amount, reason = '', opts = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(userId))) throw new Error('userId invalide');

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Montant invalide');

  const decAmt = dec2(amt);

  // ✅ Atomique : ne débite que si solde >= montant
  const balance = await Balance.findOneAndUpdate(
    { user: userId, amount: { $gte: decAmt } },
    { $inc: { amount: decAmt.negate ? decAmt.negate() : dec2(-amt) } }, // compat (Decimal128 n’a pas negate partout)
    { new: true, ...withSessionOpts(opts) }
  );

  if (!balance) {
    throw new Error('Solde insuffisant ou utilisateur introuvable');
  }

  // Audit optionnel: reason, opts.context, etc.
  return balance;
}

/**
 * Créditer un utilisateur par email (retourne la nouvelle balance)
 * ✅ Session supportée
 */
async function creditUserByEmail(email, amount, reason = '', opts = {}) {
  const e = normalizeEmail(email);
  if (!e) throw new Error('Email requis');

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Montant invalide');

  const user = await findUserByEmail(e, opts);
  if (!user) throw new Error('Destinataire introuvable');

  const decAmt = dec2(amt);

  const balance = await Balance.findOneAndUpdate(
    { user: user._id },
    { $inc: { amount: decAmt } },
    { new: true, upsert: true, setDefaultsOnInsert: true, ...withSessionOpts(opts) }
  );

  if (!balance) throw new Error('Erreur crédit balance destinataire');

  return balance;
}

/**
 * Transfert interne (débit + crédit) avec transaction Mongo atomique
 * ✅ Les opérations utilisent VRAIMENT la session
 */
async function transfer(fromUserId, toEmail, amount, context = {}) {
  const session = await mongoose.startSession();

  try {
    // ✅ withTransaction gère mieux certains cas et garantit abort/commit
    await session.withTransaction(async () => {
      await debitUser(fromUserId, amount, 'Virement interne', { session, context });
      await creditUserByEmail(toEmail, amount, 'Virement interne', { session, context });
    });

    return true;
  } finally {
    session.endSession();
  }
}

module.exports = {
  findUserByEmail,
  findBalanceByUserId,
  debitUser,
  creditUserByEmail,
  transfer,
};
