// services/balance.js

const Balance = require('../models/Balance');

// Récupérer le solde
async function getUserBalance(userId) {
  return Balance.findOne({ user: userId });
}

// Débiter le solde
async function debitUserBalance(userId, amount) {
  const balance = await Balance.findOne({ user: userId });
  if (!balance) throw new Error('Balance introuvable');
  if (balance.amount < amount) throw new Error('Solde insuffisant');
  balance.amount -= amount;
  await balance.save();
  return balance;
}

// Créditer le solde
async function creditUserBalance(userId, amount) {
  const balance = await Balance.findOne({ user: userId });
  if (!balance) throw new Error('Balance introuvable');
  balance.amount += amount;
  await balance.save();
  return balance;
}

module.exports = {
  getUserBalance,
  debitUserBalance,
  creditUserBalance,
};
