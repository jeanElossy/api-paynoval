// // File: src/utils/referralUtils.js

// const mongoose           = require('mongoose');
// const axios              = require('axios');
// const { customAlphabet } = require('nanoid');
// const logger             = require('../utils/logger');
// const config             = require('../config');
// const { getTxConn }      = require('../config/db');
// const Balance            = require('../models/Balance');
// const { createNotification } = require('../controllers/notificationController');

// // URL de base du backend principal (défini dans .env)
// const PRINCIPAL_URL = config.principalUrl;


// // Générateur nanoid à 3 chiffres (0-9)
// const nanoid = customAlphabet('0123456789', 3);

// // Listes des pays Europe/USA vs Afrique (sans accents, apostrophe ASCII)
// const EUROPE_USA_COUNTRIES = [
//   'Canada',
//   'USA',
//   'France',
//   'Belgique',
//   'Allemagne'
// ];
// const AFRICA_COUNTRIES = [
//   "Cote d'Ivoire",
//   'Mali',
//   'Burkina Faso',
//   'Senegal',
//   'Cameroun'
// ];


// function cleanCountry(raw) {
//   if (typeof raw !== 'string') return '';
//   const step1 = raw.replace(/&#x27;/g, "'");
//   return step1.replace(/^[^\p{L}]*/u, "");
// }

// function normalizeCountry(str) {
//   if (typeof str !== 'string') return '';
//   const noAccents = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
//   return noAccents.replace(/’/g, "'").trim();
// }

// function TransactionModel() {
//   return getTxConn().model('Transaction');
// }

// async function fetchUserFromMain(userId, authToken) {
//   const url = `${PRINCIPAL_URL}/users/${userId}`;
//   try {
//     const response = await axios.get(url, { headers: { Authorization: authToken } });
//     return response.data.data || null;
//   } catch (err) {
//     if (err.response && err.response.status === 404) {
//       logger.warn(`fetchUserFromMain: utilisateur ${userId} introuvable (404)`);
//       return null;
//     }
//     logger.error(`fetchUserFromMain: erreur GET ${url}:`, err.response ? err.response.data : err.message);
//     throw err;
//   }
// }

// async function patchUserInMain(userId, updates, authToken) {
//   const url = `${PRINCIPAL_URL}/users/${userId}`;
//   try {
//     await axios.patch(url, updates, { headers: { Authorization: authToken } });
//   } catch (err) {
//     logger.error(`patchUserInMain: erreur PATCH ${url} avec ${JSON.stringify(updates)}:`,
//       err.response ? err.response.data : err.message);
//     throw err;
//   }
// }

// async function creditBalanceInMain(userId, amount, currency, description, authToken) {
//   const url = `${PRINCIPAL_URL}/users/${userId}/credit`;
//   try {
//     await axios.post(url, { amount, currency, description }, { headers: { Authorization: authToken } });
//   } catch (err) {
//     logger.error(`creditBalanceInMain: erreur POST ${url} (amount=${amount}, currency=${currency}):`,
//       err.response ? err.response.data : err.message);
//     throw err;
//   }
// }

// async function generateAndAssignReferralInMain(userMain, senderId, authToken) {
//   const firstName = (userMain.fullName || '').trim().split(' ')[0].toUpperCase();
//   let attempts = 0, newCode;
//   while (attempts < 5) {
//     attempts++;
//     newCode = `${firstName}_${nanoid()}`;
//     try {
//       console.log(`Tentative génération code: ${newCode} pour user ${senderId}`);
//       await patchUserInMain(senderId, { referralCode: newCode, hasGeneratedReferral: true }, authToken);
//       logger.info(`generateAndAssignReferralInMain: code "${newCode}" assigné pour ${senderId}`);
//       return;
//     } catch (err) {
//       if (err.response && err.response.status === 409) {
//         console.warn(`Collision referralCode "${newCode}" (${attempts}/5)`);
//         continue;
//       }
//       throw err;
//     }
//   }
//   throw new Error(`Impossible de générer un referralCode après ${attempts} essais pour ${senderId}`);
// }

// async function checkAndGenerateReferralCodeInMain(senderId, sessionMongoose, authToken) {
//   const senderObjectId = new mongoose.Types.ObjectId(senderId);
//   let txCount;
//   try {
//     txCount = await TransactionModel().countDocuments({ sender: senderObjectId, status: 'confirmed' }).session(sessionMongoose);
//     console.log(`Nombre de transactions confirmées pour ${senderId}: ${txCount}`);
//   } catch (err) { throw err; }
//   if (txCount < 2) return;
//   const userMain = await fetchUserFromMain(senderId, authToken);
//   if (!userMain || userMain.hasGeneratedReferral) return;
//   await generateAndAssignReferralInMain(userMain, senderId, authToken);
// }

// /**
//  * Vérifie si un bonus de parrainage peut être attribué
//  * et crédite la collection « Balance » de la base principale
//  */
// async function processReferralBonusIfEligible(userId, tx, sessionMongoose, authToken) {
//   console.log(`--> Début processReferralBonusIfEligible pour userId=${userId}`);
//   console.log(`Montant de la transaction : ${tx.amount}`);

//   const userObjId = new mongoose.Types.ObjectId(userId);

//   // 1) Vérifier que c'est la 1ʳᵉ transaction confirmée EN TANT QUE sender
//   const confirmedCount = await TransactionModel()
//     .countDocuments({ sender: userObjId, status: 'confirmed' })
//     .session(sessionMongoose);
//   console.log(`Transactions confirmées pour le filleul : ${confirmedCount}`);
//   if (confirmedCount !== 1) return;

//   // 2) Récupérer le filleul et son parrain depuis le service principal
//   const filleulMain = await fetchUserFromMain(userId, authToken);
//   if (!filleulMain || !filleulMain.referredBy) return;
//   const parrainId   = filleulMain.referredBy;
//   const parrainMain = await fetchUserFromMain(parrainId, authToken);
//   if (!parrainMain) return;

//   // 3) Déterminer seuils et montants de bonus en fonction des pays
//   const paysFilleul = normalizeCountry(cleanCountry(filleulMain.country));
//   const paysParrain = normalizeCountry(cleanCountry(parrainMain.country));

//   let montantRequis  = 0;
//   let bonusFilleul   = 0;
//   let bonusParrain   = 0;
//   let currFilleul    = '';
//   let currParrain    = '';

//   if (
//     EUROPE_USA_COUNTRIES.includes(paysFilleul) &&
//     EUROPE_USA_COUNTRIES.includes(paysParrain)
//   ) {
//     // Europe ↔ Europe (ou USA)
//     montantRequis = 100;
//     bonusFilleul  = 3;
//     bonusParrain  = 5;
//     currFilleul   = EUROPE_USA_COUNTRIES.slice(2).includes(paysFilleul)  ? 'EUR' : 'USD';
//     currParrain   = EUROPE_USA_COUNTRIES.slice(2).includes(paysParrain)  ? 'EUR' : 'USD';
//   } else if (
//     AFRICA_COUNTRIES.includes(paysFilleul) &&
//     AFRICA_COUNTRIES.includes(paysParrain)
//   ) {
//     // Afrique ↔ Afrique
//     montantRequis = 20000;
//     bonusFilleul  = 500;
//     bonusParrain  = 500;
//     currFilleul   = currParrain = 'XOF';
//   } else {
//     // Cross‑continent
//     if (EUROPE_USA_COUNTRIES.includes(paysFilleul)) {
//       montantRequis = 100;
//       bonusFilleul  = 3;
//       currFilleul   = EUROPE_USA_COUNTRIES.slice(2).includes(paysFilleul) ? 'EUR' : 'USD';
//     } else if (AFRICA_COUNTRIES.includes(paysFilleul)) {
//       montantRequis = 20000;
//       bonusFilleul  = 500;
//       currFilleul   = 'XOF';
//     } else return;

//     if (EUROPE_USA_COUNTRIES.includes(paysParrain)) {
//       bonusParrain = 5;
//       currParrain  = EUROPE_USA_COUNTRIES.slice(2).includes(paysParrain) ? 'EUR' : 'USD';
//     } else if (AFRICA_COUNTRIES.includes(paysParrain)) {
//       bonusParrain = 500;
//       currParrain  = 'XOF';
//     } else return;
//   }

//   console.log(`Seuil=${montantRequis}, bonusFilleul=${bonusFilleul}, bonusParrain=${bonusParrain}`);

//   // 4) Vérifier que la transaction atteint le seuil
//   const montantTx = parseFloat(tx.amount);
//   if (isNaN(montantTx) || montantTx < montantRequis) {
//     console.log(`Transaction insuffisante (${montantTx} < ${montantRequis})`);
//     return;
//   }

//   // 5) Créditer la collection Balance de la base principale
//   try {
//     const updatedFilleul = await Balance.findOneAndUpdate(
//       { user: userId },                // <— utilises 'user' ici
//       { $inc: { amount: bonusFilleul } },
//       { upsert: true, returnDocument: 'after', session: sessionMongoose }
//     );
//     console.log(`✅ Bonus filleul crédité : nouvelle balance = ${updatedFilleul.amount}`);
//   } catch (err) {
//     console.error('❌ Échec crédit filleul dans Balance :', err.message);
//     throw err;
//   }

//   try {
//     const updatedParrain = await Balance.findOneAndUpdate(
//       { user: parrainId },             // <— et ici aussi
//       { $inc: { amount: bonusParrain } },
//       { upsert: true, returnDocument: 'after', session: sessionMongoose }
//     );
//     console.log(`✅ Bonus parrain crédité : nouvelle balance = ${updatedParrain.amount}`);
//   } catch (err) {
//     console.error('❌ Échec crédit parrain dans Balance :', err.message);
//     throw err;
//   }

//   // 6) (Optionnel) créditer également via l’API principale
//   try {
//     await creditBalanceInMain(userId, bonusFilleul, currFilleul, 'Bonus de parrainage reçu', authToken);
//     console.log('✅ Bonus filleul crédité dans Main');
//   } catch (err) {
//     console.error('❌ Échec crédit filleul dans Main :', err.message);
//     throw err;
//   }

//   try {
//     await creditBalanceInMain(
//       parrainId,
//       bonusParrain,
//       currParrain,
//       `Bonus pour avoir parrainé ${filleulMain.fullName}`,
//       authToken
//     );
//     console.log('✅ Bonus parrain crédité dans Main');
//   } catch (err) {
//     console.error('❌ Échec crédit parrain dans Main :', err.message);
//     throw err;
//   }
// }

// module.exports = { 
//   checkAndGenerateReferralCodeInMain, 
//   processReferralBonusIfEligible 
// };


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

// Listes des pays Europe/USA vs Afrique
const EUROPE_USA_COUNTRIES = ['Canada', 'USA', 'France', 'Belgique', 'Allemagne'];
const AFRICA_COUNTRIES     = ["Cote d'Ivoire", 'Mali', 'Burkina Faso', 'Senegal', 'Cameroun'];

/**
 * Nettoie le nom du pays : remplace entités HTML et supprime caractères non alphabétiques initiaux
 */
function cleanCountry(raw) {
  if (typeof raw !== 'string') return '';
  const step1 = raw.replace(/&#x27;/g, "'");
  return step1.replace(/^[^\p{L}]*/u, '');
}

/**
 * Normalise le nom du pays : retire accents et apostrophes spéciales
 */
function normalizeCountry(str) {
  if (typeof str !== 'string') return '';
  const noAccents = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return noAccents.replace(/’/g, "'").trim();
}

/**
 * Modèle Transaction sur la connexion txConn
 */
function TransactionModel() {
  return getTxConn().model('Transaction');
}

/**
 * Récupère un utilisateur depuis le service principal
 */
async function fetchUserFromMain(userId, authToken) {
  const url = `${PRINCIPAL_URL}/users/${userId}`;
  try {
    const res = await axios.get(url, { headers: { Authorization: authToken } });
    return res.data.data || null;
  } catch (err) {
    if (err.response?.status === 404) {
      logger.warn(`fetchUserFromMain: utilisateur ${userId} introuvable`);
      return null;
    }
    logger.error(`fetchUserFromMain: erreur GET ${url}:`, err.message);
    throw err;
  }
}

/**
 * Patch un utilisateur dans le service principal
 */
async function patchUserInMain(userId, updates, authToken) {
  const url = `${PRINCIPAL_URL}/users/${userId}`;
  try {
    await axios.patch(url, updates, { headers: { Authorization: authToken } });
  } catch (err) {
    logger.error(`patchUserInMain: erreur PATCH ${url}:`, err.message);
    throw err;
  }
}

/**
 * Crédite la balance dans le service principal
 */
async function creditBalanceInMain(userId, amount, currency, description, authToken) {
  const url = `${PRINCIPAL_URL}/users/${userId}/credit`;
  try {
    await axios.post(url,
      { amount, currency, description },
      { headers: { Authorization: authToken } }
    );
  } catch (err) {
    logger.error(`creditBalanceInMain: erreur POST ${url}:`, err.message);
    throw err;
  }
}

/**
 * Envoi d'une notification via l'API principale (push + in-app)
 */
async function sendNotificationToMain(userId, title, message, data = {}, authToken) {
  const url = `${PRINCIPAL_URL}/notifications`;
  try {
    await axios.post(url,
      { recipient: userId, title, message, data },
      { headers: { Authorization: authToken } }
    );
    console.log(`Notification envoyée à ${userId}`);
  } catch (err) {
    logger.error(`sendNotificationToMain: erreur POST ${url}:`, err.message);
  }
}

/**
 * Génère et assigne un referralCode après 2 transactions confirmées
 */
async function generateAndAssignReferralInMain(userMain, senderId, authToken) {
  const firstName = (userMain.fullName || '').split(' ')[0].toUpperCase();
  for (let attempt = 0; attempt < 5; attempt++) {
    const newCode = `${firstName}_${nanoid()}`;
    try {
      await patchUserInMain(senderId,
        { referralCode: newCode, hasGeneratedReferral: true },
        authToken
      );
      logger.info(`generateAndAssignReferralInMain: code "${newCode}" assigné pour ${senderId}`);
      return;
    } catch (err) {
      if (err.response?.status === 409) continue;
      throw err;
    }
  }
  throw new Error(`Impossible de générer un referralCode pour ${senderId}`);
}

/**
 * Vérifie et génère le referralCode dans le service principal
 */
async function checkAndGenerateReferralCodeInMain(senderId, sessionMongoose, authToken) {
  const count = await TransactionModel()
    .countDocuments({ sender: senderId, status: 'confirmed' })
    .session(sessionMongoose);
  console.log(`Nombre de transactions confirmées pour ${senderId}: ${count}`);
  if (count < 2) return;
  const userMain = await fetchUserFromMain(senderId, authToken);
  if (!userMain || userMain.hasGeneratedReferral) return;
  await generateAndAssignReferralInMain(userMain, senderId, authToken);
}

/**
 * Processus de crédit du bonus de parrainage
 */
async function processReferralBonusIfEligible(userId, tx, sessionMongoose, authToken) {
  console.log(`Début processReferralBonusIfEligible pour userId=${userId}`);

  // 1) Vérification de la 1ʳᵉ transaction confirmée en tant que sender
  const txCount = await TransactionModel()
    .countDocuments({ sender: new mongoose.Types.ObjectId(userId), status: 'confirmed' })
    .session(sessionMongoose);
  if (txCount !== 1) return;

  // 2) Récupérer filleul et parrain depuis le service principal
  const filleul = await fetchUserFromMain(userId, authToken);
  if (!filleul?.referredBy) return;
  const parrainId = filleul.referredBy;
  const parrain   = await fetchUserFromMain(parrainId, authToken);
  if (!parrain) return;

  // 3) Déterminer seuil et montants de bonus selon pays
  const paysF = normalizeCountry(cleanCountry(filleul.country));
  const paysP = normalizeCountry(cleanCountry(parrain.country));
  let seuil = 0, bonusF = 0, bonusP = 0, curF = '', curP = '';

  if (EUROPE_USA_COUNTRIES.includes(paysF) && EUROPE_USA_COUNTRIES.includes(paysP)) {
    seuil = 100; bonusF = 3; bonusP = 5; curF = curP = 'USD';
  } else if (AFRICA_COUNTRIES.includes(paysF) && AFRICA_COUNTRIES.includes(paysP)) {
    seuil = 20000; bonusF = 500; bonusP = 500; curF = curP = 'XOF';
  } else {
    if (EUROPE_USA_COUNTRIES.includes(paysF)) { seuil = 100; bonusF = 3; curF = 'USD'; }
    else if (AFRICA_COUNTRIES.includes(paysF))  { seuil = 20000; bonusF = 500; curF = 'XOF'; }
    if (EUROPE_USA_COUNTRIES.includes(paysP)) { bonusP = 5; curP = 'USD'; }
    else if (AFRICA_COUNTRIES.includes(paysP)) { bonusP = 500; curP = 'XOF'; }
  }

  if (parseFloat(tx.amount) < seuil) return;

  // 4) Créditer balance du filleul
  const upF = await Balance.findOneAndUpdate(
    { user: userId },
    { $inc: { amount: bonusF } },
    { upsert: true, returnDocument: 'after', session: sessionMongoose }
  );
  const newBalF = upF.amount;

  // 5) Créditer balance du parrain
  const upP = await Balance.findOneAndUpdate(
    { user: parrainId },
    { $inc: { amount: bonusP } },
    { upsert: true, returnDocument: 'after', session: sessionMongoose }
  );
  const newBalP = upP.amount;

  // 6) Envoyer notifications via l'API principale
  await sendNotificationToMain(
    parrainId,
    'Bonus parrain crédité',
    `Vous avez reçu ${bonusP}${curP}. Nouvelle balance: ${newBalP}${curP}`,
    { type: 'referral_bonus', amount: bonusP },
    authToken
  );
  await sendNotificationToMain(
    userId,
    'Bonus filleul crédité',
    `Vous avez reçu ${bonusF}${curF}. Nouvelle balance: ${newBalF}${curF}`,
    { type: 'referral_bonus', amount: bonusF },
    authToken
  );

  // 7) (Optionnel) Crédits via API principale
  await creditBalanceInMain(userId, bonusF, curF, 'Bonus reçu', authToken);
  await creditBalanceInMain(parrainId, bonusP, curP, `Bonus parrainé pour ${filleul.fullName}`, authToken);
}

module.exports = {
  checkAndGenerateReferralCodeInMain,
  processReferralBonusIfEligible
};




