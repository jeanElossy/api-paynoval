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
    socketTimeoutMS: 45000,
  };

  // connexion “Users” sur le client mongoose par défaut
  await mongoose.connect(uriUsers, opts);
  console.log(`✅ DB Users (par défaut) connecté : ${mongoose.connection.name}`);

  // connexion distincte “Transactions”
  txConn = mongoose.createConnection(uriTx, opts);
  txConn.once('open', () => {
    console.log(`✅ DB Transactions connecté : ${txConn.db.databaseName}`);
  });

  // charger le schéma Transaction sur txConn
  require('../models/Transaction')(txConn);
  // charger User sur la connexion par défaut
  require('../models/User');
}

function getTxConn() {
  if (!txConn) {
    throw new Error('Transactions DB non initialisée');
  }
  return txConn;
}

module.exports = { connectTransactionsDB, getTxConn };


