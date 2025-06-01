// src/config/db.js
const mongoose = require('mongoose');
const config   = require('../config');

let txConn = null;

/**
 * Initialise les connexions Mongoose :
 *  - connexion principale (default) pour User (backend principal)
 *  - connexion secondaire txConn pour Transaction, Outbox, Notification (service transactions)
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

  //
  // 1) Connexion principale (default) → pour le User “global”
  //
  await mongoose.connect(uriUsers, opts);
  console.log(`✅ DB Users connectée : ${mongoose.connection.name}`);
  // On enregistre ici le modèle User sur la connexion principale
  require('../models/User'); // ceci enregistre mongoose.model('User', userSchema) sur la connexion par défaut

  //
  // 2) Création d’une connexion dédiée txConn → pour le service “transactions”
  //
  txConn = mongoose.createConnection(uriTx, opts);
  // Attendre la connexion effective
  await txConn.asPromise();
  console.log(`✅ DB Transactions connectée : ${txConn.name}`);

  //
  // 3) Enregistrer **le même** schéma User sur txConn, AVANT d’enregistrer Transaction
  //    afin que “ref: 'User'” du schéma Transaction pointe bien vers un modèle User existant.
  //
  require('../models/User')(txConn);

  //
  // 4) Enregistrer ensuite les autres modèles sur txConn
  //
  require('../models/Transaction')(txConn);
  require('../models/Outbox')(txConn);
  require('../models/Notification')(txConn);
}

/**
 * Retourne la connexion dédiée aux transactions.
 * Depuis n’importe quelle partie du code, appelez d’abord `connectTransactionsDB()`.
 */
function getTxConn() {
  if (!txConn) {
    throw new Error('Transactions DB non initialisée. Appelez connectTransactionsDB() d\'abord.');
  }
  return txConn;
}

module.exports = { connectTransactionsDB, getTxConn };
