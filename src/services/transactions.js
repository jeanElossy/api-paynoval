// src/services/transactions.js
"use strict";

const mongoose = require("mongoose");
const { getUsersConn, getTxConn } = require("../config/db");

const usersConn = getUsersConn();
const txConn = getTxConn();

const User = require("../models/User")(usersConn);
const TxWalletBalance = require("../models/TxWalletBalance")(txConn);


const findBalanceByUserId = findWalletByUserId;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}



function escapeRegex(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCurrency(currency) {
  const cur = String(currency || "").trim().toUpperCase();
  if (!cur || cur.length < 3 || cur.length > 6) {
    throw new Error("Devise invalide");
  }
  return cur;
}

function withSessionOpts(opts = {}) {
  return opts && opts.session ? { session: opts.session } : {};
}

/**
 * Trouver un utilisateur par email (case insensitive)
 */
async function findUserByEmail(email, opts = {}) {
  const e = normalizeEmail(email);
  if (!e) throw new Error("Email requis");

  const re = new RegExp(`^${escapeRegex(e)}$`, "i");

  let query = User.findOne({ email: { $regex: re } }).lean();
  if (opts.session) query = query.session(opts.session);
  return query;
}

/**
 * Récupérer le wallet d'un utilisateur par son ID et sa devise
 */
async function findWalletByUserId(userId, currency, opts = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(userId))) {
    throw new Error("userId invalide");
  }

  const cur = normalizeCurrency(currency);
  return TxWalletBalance.findWallet(userId, cur, withSessionOpts(opts));
}

/**
 * Débiter un utilisateur depuis son wallet TX Core
 */
async function debitUser(userId, currency, amount, reason = "", opts = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(userId))) {
    throw new Error("userId invalide");
  }

  const cur = normalizeCurrency(currency);
  const amt = Number(amount);

  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error("Montant invalide");
  }

  return TxWalletBalance.debit(userId, cur, amt, withSessionOpts(opts));
}

/**
 * Créditer un utilisateur par email sur son wallet TX Core
 */
async function creditUserByEmail(email, currency, amount, reason = "", opts = {}) {
  const e = normalizeEmail(email);
  if (!e) throw new Error("Email requis");

  const cur = normalizeCurrency(currency);
  const amt = Number(amount);

  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error("Montant invalide");
  }

  const user = await findUserByEmail(e, opts);
  if (!user) throw new Error("Destinataire introuvable");

  return TxWalletBalance.credit(user._id, cur, amt, withSessionOpts(opts));
}

/**
 * Transfert interne simple (débit + crédit) avec transaction Mongo atomique
 *
 * NOTE:
 * - cette fonction crédite le même montant dans la même devise
 * - pour un transfert FX, il faut un service métier supérieur qui calcule
 *   amountSource / amountTarget et appelle séparément debit/credit
 */
async function transfer(fromUserId, toEmail, currency, amount, context = {}) {
  const cur = normalizeCurrency(currency);
  const amt = Number(amount);

  if (!mongoose.Types.ObjectId.isValid(String(fromUserId))) {
    throw new Error("fromUserId invalide");
  }
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error("Montant invalide");
  }

  const session = await txConn.startSession();

  try {
    await session.withTransaction(async () => {
      await debitUser(fromUserId, cur, amt, "Virement interne", { session, context });
      await creditUserByEmail(toEmail, cur, amt, "Virement interne", { session, context });
    });

    return true;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  findUserByEmail,
  findWalletByUserId,
  findBalanceByUserId: findWalletByUserId,
  debitUser,
  creditUserByEmail,
  transfer,
};