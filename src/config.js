// File: src/config.js

const path = require('path');
require('dotenv-safe').config({
  example: path.resolve(__dirname, '../.env.example'),
  allowEmptyValues: true,
});

// Nouvelle variable pour URL du backend principal
const PRINCIPAL_URL = process.env.PRINCIPAL_URL?.trim() || '';

// Préparer l'URL de base pour l'API de change
const rawExchangeUrl = process.env.EXCHANGE_API_URL?.trim();
// Si l'URL inclut déjà '/latest/...', on retire cette partie pour garder la racine
const baseExchangeUrl = rawExchangeUrl
  ? rawExchangeUrl.replace(/\/latest\/.*$/, '')
  : '';
const exchangeApiKey = process.env.EXCHANGE_API_KEY;
// URL finale par défaut (v6 avec clé dans le path)
const defaultExchangeUrl = `https://v6.exchangerate-api.com/v6/${exchangeApiKey}`;

module.exports = {
  // Environnement
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,

  // URL du backend principal
  principalUrl: PRINCIPAL_URL,

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
    // URL racine de l'API (sans '/latest/...') si fournie, sinon fallback v6
    apiUrl: baseExchangeUrl || defaultExchangeUrl,
    apiKey: exchangeApiKey || '',
    cacheTTL: Number(process.env.EXCHANGE_CACHE_TTL) || 3600000,
  },
};
