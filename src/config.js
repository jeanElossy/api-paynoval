// src/config.js
const path = require('path');


require('dotenv-safe').config({
  example: path.resolve(__dirname, '../.env.example'),
  allowEmptyValues: false,
});

module.exports = {
  // Environnement d'exécution
  env: process.env.NODE_ENV || 'development',

  // Port d'écoute du serveur
  port: Number(process.env.PORT) || 3000,

  // ─── 2. MongoDB ────────────────────────────────────────────────────────────────
  mongo: {
    // Base de données principale (users, cagnottes, etc.)
    main: process.env.MONGO_URI,
    // Base de données pour le micro-service Transactions
    transactions: process.env.MONGO_URI_API_TRANSACTIONS,
  },

  // ─── 3. JWT ───────────────────────────────────────────────────────────────────
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',

  // ─── 4. HMAC (vérification des payloads de transaction)────────────────────────
  hmacSecret: process.env.HMAC_SECRET,

  // ─── 5. SMTP pour envoi d'emails ───────────────────────────────────────────────
  email: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  },

  // ─── 6. (Optionnel) URL d'un micro-service d'envoi de mails ────────────────────
  emailMicroserviceUrl: process.env.EMAIL_MICROSERVICE_URL,
};
