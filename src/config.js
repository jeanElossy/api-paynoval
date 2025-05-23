// src/config.js
const path = require('path');

// On autorise les variables manquantes (car ce service n’a besoin que de MONGO_URI_API_TRANSACTIONS)
require('dotenv-safe').config({
  example: path.resolve(__dirname, '../.env.example'),
  allowEmptyValues: true,
});

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,

  // ─── MongoDB ────────────────────────────────────────────────────────────────
  mongo: {
    // Remarquez qu’on ne réclame plus MONGO_URI ici
    transactions: process.env.MONGO_URI_API_TRANSACTIONS,
  },

  // ─── JWT ───────────────────────────────────────────────────────────────────
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',

  // ─── HMAC ──────────────────────────────────────────────────────────────────
  hmacSecret: process.env.HMAC_SECRET,

  // ─── SMTP pour envoi d'emails ───────────────────────────────────────────────
  email: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  },

  // ─── (Optionnel) URL d'un micro-service d'envoi de mails ────────────────────
  emailMicroserviceUrl: process.env.EMAIL_MICROSERVICE_URL,

  // ─── CORS (facultatif) ──────────────────────────────────────────────────────
  corsOrigin: process.env.CORS_ORIGIN,
};
