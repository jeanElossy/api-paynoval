// src/config/db.js
const mongoose = require('mongoose');
const config   = require('../config');

let txConn;

async function connectTransactionsDB() {
  const { users: uriUsers, transactions: uriTx } = config.mongo;
  if (!uriUsers) throw new Error('⚠️ MONGO_URI_USERS non défini (config.mongo.users)');
  if (!uriTx)   throw new Error('⚠️ MONGO_URI_TRANSACTIONS non défini (config.mongo.transactions)');

  const options = {
    useNewUrlParser:    true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  };

  // Connexion par défaut Mongoose à la base Users pour valider le JWT
  await mongoose.connect(uriUsers, options);
  console.log(`✅ Default mongoose connecté à la DB Users : ${mongoose.connection.name}`);

  // Connexion distincte pour la base Transactions
  txConn = mongoose.createConnection(uriTx, options);
  txConn.once('open', () => {
    console.log(`✅ DB Transactions connecté : ${txConn.db.databaseName}`);
  });

  // Charger modèles (User sur default, Transaction sur txConn)
  require('../models/User');
  require('../models/Transaction')(txConn);
}

/**
 * Retourne la connexion Transactions, ou lève une erreur si non initialisée
 */
function getTxConn() {
  if (!txConn) throw new Error('Transactions DB non initialisée');
  return txConn;
}

module.exports = { connectTransactionsDB, getTxConn };