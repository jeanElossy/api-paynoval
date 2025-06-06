// File: src/utils/referralUtils.js

const mongoose           = require('mongoose');
const axios              = require('axios');
const { customAlphabet } = require('nanoid');
const logger             = require('../utils/logger');
const config             = require('../config');
const { getTxConn }      = require('../config/db');
const Balance            = require('../models/Balance');

// URL de base du backend principal (défini dans .env)
const PRINCIPAL_URL = config.principalUrl;


// Générateur nanoid à 3 chiffres (0-9)
const nanoid = customAlphabet('0123456789', 3);

// Listes des pays Europe/USA vs Afrique (sans accents, apostrophe ASCII)
const EUROPE_USA_COUNTRIES = [
  'Canada',
  'USA',
  'France',
  'Belgique',
  'Allemagne'
];
const AFRICA_COUNTRIES = [
  "Cote d'Ivoire",
  'Mali',
  'Burkina Faso',
  'Senegal',
  'Cameroun'
];


function cleanCountry(raw) {
  if (typeof raw !== 'string') return '';
  const step1 = raw.replace(/&#x27;/g, "'");
  return step1.replace(/^[^\p{L}]*/u, "");
}

function normalizeCountry(str) {
  if (typeof str !== 'string') return '';
  const noAccents = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return noAccents.replace(/’/g, "'").trim();
}

function TransactionModel() {
  return getTxConn().model('Transaction');
}

async function fetchUserFromMain(userId, authToken) {
  const url = `${PRINCIPAL_URL}/users/${userId}`;
  try {
    const response = await axios.get(url, { headers: { Authorization: authToken } });
    return response.data.data || null;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      logger.warn(`fetchUserFromMain: utilisateur ${userId} introuvable (404)`);
      return null;
    }
    logger.error(`fetchUserFromMain: erreur GET ${url}:`, err.response ? err.response.data : err.message);
    throw err;
  }
}

async function patchUserInMain(userId, updates, authToken) {
  const url = `${PRINCIPAL_URL}/users/${userId}`;
  try {
    await axios.patch(url, updates, { headers: { Authorization: authToken } });
  } catch (err) {
    logger.error(`patchUserInMain: erreur PATCH ${url} avec ${JSON.stringify(updates)}:`,
      err.response ? err.response.data : err.message);
    throw err;
  }
}

async function creditBalanceInMain(userId, amount, currency, description, authToken) {
  const url = `${PRINCIPAL_URL}/users/${userId}/credit`;
  try {
    await axios.post(url, { amount, currency, description }, { headers: { Authorization: authToken } });
  } catch (err) {
    logger.error(`creditBalanceInMain: erreur POST ${url} (amount=${amount}, currency=${currency}):`,
      err.response ? err.response.data : err.message);
    throw err;
  }
}


async function generateAndAssignReferralInMain(userMain, senderId, authToken) {
  const firstName = (userMain.fullName || '').trim().split(' ')[0].toUpperCase();
  let attempts = 0, newCode;
  while (attempts < 5) {
    attempts++;
    newCode = `${firstName}_${nanoid()}`;
    try {
      console.log(`Tentative génération code: ${newCode} pour user ${senderId}`);
      await patchUserInMain(senderId, { referralCode: newCode, hasGeneratedReferral: true }, authToken);
      logger.info(`generateAndAssignReferralInMain: code "${newCode}" assigné pour ${senderId}`);
      return;
    } catch (err) {
      if (err.response && err.response.status === 409) {
        console.warn(`Collision referralCode "${newCode}" (${attempts}/5)`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Impossible de générer un referralCode après ${attempts} essais pour ${senderId}`);
}



async function checkAndGenerateReferralCodeInMain(senderId, sessionMongoose, authToken) {
  const senderObjectId = new mongoose.Types.ObjectId(senderId);
  let txCount;
  try {
    txCount = await TransactionModel().countDocuments({ sender: senderObjectId, status: 'confirmed' }).session(sessionMongoose);
    console.log(`Nombre de transactions confirmées pour ${senderId}: ${txCount}`);
  } catch (err) { throw err; }
  if (txCount < 2) return;
  const userMain = await fetchUserFromMain(senderId, authToken);
  if (!userMain || userMain.hasGeneratedReferral) return;
  await generateAndAssignReferralInMain(userMain, senderId, authToken);
}


/**
 * Vérifie si un bonus de parrainage peut être attribué
 * et crédite la collection « Balance » de la base principale
 */
async function processReferralBonusIfEligible(userId, tx, sessionMongoose, authToken) {
  console.log(`--> Début processReferralBonusIfEligible pour userId=${userId}`);
  console.log(`Montant de la transaction : ${tx.amount}`);

  const userObjId = new mongoose.Types.ObjectId(userId);

  // 1) Vérifier que c'est la 1ʳᵉ transaction confirmée EN TANT QUE sender
  const confirmedCount = await TransactionModel()
    .countDocuments({ sender: userObjId, status: 'confirmed' })
    .session(sessionMongoose);
  console.log(`Transactions confirmées pour le filleul : ${confirmedCount}`);
  if (confirmedCount !== 1) return;

  // 2) Récupérer le filleul et son parrain depuis le service principal
  const filleulMain = await fetchUserFromMain(userId, authToken);
  if (!filleulMain || !filleulMain.referredBy) return;
  const parrainId   = filleulMain.referredBy;
  const parrainMain = await fetchUserFromMain(parrainId, authToken);
  if (!parrainMain) return;

  // 3) Déterminer seuils et montants de bonus en fonction des pays
  const paysFilleul = normalizeCountry(cleanCountry(filleulMain.country));
  const paysParrain = normalizeCountry(cleanCountry(parrainMain.country));

  let montantRequis  = 0;
  let bonusFilleul   = 0;
  let bonusParrain   = 0;
  let currFilleul    = '';
  let currParrain    = '';

  if (
    EUROPE_USA_COUNTRIES.includes(paysFilleul) &&
    EUROPE_USA_COUNTRIES.includes(paysParrain)
  ) {
    // Europe ↔ Europe (ou USA)
    montantRequis = 100;
    bonusFilleul  = 3;
    bonusParrain  = 5;
    currFilleul   = EUROPE_USA_COUNTRIES.slice(2).includes(paysFilleul)  ? 'EUR' : 'USD';
    currParrain   = EUROPE_USA_COUNTRIES.slice(2).includes(paysParrain)  ? 'EUR' : 'USD';
  } else if (
    AFRICA_COUNTRIES.includes(paysFilleul) &&
    AFRICA_COUNTRIES.includes(paysParrain)
  ) {
    // Afrique ↔ Afrique
    montantRequis = 20000;
    bonusFilleul  = 500;
    bonusParrain  = 500;
    currFilleul   = currParrain = 'XOF';
  } else {
    // Cross‑continent
    if (EUROPE_USA_COUNTRIES.includes(paysFilleul)) {
      montantRequis = 100;
      bonusFilleul  = 3;
      currFilleul   = EUROPE_USA_COUNTRIES.slice(2).includes(paysFilleul) ? 'EUR' : 'USD';
    } else if (AFRICA_COUNTRIES.includes(paysFilleul)) {
      montantRequis = 20000;
      bonusFilleul  = 500;
      currFilleul   = 'XOF';
    } else return;

    if (EUROPE_USA_COUNTRIES.includes(paysParrain)) {
      bonusParrain = 5;
      currParrain  = EUROPE_USA_COUNTRIES.slice(2).includes(paysParrain) ? 'EUR' : 'USD';
    } else if (AFRICA_COUNTRIES.includes(paysParrain)) {
      bonusParrain = 500;
      currParrain  = 'XOF';
    } else return;
  }

  console.log(`Seuil=${montantRequis}, bonusFilleul=${bonusFilleul}, bonusParrain=${bonusParrain}`);

  // 4) Vérifier que la transaction atteint le seuil
  const montantTx = parseFloat(tx.amount);
  if (isNaN(montantTx) || montantTx < montantRequis) {
    console.log(`Transaction insuffisante (${montantTx} < ${montantRequis})`);
    return;
  }

  // 5) Créditer la collection Balance de la base principale et récupérer la nouvelle balance
  try {
    const updatedFilleul = await Balance.findOneAndUpdate(
      { userId: userId },
      { $inc: { amount: bonusFilleul } },
      { upsert: true, returnDocument: 'after', session: sessionMongoose }
    );
    console.log(`✅ Bonus filleul crédité : nouvelle balance = ${updatedFilleul.amount}`);
  } catch (err) {
    console.error('❌ Échec crédit filleul dans Balance :', err.message);
    throw err;
  }

  try {
    const updatedParrain = await Balance.findOneAndUpdate(
      { userId: parrainId },
      { $inc: { amount: bonusParrain } },
      { upsert: true, returnDocument: 'after', session: sessionMongoose }
    );
    console.log(`✅ Bonus parrain crédité : nouvelle balance = ${updatedParrain.amount}`);
  } catch (err) {
    console.error('❌ Échec crédit parrain dans Balance :', err.message);
    throw err;
  }

  // 6) (Optionnel) créditer également via l’API principale
  try {
    await creditBalanceInMain(userId, bonusFilleul, currFilleul, 'Bonus de parrainage reçu', authToken);
    console.log('✅ Bonus filleul crédité dans Main');
  } catch (err) {
    console.error('❌ Échec crédit filleul dans Main :', err.message);
    throw err;
  }

  try {
    await creditBalanceInMain(
      parrainId,
      bonusParrain,
      currParrain,
      `Bonus pour avoir parrainé ${filleulMain.fullName}`,
      authToken
    );
    console.log('✅ Bonus parrain crédité dans Main');
  } catch (err) {
    console.error('❌ Échec crédit parrain dans Main :', err.message);
    throw err;
  }
}


module.exports = { 
  checkAndGenerateReferralCodeInMain, 
  processReferralBonusIfEligible 
};
