// src/config/db.js
const mongoose = require('mongoose');
// On remonte d’un niveau pour charger correctement config.js
const config = require('../config');

async function connectTransactionsDB() {
  const uri = config.mongo.transactions;
  if (!uri) {
    throw new Error('⚠️ MONGO_URI_API_TRANSACTIONS non défini dans config.mongo.transactions');
  }

  try {
    // Connexion à MongoDB
    const conn = await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log(
      `✅ MongoDB Transactions DB connecté : ` +
      `${conn.connection.host}/${conn.connection.name}`
    );
  } catch (err) {
    console.error(
      '❌ Erreur de connexion à MongoDB Transactions DB :',
      err.message
    );
    throw err;
  }
}

module.exports = { connectTransactionsDB };
