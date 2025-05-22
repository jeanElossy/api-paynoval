// src/config.js
require('dotenv-safe').config();

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,

  // MongoDB URI pour le micro-service Transactions
  mongo: {
    transactions: process.env.MONGO_URI_API_TRANSACTIONS
  },

  // JWT
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',

  // HMAC pour vérification des transactions
  hmacSecret: process.env.HMAC_SECRET,

  // Configuration SMTP pour envoi d'emails
  email: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  },

  // (Optionnel) URL d'un micro-service d'envoi de mails
  emailMicroserviceUrl: process.env.EMAIL_MICROSERVICE_URL
};
