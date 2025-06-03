// File: src/utils/generateRef.js

const crypto = require('crypto');
const { getTxConn } = require('../config/db');

// Fonction utilitaire pour récupérer le modèle "Transaction" sur la connexion dédiée
const TransactionModel = () => getTxConn().model('Transaction');

/**
 * Génère une référence alphanumérique unique préfixée par "PNV-"
 * Combinaison de timestamp (6 derniers chiffres) + 4 octets hexadécimaux.
 */
async function generateTransactionRef() {
  const PREFIX = 'PNV-';

  while (true) {
    // 1) 6 derniers chiffres du timestamp
    const timestampPart = Date.now().toString().slice(-6);
    // 2) 4 octets random (8 hexadécimaux) en MAJUSCULES
    const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
    const candidate = `${PREFIX}${timestampPart}${randomPart}`;

    // Vérification d’existence en base
    const exists = await TransactionModel().findOne({ reference: candidate }).lean();
    if (!exists) {
      return candidate;
    }
    // Si collision (improbable), on boucle de nouveau
  }
}

module.exports = generateTransactionRef;
