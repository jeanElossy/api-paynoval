// Fichier : src/config/transactionsDb.js
const mongoose = require('mongoose');

/**
 * Établit la connexion à la base MongoDB dédiée aux transactions.
 * Utilise la variable d'environnement MONGO_URI_TRANSACTIONS.
 * En cas d'erreur de connexion, le processus s'arrête.
 */
const connectTransactionsDB = async () => {
  const uri = process.env.MONGO_URI_API_TRANSACTIONS;
  if (!uri) {
    console.error('❌ La variable MONGO_URI_API_TRANSACTIONS n\'est pas définie');
    process.exit(1);
  }
  try {
    // createConnection crée une connexion séparée de mongoose.connect
    const conn = await mongoose.createConnection(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log(`✅ MongoDB Transactions DB connecté : ${conn.host}/${conn.name}`);
    return conn;
  } catch (err) {
    console.error('❌ Échec de connexion à la base Transactions :', err.message);
    process.exit(1);
  }
};

module.exports = connectTransactionsDB;
