// src/services/transactions.js

const mongoose = require('mongoose');
const User = require('../models/User')
const Balance = require('../models/Balance');

/**
 * Trouver un utilisateur par email (case insensitive)
 */
async function findUserByEmail(email) {
  if (!email) throw new Error('Email requis');
  return User.findOne({ email: { $regex: new RegExp(`^${email}$`, 'i') } }).lean();
}

/**
 * Récupérer la balance d'un utilisateur par son ID
 */
async function findBalanceByUserId(userId) {
  if (!mongoose.Types.ObjectId.isValid(userId)) throw new Error('userId invalide');
  return Balance.findOne({ user: userId });
}

/**
 * Débiter un utilisateur (retourne la nouvelle balance, gestion atomique)
 */
async function debitUser(userId, amount, reason = '', context = {}) {
  if (!mongoose.Types.ObjectId.isValid(userId)) throw new Error('userId invalide');
  if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) throw new Error('Montant invalide');
  // On vérifie d'abord le solde de façon atomique pour éviter les race conditions
  const balance = await Balance.findOneAndUpdate(
    { user: userId, amount: { $gte: amount } },
    { $inc: { amount: -amount } },
    { new: true }
  );
  if (!balance) throw new Error('Solde insuffisant ou utilisateur introuvable');
  // Audit optionnel : tu peux logger ici
  return balance;
}

/**
 * Créditer un utilisateur par email (retourne la nouvelle balance)
 */
async function creditUserByEmail(email, amount, reason = '', context = {}) {
  if (!email) throw new Error('Email requis');
  if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) throw new Error('Montant invalide');
  const user = await findUserByEmail(email);
  if (!user) throw new Error('Destinataire introuvable');
  const balance = await Balance.findOneAndUpdate(
    { user: user._id },
    { $inc: { amount } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  if (!balance) throw new Error('Erreur crédit balance destinataire');
  // Audit optionnel
  return balance;
}

/**
 * Fonction de transfert interne (transaction MongoDB atomique)
 */
async function transfer(fromUserId, toEmail, amount, context = {}) {
  // Utilise une session pour garantir l'atomicité du débit/crédit
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await debitUser(fromUserId, amount, 'Virement interne', { ...context, session });
    await creditUserByEmail(toEmail, amount, 'Virement interne', { ...context, session });
    await session.commitTransaction();
    session.endSession();
    return true;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

module.exports = {
  findUserByEmail,
  findBalanceByUserId,
  debitUser,
  creditUserByEmail,
  transfer,
};
