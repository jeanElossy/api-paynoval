// src/config/db.js

const mongoose = require('mongoose');
const config   = require('../config');

let txConn = null;

/**
 * Initialise les connexions Mongoose :
 * - Connexion principale (mongoose) → User, utilisé côté API principal
 * - Connexion secondaire (txConn)   → Transaction, Outbox, Notification (service transactions)
 */
async function connectTransactionsDB() {
  const { users: uriUsers, transactions: uriTx } = config.mongo;
  if (!uriUsers) throw new Error('⚠️ MONGO_URI_USERS non défini (config.mongo.users)');
  if (!uriTx)    throw new Error('⚠️ MONGO_URI_TRANSACTIONS non défini (config.mongo.transactions)');

  const opts = {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  };

  // 1) Connexion principale (mongoose) → Users (global)
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uriUsers, opts);
    console.log(`✅ DB Users connectée : ${mongoose.connection.name}`);
    require('../models/User')(); // charge modèle User sur mongoose par défaut
  }

  // 2) Connexion dédiée txConn → Transactions/Outbox/Notification
  if (!txConn) {
    txConn = mongoose.createConnection(uriTx, opts);
    await txConn.asPromise();
    console.log(`✅ DB Transactions connectée : ${txConn.name}`);

    // Enregistre User aussi sur txConn (sinon Population ne marche pas)
    require('../models/User')(txConn);

    // Autres modèles transactionnels sur txConn
    require('../models/Transaction')(txConn);
    require('../models/Outbox')(txConn);
    require('../models/Notification')(txConn);
  }
}

/**
 * Récupère la connexion transactionnelle (fail si non initialisée)
 */
function getTxConn() {
  if (!txConn) {
    throw new Error('Transactions DB non initialisée. Appelez connectTransactionsDB() d\'abord.');
  }
  return txConn;
}

/**
 * (Optionnel) Récupère la connexion Users principale (mongoose)
 */
function getUsersConn() {
  return mongoose.connection;
}

module.exports = { connectTransactionsDB, getTxConn, getUsersConn };
