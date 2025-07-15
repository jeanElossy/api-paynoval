// src/config.js

const path = require('path');
require('dotenv-safe').config({
  example: path.resolve(__dirname, '../.env.example'),
  allowEmptyValues: true,
});

// URL du backend principal
const PRINCIPAL_URL = process.env.PRINCIPAL_URL?.trim() || '';

// URL de l’API Gateway (NOUVEAU)
const GATEWAY_URL = process.env.GATEWAY_URL?.trim() || '';

// Préparer l'URL de base pour l'API de change
const rawExchangeUrl = process.env.EXCHANGE_API_URL?.trim();
const baseExchangeUrl = rawExchangeUrl
  ? rawExchangeUrl.replace(/\/latest\/.*$/, '')
  : '';
const exchangeApiKey = process.env.EXCHANGE_API_KEY;
const defaultExchangeUrl = `https://v6.exchangerate-api.com/v6/${exchangeApiKey}`;

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,

  // URL du backend principal
  principalUrl: PRINCIPAL_URL,

  // URL de l’API Gateway
  gatewayUrl: GATEWAY_URL,

  mongo: {
    users: process.env.MONGO_URI_USERS,
    transactions: process.env.MONGO_URI_TRANSACTIONS,
  },

  redis: {
    url: process.env.REDIS_URL,
  },

  cors: {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',')
      : ['http://localhost:3000'],
  },

  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  hmacSecret: process.env.HMAC_SECRET,

  email: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  },

  emailMicroserviceUrl: process.env.EMAIL_MICROSERVICE_URL,

  exchange: {
    apiUrl: baseExchangeUrl || defaultExchangeUrl,
    apiKey: exchangeApiKey || '',
    cacheTTL: Number(process.env.EXCHANGE_CACHE_TTL) || 3600000,
  },
};
