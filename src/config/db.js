// src/config/db.js
const mongoose = require('mongoose');
const config   = require('../config');

let userConn;
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

  // Connexion à la base Users
  userConn = mongoose.createConnection(uriUsers, options);
  userConn.once('open', () => {
    console.log(`✅ DB Users connecté : ${userConn.name}`);
  });

  // Connexion à la base Transactions
  txConn = mongoose.createConnection(uriTx, options);
  txConn.once('open', () => {
    console.log(`✅ DB Transactions connecté : ${txConn.name}`);
  });

  // Charger les modèles
  require('../models/User')(userConn);
  require('../models/Transaction')(txConn);
}

module.exports = { connectTransactionsDB, userConn, txConn };
