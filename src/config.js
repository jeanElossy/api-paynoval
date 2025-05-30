// src/config.js

const path = require('path');
require('dotenv-safe').config({
  example: path.resolve(__dirname, '../.env.example'),
  allowEmptyValues: true,
});

module.exports = {
  // Environnement
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,

  // ─── MongoDB ────────────────────────────────────────────────────────────────
  mongo: {
    users:        process.env.MONGO_URI_USERS,
    transactions: process.env.MONGO_URI_TRANSACTIONS,
  },

  // ─── Redis (pour rate limiting partagé) ─────────────────────────────────────
  redis: {
    url: process.env.REDIS_URL,
  },

  // ─── CORS (strict origin list) ──────────────────────────────────────────────
  cors: {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',')
      : ['http://localhost:3000'],
  },

  // ─── JWT & HMAC ─────────────────────────────────────────────────────────────
  jwtSecret:    process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  hmacSecret:   process.env.HMAC_SECRET,

  // ─── SMTP pour envoi d'emails (optionnel) ──────────────────────────────────
  email: {
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  },

  // ─── Microservice e-mail (optionnel) ────────────────────────────────────────
  emailMicroserviceUrl: process.env.EMAIL_MICROSERVICE_URL,

  // ─── Exchange Rates Service ────────────────────────────────────────────────
  exchange: {
    apiUrl:   process.env.EXCHANGE_API_URL || 'https://api.exchangerate-api.com/v4', // default to v4 endpoint
    apiKey:   process.env.EXCHANGE_API_KEY || '',
    cacheTTL: Number(process.env.EXCHANGE_CACHE_TTL) || 3600000, // ms
  }
};
