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

  // Connexion par défaut Mongoose à la base Users pour Auth/JWT
  try {
    await mongoose.connect(uriUsers, options);
    console.log(`✅ Default mongoose connecté à la DB Users : ${mongoose.connection.name}`);
  } catch (err) {
    console.error('❌ Échec connexion Users DB :', err.message);
    throw err;
  }

  // Connexion distincte pour la base Transactions
  txConn = mongoose.createConnection(uriTx, options);
  txConn.on('error', err => {
    console.error('❌ Erreur connexion Transactions DB :', err.message);
  });
  txConn.once('open', () => {
    console.log(`✅ DB Transactions connecté : ${txConn.db.databaseName}`);
  });

  // Charger modèles
  // User sur la connexion par défaut
  require('../models/User');
  // Transaction sur txConn
  require('../models/Transaction')(txConn);
}

module.exports = { connectTransactionsDB, txConn };
