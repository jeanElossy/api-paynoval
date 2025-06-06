// // File: src/utils/referralUtils.js

// const mongoose           = require('mongoose');
// const axios              = require('axios');
// const { customAlphabet } = require('nanoid');
// const logger             = require('../utils/logger');
// const config             = require('../config');

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

// // URL de base du backend principal (défini dans .env)
// // Ne pas inclure "/api/v1" ici, on le concatène dans les appels axios
// const PRINCIPAL_URL = config.principalUrl;

// /**
//  * Supprime tout préfixe non-lettre (emoji, espaces) et décode l’entité HTML &#x27; en apostrophe.
//  */
// function cleanCountry(raw) {
//   if (typeof raw !== 'string') return '';
//   // 1) remplacer l’entité HTML &#x27; par une apostrophe ASCII
//   const step1 = raw.replace(/&#x27;/g, "'");
//   // 2) supprimer tout caractère non-lettre au début (emoji, espaces, etc.)
//   return step1.replace(/^[^\p{L}]*/u, "");
// }

// /**
//  * Normalise un nom de pays : retire accents et met apostrophe ASCII
//  */
// function normalizeCountry(str) {
//   if (typeof str !== 'string') return '';
//   // Décompose les caractères accentués, puis supprime les diacritiques
//   const noAccents = str
//     .normalize('NFD')
//     .replace(/[\u0300-\u036f]/g, '');
//   // Remplace apostrophe typographique par apostrophe ASCII
//   return noAccents.replace(/’/g, "'").trim();
// }

// /**
//  * Retourne le modèle Transaction associé à la base “api_transactions_paynoval”.
//  */
// function TransactionModel() {
//   const { getTxConn } = require('../config/db');
//   return getTxConn().model('Transaction');
// }

// /**
//  * Récupère un utilisateur depuis le backend principal (service “users”).
//  * @param {String} userId - ID Mongo de l’utilisateur à récupérer
//  * @param {String} authToken - chaîne "Bearer <JWT>" à envoyer en header
//  * @returns {Object|null} l’objet user ou null si 404, renvoie l’erreur sinon
//  */
// async function fetchUserFromMain(userId, authToken) {
//   const url = `${PRINCIPAL_URL}/users/${userId}`;
//   try {
//     const response = await axios.get(url, {
//       headers: {
//         Authorization: authToken
//       }
//     });
//     return response.data.data || null;
//   } catch (err) {
//     if (err.response) {
//       if (err.response.status === 404) {
//         logger.warn(`fetchUserFromMain: utilisateur ${userId} introuvable (404)`);
//         return null;
//       }
//       logger.error(
//         `fetchUserFromMain: requête GET ${url} a échoué ` +
//         `(status ${err.response.status}):`,
//         err.response.data || err.message
//       );
//     } else {
//       logger.error(`fetchUserFromMain: erreur réseau GET ${url} :`, err.message);
//     }
//     throw err;
//   }
// }

// /**
//  * Met à jour un user (PATCH) dans le backend principal.
//  * @param {String} userId - ID Mongo de l’utilisateur à patcher
//  * @param {Object} updates - champ(s) à mettre à jour
//  * @param {String} authToken - chaîne "Bearer <JWT>" à envoyer en header
//  */
// async function patchUserInMain(userId, updates, authToken) {
//   const url = `${PRINCIPAL_URL}/users/${userId}`;
//   try {
//     await axios.patch(url, updates, {
//       headers: {
//         Authorization: authToken
//       }
//     });
//   } catch (err) {
//     if (err.response) {
//       logger.error(
//         `patchUserInMain: requête PATCH ${url} avec ${JSON.stringify(updates)} ` +
//         `a échoué (status ${err.response.status}):`,
//         err.response.data || err.message
//       );
//     } else {
//       logger.error(`patchUserInMain: erreur réseau PATCH ${url} :`, err.message);
//     }
//     throw err;
//   }
// }

// /**
//  * Crédite la balance d’un user dans le backend principal.
//  * @param {String} userId - ID Mongo de l’utilisateur à créditer
//  * @param {Number} amount - montant à créditer
//  * @param {String} currency - devise (ex: "EUR", "XOF"…)
//  * @param {String} description - description de l’opération
//  * @param {String} authToken - chaîne "Bearer <JWT>" à envoyer en header
//  */
// async function creditBalanceInMain(userId, amount, currency, description, authToken) {
//   // Endpoint mis à jour : /users/{userId}/credit
//   const url = `${PRINCIPAL_URL}/users/${userId}/credit`;
//   try {
//     await axios.post(
//       url,
//       { amount, currency, description },
//       {
//         headers: {
//           Authorization: authToken
//         }
//       }
//     );
//   } catch (err) {
//     if (err.response) {
//       logger.error(
//         `creditBalanceInMain: requête POST ${url} ` +
//         `(amount=${amount}, currency=${currency}) a échoué ` +
//         `(status ${err.response.status}):`,
//         err.response.data || err.message
//       );
//     } else {
//       logger.error(`creditBalanceInMain: erreur réseau POST ${url} :`, err.message);
//     }
//     throw err;
//   }
// }

// /**
//  * Tente de générer un referralCode unique en bouclant tant qu’il y a un conflit.
//  * Le referralCode est construit comme : "<prenom>_<suffixe à 3 chiffres>".
//  * @param {Object} userMain - objet user principal retourné par fetchUserFromMain
//  * @param {String} senderId - ID Mongo du sender
//  * @param {String} authToken - "Bearer <JWT>" pour patchUserInMain
//  */
// async function generateAndAssignReferralInMain(userMain, senderId, authToken) {
//   // On extrait le premier mot du fullName
//   const firstName = (userMain.fullName || '').trim().split(' ')[0].toUpperCase();
//   let attempts = 0;
//   let newCode;

//   while (attempts < 5) {
//     attempts += 1;
//     const suffix = nanoid(); // trois chiffres
//     newCode = `${firstName}_${suffix}`;

//     try {
//       await patchUserInMain(
//         senderId,
//         {
//           referralCode:        newCode,
//           hasGeneratedReferral: true
//         },
//         authToken
//       );
//       // Patch réussi → sortir de la boucle
//       logger.info(`generateAndAssignReferralInMain: code "${newCode}" assigné pour ${senderId}`);
//       return;
//     } catch (err) {
//       // Si 409 (conflit sur referralCode), on retente
//       if (err.response && err.response.status === 409) {
//         logger.warn(
//           `generateAndAssignReferralInMain: collision referralCode "${newCode}", ` +
//           `tentative ${attempts}/5 pour user ${senderId}`
//         );
//         continue;
//       }
//       // Toute autre erreur, on remonte
//       throw err;
//     }
//   }

//   const message = `Impossible de générer un referralCode unique pour ${senderId} après ${attempts} essais`;
//   logger.error(message);
//   throw new Error(message);
// }

// /**
//  * Vérifie si le sender a atteint 2 transactions “confirmed” internes,
//  * et, le cas échéant, génère son referralCode dans le backend principal.
//  * @param {String} senderId - ID Mongo du sender
//  * @param {mongoose.ClientSession} sessionMongoose - session Mongoose en cours
//  * @param {String} authToken - "Bearer <JWT>" de la requête d’origine
//  */
// async function checkAndGenerateReferralCodeInMain(senderId, sessionMongoose, authToken) {
//   const senderObjectId = new mongoose.Types.ObjectId(senderId.toString());

//   // 1) Compter les transactions “confirmed” pour le sender
//   let txCount;
//   try {
//     txCount = await TransactionModel()
//       .countDocuments({
//         sender: senderObjectId,
//         status: 'confirmed'
//       })
//       .session(sessionMongoose);
//   } catch (err) {
//     logger.error(`checkAndGenerateReferralCodeInMain: erreur countDocuments pour sender ${senderId}:`, err.message);
//     throw err;
//   }

//   if (txCount < 2) {
//     return;
//   }

//   // 2) Charger l’utilisateur principal
//   const userMain = await fetchUserFromMain(senderId, authToken);
//   if (!userMain) {
//     logger.warn(`checkAndGenerateReferralCodeInMain: utilisateur principal ${senderId} introuvable`);
//     return;
//   }
//   if (userMain.hasGeneratedReferral) {
//     return;
//   }

//   // 3) Générer et assigner un code unique (avec retry en cas de conflit)
//   await generateAndAssignReferralInMain(userMain, senderId, authToken);
// }

// /**
//  * Vérifie si la 1ʳᵉ transaction “confirmed” du receiver est
//  * éligible pour bonus, puis crédite la balance du filleul + du parrain.
//  * @param {String} receiverId - ID Mongo du receveur
//  * @param {Object} tx - document transaction (avec tx.amount, etc.)
//  * @param {mongoose.ClientSession} sessionMongoose
//  * @param {String} authToken - "Bearer <JWT>" de la requête d’origine
//  */
// async function processReferralBonusIfEligible(receiverId, tx, sessionMongoose, authToken) {
//   const receiverObjectId = new mongoose.Types.ObjectId(receiverId.toString());

//   // 1) Compter les transactions “confirmed” du receiver
//   let confirmedCount;
//   try {
//     confirmedCount = await TransactionModel()
//       .countDocuments({
//         receiver: receiverObjectId,
//         status: 'confirmed'
//       })
//       .session(sessionMongoose);
//   } catch (err) {
//     logger.error(`processReferralBonusIfEligible: erreur countDocuments pour receiver ${receiverId}:`, err.message);
//     throw err;
//   }

//   // Si ce n’est pas la première transaction confirmée, on arrête
//   if (confirmedCount !== 1) {
//     return;
//   }

//   // 2) Charger le receveur dans le backend principal
//   const receiverMain = await fetchUserFromMain(receiverId, authToken);
//   if (!receiverMain) {
//     logger.warn(`processReferralBonusIfEligible: receveur ${receiverId} introuvable`);
//     return;
//   }
//   // Si le filleul n’a pas de parrain, on n’attribue pas de bonus
//   if (!receiverMain.referredBy) {
//     return;
//   }

//   // 3) Charger le parrain
//   const parrainId   = receiverMain.referredBy;
//   const parrainMain = await fetchUserFromMain(parrainId, authToken);
//   if (!parrainMain) {
//     logger.warn(`processReferralBonusIfEligible: parrain ${parrainId} introuvable pour filleul ${receiverId}`);
//     return;
//   }

//   // 4) Déterminer seuil & bonus selon pays du filleul et du parrain
//   const paysReceiverClean = cleanCountry(receiverMain.country);
//   const paysParrainClean  = cleanCountry(parrainMain.country);

//   const paysReceiverNorm = normalizeCountry(paysReceiverClean);
//   const paysParrainNorm  = normalizeCountry(paysParrainClean);

//   let montantRequis    = 0;
//   let bonusReceiver    = 0;
//   let bonusParrain     = 0;
//   let currencyReceiver = '';
//   let currencyParrain  = '';

//   // Cas Europe/USA tous les deux
//   if (
//     EUROPE_USA_COUNTRIES.includes(paysReceiverNorm) &&
//     EUROPE_USA_COUNTRIES.includes(paysParrainNorm)
//   ) {
//     montantRequis    = 100;
//     bonusReceiver    = 3;
//     bonusParrain     = 5;
//     currencyReceiver = ['France', 'Belgique', 'Allemagne'].includes(paysReceiverNorm) ? 'EUR' : 'USD';
//     currencyParrain  = ['France', 'Belgique', 'Allemagne'].includes(paysParrainNorm)  ? 'EUR' : 'USD';
//   }
//   // Cas Afrique tous les deux
//   else if (
//     AFRICA_COUNTRIES.includes(paysReceiverNorm) &&
//     AFRICA_COUNTRIES.includes(paysParrainNorm)
//   ) {
//     montantRequis    = 20000;
//     bonusReceiver    = 500;
//     bonusParrain     = 500;
//     currencyReceiver = 'XOF';
//     currencyParrain  = 'XOF';
//   }
//   // Cas cross-continent
//   else {
//     // Filleul en Europe/USA
//     if (EUROPE_USA_COUNTRIES.includes(paysReceiverNorm)) {
//       montantRequis    = 100;
//       bonusReceiver    = 3; // montant réduit pour cross-continent
//       currencyReceiver = ['France', 'Belgique', 'Allemagne'].includes(paysReceiverNorm) ? 'EUR' : 'USD';
//     }
//     // Filleul en Afrique
//     else if (AFRICA_COUNTRIES.includes(paysReceiverNorm)) {
//       montantRequis    = 20000;
//       bonusReceiver    = 500;
//       currencyReceiver = 'XOF';
//     } else {
//       return;
//     }

//     // Parrain en Europe/USA
//     if (EUROPE_USA_COUNTRIES.includes(paysParrainNorm)) {
//       bonusParrain    = 5;
//       currencyParrain = ['France', 'Belgique', 'Allemagne'].includes(paysParrainNorm) ? 'EUR' : 'USD';
//     }
//     // Parrain en Afrique
//     else if (AFRICA_COUNTRIES.includes(paysParrainNorm)) {
//       bonusParrain    = 500;
//       currencyParrain = 'XOF';
//     } else {
//       return;
//     }
//   }

//   // 5) Vérifier que le montant de la transaction est suffisant
//   const montantTx = parseFloat(tx.amount.toString());
//   if (isNaN(montantTx) || montantTx < montantRequis) {
//     return;
//   }

//   // 6) Créditer la balance du filleul (avec token)
//   try {
//     await creditBalanceInMain(
//       receiverId,
//       bonusReceiver,
//       currencyReceiver,
//       'Bonus de parrainage reçu',
//       authToken
//     );
//     logger.info(`processReferralBonusIfEligible: ${bonusReceiver} ${currencyReceiver} crédité au filleul ${receiverId}`);
//   } catch (err) {
//     logger.error(`processReferralBonusIfEligible: échec crédit bonus filleul ${receiverId}:`, err.message);
//     throw err;
//   }

//   // 7) Créditer la balance du parrain (avec token)
//   try {
//     await creditBalanceInMain(
//       parrainId,
//       bonusParrain,
//       currencyParrain,
//       `Bonus de parrainage pour avoir parrainé ${receiverMain.fullName}`,
//       authToken
//     );
//     logger.info(`processReferralBonusIfEligible: ${bonusParrain} ${currencyParrain} crédité au parrain ${parrainId}`);
//   } catch (err) {
//     logger.error(`processReferralBonusIfEligible: échec crédit bonus parrain ${parrainId}:`, err.message);
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

// URL de base du backend principal (défini dans .env)
const PRINCIPAL_URL = config.principalUrl;

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
  const { getTxConn } = require('../config/db');
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

async function processReferralBonusIfEligible(receiverId, tx, sessionMongoose, authToken) {
  console.log(`--> Début processReferralBonusIfEligible pour receiverId=${receiverId}`);
  console.log(`Transaction amount: ${tx.amount}`);

  const receiverObjectId = new mongoose.Types.ObjectId(receiverId);
  let confirmedCount;
  try {
    confirmedCount = await TransactionModel()
      .countDocuments({ receiver: receiverObjectId, status: 'confirmed' })
      .session(sessionMongoose);
    console.log(`Transactions confirmées pour le receveur: ${confirmedCount}`);
  } catch (err) { throw err; }
  if (confirmedCount !== 1) return;

  const receiverMain = await fetchUserFromMain(receiverId, authToken);
  console.log(`receiverMain.referredBy: ${receiverMain ? receiverMain.referredBy : 'null'}`);
  if (!receiverMain || !receiverMain.referredBy) return;

  const parrainId = receiverMain.referredBy;
  const parrainMain = await fetchUserFromMain(parrainId, authToken);
  console.log(`parrainMain: ${parrainMain ? parrainMain._id : 'null'}`);
  if (!parrainMain) return;

  const paysReceiverNorm = normalizeCountry(cleanCountry(receiverMain.country));
  const paysParrainNorm  = normalizeCountry(cleanCountry(parrainMain.country));

  let montantRequis = 0, bonusReceiver = 0, bonusParrain = 0;
  let currencyReceiver = '', currencyParrain = '';

  // Cas Europe/USA tous les deux
  if (EUROPE_USA_COUNTRIES.includes(paysReceiverNorm) && EUROPE_USA_COUNTRIES.includes(paysParrainNorm)) {
    montantRequis = 100; bonusReceiver = 3; bonusParrain = 5;
    currencyReceiver = EUROPE_USA_COUNTRIES.slice(2).includes(paysReceiverNorm) ? 'EUR' : 'USD';
    currencyParrain  = EUROPE_USA_COUNTRIES.slice(2).includes(paysParrainNorm)  ? 'EUR' : 'USD';
  }
  // Cas Afrique tous les deux
  else if (AFRICA_COUNTRIES.includes(paysReceiverNorm) && AFRICA_COUNTRIES.includes(paysParrainNorm)) {
    montantRequis = 20000; bonusReceiver = 500; bonusParrain = 500;
    currencyReceiver = 'XOF'; currencyParrain = 'XOF';
  }
  // Cas cross-continent
  else {
    // Filleul → Europe/USA
    if (EUROPE_USA_COUNTRIES.includes(paysReceiverNorm)) {
      montantRequis = 100; bonusReceiver = 3;
      currencyReceiver = EUROPE_USA_COUNTRIES.slice(2).includes(paysReceiverNorm) ? 'EUR' : 'USD';
    } else if (AFRICA_COUNTRIES.includes(paysReceiverNorm)) {
      montantRequis = 20000; bonusReceiver = 500; currencyReceiver = 'XOF';
    } else return;

    // Parrain → Europe/USA ou Afrique
    if (EUROPE_USA_COUNTRIES.includes(paysParrainNorm)) {
      bonusParrain = 5;
      currencyParrain = EUROPE_USA_COUNTRIES.slice(2).includes(paysParrainNorm) ? 'EUR' : 'USD';
    } else if (AFRICA_COUNTRIES.includes(paysParrainNorm)) {
      bonusParrain = 500; currencyParrain = 'XOF';
    } else return;
  }

  console.log(`montantRequis=${montantRequis}, bonusReceiver=${bonusReceiver}, bonusParrain=${bonusParrain}`);
  console.log(`currencyReceiver=${currencyReceiver}, currencyParrain=${currencyParrain}`);

  const montantTx = parseFloat(tx.amount.toString());
  if (isNaN(montantTx) || montantTx < montantRequis) {
    console.log(`Transaction insuffisante (${montantTx} < ${montantRequis})`);
    return;
  }

  // Crédit filleul
  console.log(`Crédit de ${bonusReceiver} ${currencyReceiver} au filleul ${receiverId}`);
  try {
    await creditBalanceInMain(receiverId, bonusReceiver, currencyReceiver, 'Bonus de parrainage reçu', authToken);
    console.log(`✅ Bonus filleul crédité avec succès`);
  } catch (err) { console.error(`❌ Échec crédit filleul:`, err.message); throw err; }

  // Crédit parrain
  console.log(`Crédit de ${bonusParrain} ${currencyParrain} au parrain ${parrainId}`);
  try {
    await creditBalanceInMain(parrainId, bonusParrain, currencyParrain, `Bonus pour avoir parrainé ${receiverMain.fullName}`, authToken);
    console.log(`✅ Bonus parrain crédité avec succès`);
  } catch (err) { console.error(`❌ Échec crédit parrain:`, err.message); throw err; }
}

module.exports = { checkAndGenerateReferralCodeInMain, processReferralBonusIfEligible };
