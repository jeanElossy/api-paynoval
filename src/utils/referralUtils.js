// File: src/utils/referralUtils.js

const mongoose           = require('mongoose');
const axios              = require('axios');
const { customAlphabet } = require('nanoid');
const logger             = require('../utils/logger');
const config             = require('../config');

// Générateur nanoid à 6 caractères alphanumériques
const nanoid = customAlphabet(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  6
);

// Listes des pays Europe/USA vs Afrique (non accentués, apostrophe ASCII)
const EUROPE_USA_COUNTRIES = [
  'Canada',
  'USA',
  'France',
  'Belgique',
  'Allemagne'
];
const AFRICA_COUNTRIES = [
  'Cote d\'Ivoire',
  'Mali',
  'Burkina Faso',
  'Senegal',
  'Cameroun'
];

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
 * Normalise un nom de pays : retire accents et met apostrophe ASCII
 */
function normalizeCountry(str) {
  if (typeof str !== 'string') return '';
  // Décompose les caractères accentués, puis supprime les diacritiques
  const noAccents = str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  // Remplace apostrophe typographique par apostrophe ASCII
  return noAccents.replace(/’/g, "'").trim();
}

/**
 * Récupère un utilisateur depuis le backend principal (service “users”).
 * Renvoie `null` si non trouvé ou en cas d’erreur 404.
 */
async function fetchUserFromMain(userId) {
  try {
    const url = `${PRINCIPAL_URL}/api/v1/users/${userId}`;
    const response = await axios.get(url);
    return response.data.data || null;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return null;
    }
    logger.error(`Erreur fetchUserFromMain(${userId}) :`, err.response?.data || err.message);
    throw err;
  }
}

/**
 * Met à jour un user (PATCH) dans le backend principal.
 * Lance une exception si le patch échoue.
 */
async function patchUserInMain(userId, updates) {
  try {
    const url = `${PRINCIPAL_URL}/api/v1/users/${userId}`;
    await axios.patch(url, updates);
  } catch (err) {
    logger.error(`Erreur patchUserInMain(${userId}) avec updates=${JSON.stringify(updates)} :`,
      err.response?.data || err.message);
    throw err;
  }
}

/**
 * Crédite la balance d’un user dans le backend principal.
 * Lance une exception si le crédit échoue.
 */
async function creditBalanceInMain(userId, amount, currency, description) {
  try {
    const url = `${PRINCIPAL_URL}/api/v1/balances/${userId}/credit`;
    await axios.post(url, { amount, currency, description });
  } catch (err) {
    logger.error(`Erreur creditBalanceInMain(${userId}, ${amount}, ${currency}) :`,
      err.response?.data || err.message);
    throw err;
  }
}

/**
 * Tente de générer un referralCode unique en bouclant tant qu’il y a un conflit.
 * Il génère “BASE_NANOID” et essaie de patcher ; si un duplicate key survient, il regénère.
 */
async function generateAndAssignReferralInMain(userMain, senderId) {
  const baseName = userMain.fullName.replace(/\s+/g, '').toUpperCase();
  let attempts = 0;
  let newCode;

  while (attempts < 5) {
    attempts += 1;
    const suffix = nanoid();
    newCode = `${baseName}_${suffix}`;

    try {
      await patchUserInMain(senderId, {
        referralCode: newCode,
        hasGeneratedReferral: true
      });
      // Si le patch réussit, on sort de la boucle
      return;
    } catch (err) {
      // Si c’est un conflit unique sur referralCode, on retente
      if (err.response && err.response.status === 409) {
        logger.warn(`Collision referralCode “${newCode}”, tentative ${attempts}/5 pour user ${senderId}`);
        continue;
      }
      // Autre erreur, on remonte
      throw err;
    }
  }

  // Après 5 tentatives, si toujours en duplication, on log et on échoue
  const message = `Impossible de générer un referralCode unique pour ${senderId} après ${attempts} essais`;
  logger.error(message);
  throw new Error(message);
}

/**
 * Vérifie si le sender a atteint 2 transactions “confirmed” internes,
 * et, le cas échéant, génère son referralCode dans le backend principal.
 */
async function checkAndGenerateReferralCodeInMain(senderId, sessionMongoose) {
  // 1) Compter les transactions “confirmed” émises par sender
  let txCount;
  try {
    txCount = await TransactionModel()
      .countDocuments({
        sender: mongoose.Types.ObjectId(senderId),
        status: 'confirmed'
      })
      .session(sessionMongoose);
  } catch (err) {
    logger.error(`Erreur countDocuments pour sender ${senderId} :`, err.message);
    throw err;
  }

  if (txCount < 2) {
    return;
  }

  // 2) Charger l’utilisateur dans le backend principal
  const userMain = await fetchUserFromMain(senderId);
  if (!userMain) {
    logger.warn(`Utilisateur principal ${senderId} introuvable lors de génération referralCode`);
    return;
  }
  if (userMain.hasGeneratedReferral) {
    return;
  }

  // 3) Générer et assigner un code unique (avec boucle de retry en cas de duplicate)
  await generateAndAssignReferralInMain(userMain, senderId);
}

/**
 * Vérifie si la 1ʳᵉ transaction “confirmed” du receiver est
 * éligible pour bonus, puis crédite la balance du filleul + du parrain.
 */
async function processReferralBonusIfEligible(receiverId, tx, sessionMongoose) {
  // 1) Vérifier que c’est la PREMIÈRE transaction “confirmed” du receiver
  let confirmedCount;
  try {
    confirmedCount = await TransactionModel()
      .countDocuments({
        receiver: mongoose.Types.ObjectId(receiverId),
        status: 'confirmed'
      })
      .session(sessionMongoose);
  } catch (err) {
    logger.error(`Erreur countDocuments pour receiver ${receiverId} :`, err.message);
    throw err;
  }

  if (confirmedCount !== 1) {
    return;
  }

  // 2) Charger receiver dans le backend principal
  const receiverMain = await fetchUserFromMain(receiverId);
  if (!receiverMain) {
    logger.warn(`Utilisateur receveur ${receiverId} introuvable lors du bonus`);
    return;
  }
  if (!receiverMain.referredBy) {
    return;
  }

  // 3) Charger le parrain
  const parrainId = receiverMain.referredBy;
  const parrainMain = await fetchUserFromMain(parrainId);
  if (!parrainMain) {
    logger.warn(`Parrain ${parrainId} introuvable pour filleul ${receiverId}`);
    return;
  }

  // 4) Déterminer seuil & bonus selon pays du filleul et du parrain
  const paysReceiverNorm = normalizeCountry(receiverMain.country);
  const paysParrainNorm = normalizeCountry(parrainMain.country);

  let montantRequis = 0,
      bonusReceiver = 0,
      bonusParrain = 0,
      currencyReceiver = '',
      currencyParrain = '';

  // Cas Europe/USA tous les deux
  if (
    EUROPE_USA_COUNTRIES.includes(paysReceiverNorm) &&
    EUROPE_USA_COUNTRIES.includes(paysParrainNorm)
  ) {
    montantRequis = 100;
    bonusReceiver = 5;
    bonusParrain = 5;
    currencyReceiver = ['France', 'Belgique', 'Allemagne'].includes(paysReceiverNorm) ? 'EUR' : 'USD';
    currencyParrain = ['France', 'Belgique', 'Allemagne'].includes(paysParrainNorm) ? 'EUR' : 'USD';
  }
  // Cas Afrique tous les deux
  else if (
    AFRICA_COUNTRIES.includes(paysReceiverNorm) &&
    AFRICA_COUNTRIES.includes(paysParrainNorm)
  ) {
    montantRequis = 20000;
    bonusReceiver = 500;
    bonusParrain = 500;
    currencyReceiver = 'XOF';
    currencyParrain = 'XOF';
  }
  // Cas cross‐continent
  else {
    // Filleul en Europe/USA
    if (EUROPE_USA_COUNTRIES.includes(paysReceiverNorm)) {
      montantRequis = 100;
      bonusReceiver = 5;
      currencyReceiver = ['France', 'Belgique', 'Allemagne'].includes(paysReceiverNorm) ? 'EUR' : 'USD';
    }
    // Filleul en Afrique
    else if (AFRICA_COUNTRIES.includes(paysReceiverNorm)) {
      montantRequis = 20000;
      bonusReceiver = 500;
      currencyReceiver = 'XOF';
    } else {
      return;
    }

    // Parrain en Europe/USA
    if (EUROPE_USA_COUNTRIES.includes(paysParrainNorm)) {
      bonusParrain = 5;
      currencyParrain = ['France', 'Belgique', 'Allemagne'].includes(paysParrainNorm) ? 'EUR' : 'USD';
    }
    // Parrain en Afrique
    else if (AFRICA_COUNTRIES.includes(paysParrainNorm)) {
      bonusParrain = 500;
      currencyParrain = 'XOF';
    } else {
      return;
    }
  }

  // 5) Ne verser le bonus que si le montant de la transaction >= montantRequis
  const montantTx = parseFloat(tx.amount.toString());
  if (isNaN(montantTx) || montantTx < montantRequis) {
    return;
  }

  // 6) Créditer la balance du filleul
  try {
    await creditBalanceInMain(
      receiverId,
      bonusReceiver,
      currencyReceiver,
      'Bonus de parrainage reçu'
    );
  } catch (err) {
    logger.error(`Échec crédit bonus filleul ${receiverId} :`, err.message);
    throw err;
  }

  // 7) Créditer la balance du parrain
  try {
    await creditBalanceInMain(
      parrainId,
      bonusParrain,
      currencyParrain,
      `Bonus de parrainage pour avoir parrainé ${receiverMain.fullName}`
    );
  } catch (err) {
    logger.error(`Échec crédit bonus parrain ${parrainId} :`, err.message);
    throw err;
  }
}

module.exports = {
  checkAndGenerateReferralCodeInMain,
  processReferralBonusIfEligible
};
