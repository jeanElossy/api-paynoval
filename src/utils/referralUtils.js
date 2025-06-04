// File: src/utils/referralUtils.js

const mongoose           = require('mongoose');
const axios              = require('axios');
const { customAlphabet } = require('nanoid');
const config             = require('../config');

// Générateur nanoid à 6 caractères alphanumériques
const nanoid = customAlphabet(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  6
);

// Liste des pays Europe/USA vs Afrique
const EUROPE_USA_COUNTRIES = ['Canada', 'USA', 'France', 'Belgique', 'Allemagne'];
const AFRICA_COUNTRIES     = ['Côte d’Ivoire', 'Mali', 'Burkina Faso', 'Sénégal', 'Cameroun'];

// URL de base du backend principal (défini dans .env)
const PRINCIPAL_URL = config.principalUrl;

/**
 * Retourne le modèle Transaction associé à la base “api_transactions_paynoval”.
 * On récupère la connexion via getTxConn(), comme dans vos contrôleurs.
 */
function TransactionModel() {
  const { getTxConn } = require('../config/db');
  return getTxConn().model('Transaction');
}

/**
 * Récupère un utilisateur depuis le backend principal (service “users”).
 */
async function fetchUserFromMain(userId) {
  const url = `${PRINCIPAL_URL}/api/v1/users/${userId}`;
  const response = await axios.get(url);
  return response.data.data;
}

/**
 * Met à jour un user (PATCH) dans le backend principal.
 */
async function patchUserInMain(userId, updates) {
  const url = `${PRINCIPAL_URL}/api/v1/users/${userId}`;
  await axios.patch(url, updates);
}

/**
 * Crédite la balance d’un user dans le backend principal.
 * Attention : l’URL doit correspondre à votre route POST “balances” côté service “users”.
 */
async function creditBalanceInMain(userId, amount, currency, description) {
  const url = `${PRINCIPAL_URL}/api/v1/balances/${userId}/credit`;
  await axios.post(url, { amount, currency, description });
}

/**
 * Vérifie si le sender a atteint 2 transactions “confirmed” internes,
 * et, le cas échéant, génère son referralCode dans le backend principal.
 */
async function checkAndGenerateReferralCodeInMain(senderId, sessionMongoose) {
  // 1) Compter les transactions “confirmed” émises par sender
  const txCount = await TransactionModel()
    .countDocuments({
      sender: senderId,
      status: 'confirmed'
    })
    .session(sessionMongoose);

  if (txCount < 2) {
    return;
  }

  // 2) Charger l’utilisateur dans le backend principal
  const userMain = await fetchUserFromMain(senderId);
  if (!userMain || userMain.hasGeneratedReferral) {
    return;
  }

  // 3) Générer un code unique
  const baseName     = userMain.fullName.replace(/\s+/g, '').toUpperCase();
  const randomSuffix = nanoid();
  const newCode      = `${baseName}_${randomSuffix}`;

  // 4) Patch dans le backend principal
  await patchUserInMain(senderId, {
    referralCode:        newCode,
    hasGeneratedReferral: true
  });
}

/**
 * Vérifie si la 1ʳᵉ transaction “confirmed” du receiver est
 * éligible pour bonus, puis crédite la balance du filleul + du parrain.
 */
async function processReferralBonusIfEligible(receiverId, tx, sessionMongoose) {
  // 1) Vérifier que c’est la PREMIÈRE transaction “confirmed” du receiver
  const confirmedCount = await TransactionModel()
    .countDocuments({
      receiver: receiverId,
      status: 'confirmed'
    })
    .session(sessionMongoose);

  if (confirmedCount !== 1) {
    return;
  }

  // 2) Charger receiver dans le backend principal
  const receiverMain = await fetchUserFromMain(receiverId);
  if (!receiverMain || !receiverMain.referredBy) {
    return;
  }

  // 3) Charger le parrain
  const parrainId   = receiverMain.referredBy;
  const parrainMain = await fetchUserFromMain(parrainId);
  if (!parrainMain) {
    return;
  }

  // 4) Déterminer seuil & bonus selon pays du filleul et du parrain
  const paysReceiver = receiverMain.country;
  const paysParrain  = parrainMain.country;

  let montantRequis,
      bonusReceiver,
      bonusParrain,
      currencyReceiver,
      currencyParrain;

  // Cas Europe/USA tous les deux
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
  // Cas Afrique tous les deux
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
  // Cas cross‐continent
  else {
    // Filleul en Europe/USA
    if (EUROPE_USA_COUNTRIES.includes(paysReceiver)) {
      montantRequis    = 100;
      bonusReceiver    = 5;
      currencyReceiver = ['France','Belgique','Allemagne'].includes(paysReceiver) ? 'EUR' : 'USD';
    }
    // Filleul en Afrique
    else if (AFRICA_COUNTRIES.includes(paysReceiver)) {
      montantRequis    = 20000;
      bonusReceiver    = 500;
      currencyReceiver = 'XOF';
    } else {
      return;
    }

    // Parrain en Europe/USA
    if (EUROPE_USA_COUNTRIES.includes(paysParrain)) {
      bonusParrain    = 5;
      currencyParrain = ['France','Belgique','Allemagne'].includes(paysParrain) ? 'EUR' : 'USD';
    }
    // Parrain en Afrique
    else if (AFRICA_COUNTRIES.includes(paysParrain)) {
      bonusParrain    = 500;
      currencyParrain = 'XOF';
    } else {
      return;
    }
  }

  // 5) Ne verser le bonus que si le montant de la transaction >= montantRequis
  if (parseFloat(tx.amount.toString()) < montantRequis) {
    return;
  }

  // 6) Créditer la balance du filleul dans le backend principal
  await creditBalanceInMain(
    receiverId,
    bonusReceiver,
    currencyReceiver,
    'Bonus de parrainage reçu'
  );

  // 7) Créditer la balance du parrain dans le backend principal
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
