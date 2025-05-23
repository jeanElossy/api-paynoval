const mongoose = require('mongoose');
const config   = require('./config');

let userConn;
let txConn;

async function connectTransactionsDB() {
  const { users: uriUsers, transactions: uriTx } = config.mongo;
  if (!uriUsers) throw new Error('MONGO_URI_USERS non défini');
  if (!uriTx)   throw new Error('MONGO_URI_TRANSACTIONS non défini');

  const options = {
    useNewUrlParser:    true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  };
  userConn = await mongoose.createConnection(uriUsers, options);
  console.log(`✅ DB Users connecté : ${userConn.host}/${userConn.name}`);

  txConn = await mongoose.createConnection(uriTx, options);
  console.log(`✅ DB Transactions connecté : ${txConn.host}/${txConn.name}`);

  // Charger modèles
  require('../models/User')(userConn);
  require('../models/Transaction')(txConn);
}

module.exports = { connectTransactionsDB, userConn, txConn };