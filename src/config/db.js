const mongoose = require('mongoose');
const config   = require('../config');

let txConn = null;

async function connectTransactionsDB() {
  const { users: uriUsers, transactions: uriTx } = config.mongo;
  if (!uriUsers) throw new Error('⚠️ MONGO_URI_USERS non défini (config.mongo.users)');
  if (!uriTx)   throw new Error('⚠️ MONGO_URI_TRANSACTIONS non défini (config.mongo.transactions)');

  const opts = {
    useNewUrlParser:    true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS:     45000,
  };

  // Connexion à la base Users sur la connexion mongoose par défaut
  await mongoose.connect(uriUsers, opts);
  console.log(`✅ DB Users (par défaut) connecté : ${mongoose.connection.name}`);

  // Création d'une connexion distincte pour Transactions
  txConn = mongoose.createConnection(uriTx, opts);
  txConn.on('connected', () => {
    console.log(`✅ DB Transactions connecté : ${txConn.db.databaseName}`);
  });
  txConn.on('error', err => {
    console.error('❌ Erreur connexion Transactions DB :', err);
  });

  // Charger les modèles
  // Le modèle Transaction doit être défini comme une fonction qui prend la connexion en argument
  require('../models/Transaction')(txConn);
  // Le modèle User sera automatiquement lié à la connexion par défaut
  require('../models/User');
}

function getTxConn() {
  if (!txConn) {
    throw new Error('Transactions DB non initialisée');
  }
  return txConn;
}

module.exports = { connectTransactionsDB, getTxConn };
