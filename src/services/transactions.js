// src/services/transactions.js

const User = require('../models/User')();
const Balance = require('../models/Balance');

// Trouver un utilisateur par email
async function findUserByEmail(email) {
  return User.findOne({ email });
}

// Récupérer la balance d'un user
async function findBalanceByUserId(userId) {
  return Balance.findOne({ user: userId });
}

// Débiter un utilisateur (renvoie la balance MAJ)
async function debitUser(userId, amount, reason = '', context = {}) {
  const balance = await findBalanceByUserId(userId);
  if (!balance) throw new Error('Solde introuvable');
  if (balance.amount < amount) throw new Error('Solde insuffisant');
  balance.amount -= amount;
  await balance.save();
  // Audit transaction optionnel : laisse la route/pay.js créer la Transaction complète
  return balance;
}

// Créditer un utilisateur par email (renvoie la balance MAJ)
async function creditUserByEmail(email, amount, reason = '', context = {}) {
  const user = await findUserByEmail(email);
  if (!user) throw new Error('Destinataire introuvable');
  const balance = await findBalanceByUserId(user._id);
  if (!balance) throw new Error('Balance destinataire introuvable');
  balance.amount += amount;
  await balance.save();
  // Audit transaction optionnel : laisse la route/pay.js créer la Transaction complète
  return balance;
}

// Fonction de transfert interne (tout-en-un)
async function transfer(fromUserId, toEmail, amount, context = {}) {
  await debitUser(fromUserId, amount, 'Virement interne', context);
  await creditUserByEmail(toEmail, amount, 'Virement interne', context);
  return true;
}

module.exports = {
  findUserByEmail,
  findBalanceByUserId,
  debitUser,
  creditUserByEmail,
  transfer, // Pour un transfert interne
};
