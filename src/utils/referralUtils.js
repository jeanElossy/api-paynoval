// File: src/utils/referralUtils.js

const Transaction = require('../models/Transaction');
const mongoose    = require('mongoose');
const axios       = require('axios');
const { customAlphabet } = require('nanoid');
const config          = require('../config');

const nanoid = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 6);

// Liste des pays Europe/USA vs Afrique
const EUROPE_USA_COUNTRIES = ['Canada', 'USA', 'France', 'Belgique', 'Allemagne'];
const AFRICA_COUNTRIES     = ['Côte d’Ivoire', 'Mali', 'Burkina Faso', 'Senegal', 'Cameroun'];

// URL de base du backend principal (défini dans .env)
const PRINCIPAL_URL = config.principalUrl; // URL du backend principal

/**
 * Récupère un utilisateur depuis le backend principal
 */
async function fetchUserFromMain(userId) {
  const url = `${PRINCIPAL_URL}/users/${userId}`;
  const response = await axios.get(url);
  return response.data.data;
}

/**
 * Met à jour un user (patch) dans le backend principal
 */
async function patchUserInMain(userId, updates) {
  const url = `${PRINCIPAL_URL}/users/${userId}`;
  await axios.patch(url, updates);
}

/**
 * Crédite la balance d’un user dans le backend principal
 */
async function creditBalanceInMain(userId, amount, currency, description) {
  const url = `${USER_API_BASE_URL}/balances/${userId}/credit`;
  await axios.post(url, { amount, currency, description });
}

/**
 * Vérifie si le sender a atteint 2 transactions internes,
 * et, le cas échéant, génère son referralCode dans le backend principal.
 */
async function checkAndGenerateReferralCodeInMain(senderId, sessionMongoose) {
  // 1) Compter les transactions internes émises par sender (dans cette base)
  const count = await Transaction.countDocuments({
    sender: senderId,
    receiver: { $exists: true }
  }).session(sessionMongoose);

  if (count < 2) return;

  // 2) Charger l’utilisateur dans le backend principal
  const userMain = await fetchUserFromMain(senderId);
  if (!userMain || userMain.hasGeneratedReferral) return;

  // 3) Générer un code unique
  const base = userMain.fullName.replace(/\s+/g, '').toUpperCase();
  const randomSuffix = nanoid();
  const newCode = `${base}_${randomSuffix}`;

  // 4) Patch dans le backend principal
  await patchUserInMain(senderId, {
    referralCode: newCode,
    hasGeneratedReferral: true
  });
}

/**
 * Vérifie si la 1ʳᵉ transaction de receiver est éligible pour bonus,
 * et, si oui, crédite la balance du filleul + du parrain.
 */
async function processReferralBonusIfEligible(receiverId, tx, sessionMongoose) {
  // 1) Vérifier que c’est la 1ʳᵉ transaction interne du receiver (dans cette base)
  const countTx = await Transaction.countDocuments({
    sender: receiverId,
    receiver: { $exists: true }
  }).session(sessionMongoose);
  if (countTx !== 1) return;

  // 2) Charger receiver dans le backend principal
  const receiverMain = await fetchUserFromMain(receiverId);
  if (!receiverMain || !receiverMain.referredBy) return;

  // 3) Charger le parrain
  const parrainId   = receiverMain.referredBy;
  const parrainMain = await fetchUserFromMain(parrainId);
  if (!parrainMain) return;

  // 4) Déterminer seuil & bonus selon pays
  const paysReceiver = receiverMain.country;
  const paysParrain  = parrainMain.country;

  let montantRequis, bonusReceiver, bonusParrain, currencyReceiver, currencyParrain;

  if (
    EUROPE_USA_COUNTRIES.includes(paysReceiver) &&
    EUROPE_USA_COUNTRIES.includes(paysParrain)
  ) {
    montantRequis    = 100;
    bonusReceiver    = 5;
    bonusParrain     = 5;
    currencyReceiver = ['France','Belgique','Allemagne'].includes(paysReceiver) ? 'EUR' : 'USD';
    currencyParrain  = ['France','Belgique','Allemagne'].includes(paysParrain ) ? 'EUR' : 'USD';
  }
  else if (
    AFRICA_COUNTRIES.includes(paysReceiver) &&
    AFRICA_COUNTRIES.includes(paysParrain)
  ) {
    montantRequis    = 20000;
    bonusReceiver    = 500;
    bonusParrain     = 500;
    currencyReceiver = 'XOF';
    currencyParrain  = 'XOF';
  }
  else {
    // Cross‐continent
    if (EUROPE_USA_COUNTRIES.includes(paysReceiver)) {
      montantRequis    = 100;
      bonusReceiver    = 5;
      currencyReceiver = ['France','Belgique','Allemagne'].includes(paysReceiver) ? 'EUR' : 'USD';
    } else if (AFRICA_COUNTRIES.includes(paysReceiver)) {
      montantRequis    = 20000;
      bonusReceiver    = 500;
      currencyReceiver = 'XOF';
    } else return;

    if (EUROPE_USA_COUNTRIES.includes(paysParrain)) {
      bonusParrain    = 5;
      currencyParrain = ['France','Belgique','Allemagne'].includes(paysParrain) ? 'EUR' : 'USD';
    } else if (AFRICA_COUNTRIES.includes(paysParrain)) {
      bonusParrain    = 500;
      currencyParrain = 'XOF';
    } else return;
  }

  // 5) Ne verser le bonus que si tx.amount >= montantRequis
  if (parseFloat(tx.amount.toString()) < montantRequis) return;

  // 6) Créditer balance du filleul
  await creditBalanceInMain(
    receiverId,
    bonusReceiver,
    currencyReceiver,
    'Bonus de parrainage reçu'
  );

  // 7) Créditer balance du parrain
  await creditBalanceInMain(
    parrainId,
    bonusParrain,
    currencyParrain,
    `Bonus de parrainage pour avoir parrainé ${receiverMain.fullName}`
  );
}

module.exports = {
  checkAndGenerateReferralCodeInMain,
  processReferralBonusIfEligible
};
