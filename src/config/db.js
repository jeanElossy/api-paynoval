// // src/config/db.js
// const mongoose = require('mongoose');
// const config   = require('../config');

// let txConn = null;

// async function connectTransactionsDB() {
//   const { users: uriUsers, transactions: uriTx } = config.mongo;
//   if (!uriUsers) throw new Error('⚠️ MONGO_URI_USERS non défini (config.mongo.users)');
//   if (!uriTx)   throw new Error('⚠️ MONGO_URI_TRANSACTIONS non défini (config.mongo.transactions)');

//   const opts = {
//     useNewUrlParser:    true,
//     useUnifiedTopology: true,
//     serverSelectionTimeoutMS: 5000,
//     socketTimeoutMS:          45000,
//   };

//   // Connexion à la base Users sur la connexion mongoose par défaut
//   await mongoose.connect(uriUsers, opts);
//   console.log(`✅ DB Users (par défaut) connectée : ${mongoose.connection.name}`);

//   // Création d'une connexion distincte pour Transactions
//   txConn = mongoose.createConnection(uriTx, opts);
//   txConn.on('connected', () => {
//     console.log(`✅ DB Transactions connectée : ${txConn.db.databaseName}`);
//   });
//   txConn.on('error', err => {
//     console.error('❌ Erreur connexion Transactions DB :', err);
//   });

//   // Charger les modèles sur txConn (Transactions, Outbox, Notification)
//   require('../models/Transaction')(txConn);
//   require('../models/Outbox')(txConn);
//   require('../models/Notification')(txConn);

//   // Charger le modèle User côté connexion principale
//   require('../models/User');
// }

// function getTxConn() {
//   if (!txConn) {
//     throw new Error('Transactions DB non initialisée');
//   }
//   return txConn;
// }

// module.exports = { connectTransactionsDB, getTxConn };


// src/config/db.js
const mongoose = require('mongoose');
const config   = require('../config');

let txConn = null;

/**
 * Initialise les connexions Mongoose :
 *  - connection principale pour User
 *  - connection secondaire pour Transaction, Outbox, Notification
 */
async function connectTransactionsDB() {
  const { users: uriUsers, transactions: uriTx } = config.mongo;
  if (!uriUsers) throw new Error('⚠️ MONGO_URI_USERS non défini (config.mongo.users)');
  if (!uriTx)   throw new Error('⚠️ MONGO_URI_TRANSACTIONS non défini (config.mongo.transactions)');

  const opts = {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  };

  // Connexion principale (default) pour Users
  await mongoose.connect(uriUsers, opts);
  console.log(`✅ DB Users connectée : ${mongoose.connection.name}`);

  // Connection dédiée pour Transactions
  txConn = mongoose.createConnection(uriTx, opts);
  // Attendre la connexion effective
  await txConn.asPromise();
  console.log(`✅ DB Transactions connectée : ${txConn.name}`);

  // Charger modèles spécifiques sur la connection txConn
  require('../models/Transaction')(txConn);
  require('../models/Outbox')(txConn);
  require('../models/Notification')(txConn);

  // Charger modèle User sur la connection par défaut
  require('../models/User');
}

/**
 * Retourne la connexion Transactions
 */
function getTxConn() {
  if (!txConn) {
    throw new Error('Transactions DB non initialisée. Appelez connectTransactionsDB() d\'abord.');
  }
  return txConn;
}

module.exports = { connectTransactionsDB, getTxConn };
