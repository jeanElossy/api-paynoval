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

  // 1) Connexion principale (default) → pour le User “global”
  await mongoose.connect(uriUsers, opts);
  console.log(`✅ DB Users connectée : ${mongoose.connection.name}`);
  require('../models/User')(); // Ceci enregistre le modèle User sur la connexion principale

  // 2) Connexion dédiée txConn → pour le service “transactions”
  txConn = mongoose.createConnection(uriTx, opts);
  await txConn.asPromise();
  console.log(`✅ DB Transactions connectée : ${txConn.name}`);

  // 3) Enregistrer le schéma User sur txConn, AVANT d’enregistrer Transaction
  require('../models/User')(txConn);

  // 4) Enregistrer ensuite les autres modèles sur txConn
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
