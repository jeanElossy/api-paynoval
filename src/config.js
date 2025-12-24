// // File: src/config/index.js
// const path = require('path');

// require('dotenv-safe').config({
//   example: path.resolve(__dirname, '../.env.example'),
//   allowEmptyValues: true,
// });

// const PRINCIPAL_URL = process.env.PRINCIPAL_URL?.trim() || '';
// const GATEWAY_URL = process.env.GATEWAY_URL?.trim() || '';

// // ExchangeRate-API (ou autre provider compatible)
// const rawExchangeUrl = process.env.EXCHANGE_API_URL?.trim();
// const baseExchangeUrl = rawExchangeUrl
//   ? rawExchangeUrl.replace(/\/latest\/.*$/, '')
//   : '';
// const exchangeApiKey = process.env.EXCHANGE_API_KEY;
// const defaultExchangeUrl = exchangeApiKey
//   ? `https://v6.exchangerate-api.com/v6/${exchangeApiKey}`
//   : '';

// module.exports = {
//   env: process.env.NODE_ENV || 'development',
//   port: Number(process.env.PORT) || 3000,
//   logLevel: process.env.LOG_LEVEL || 'info',

//   // Observabilité / Docs
//   sentryDsn: process.env.SENTRY_DSN || '',
//   openapiSpecPath:
//     process.env.OPENAPI_SPEC_PATH ||
//     path.join(__dirname, '../docs/openapi.yaml'),

//   // URLs services
//   principalUrl: PRINCIPAL_URL,
//   gatewayUrl: GATEWAY_URL,

//   // Connexions Mongo
//   mongo: {
//     users: process.env.MONGO_URI_USERS,
//     transactions: process.env.MONGO_URI_TRANSACTIONS,
//   },

//   // Redis (rate-limit + caches)
//   redis: {
//     url: process.env.REDIS_URL,
//     tls: true, // Upstash / hébergeurs managés
//   },

//   // CORS strict, mais configurable
//   cors: {
//     origin: process.env.CORS_ORIGIN
//       ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
//       : ['https://www.paynoval.com'],
//   },

//   // JWT / HMAC
//   jwtSecret: process.env.JWT_SECRET,
//   jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
//   hmacSecret: process.env.HMAC_SECRET,

//   // Email SMTP (fallback si microservice emails indisponible)
//   email: {
//     host: process.env.SMTP_HOST,
//     port: Number(process.env.SMTP_PORT) || 587,
//     secure: process.env.SMTP_SECURE === 'true',
//     auth: {
//       user: process.env.SMTP_USER,
//       pass: process.env.SMTP_PASS,
//     },
//   },

//   // Microservice emails (SendGrid + templates pro)
//   emailMicroserviceUrl: process.env.EMAIL_MICROSERVICE_URL || '',

//   // Exchange service (utilisé par convertAmount)
//   exchange: {
//     apiUrl: baseExchangeUrl || defaultExchangeUrl || '',
//     apiKey: exchangeApiKey || '',
//     cacheTTL: Number(process.env.EXCHANGE_CACHE_TTL) || 3600000, // 1h
//   },

//   // 🔐 Token interne partagé (Gateway → API PayNoval, jobs, etc.)
//   internalToken:
//     process.env.INTERNAL_TOKEN ||
//     process.env.GATEWAY_INTERNAL_TOKEN ||
//     '',

//   // 👤 Email du compte admin trésor PayNoval (utilisé pour les crédits/fees internes)
//   adminEmail: process.env.ADMIN_EMAIL?.trim() || 'admin@paynoval.com',
// };





// File: src/config/index.js
'use strict';

const path = require('path');

require('dotenv-safe').config({
  example: path.resolve(__dirname, '../.env.example'),
  allowEmptyValues: true,
});

const PRINCIPAL_URL = process.env.PRINCIPAL_URL?.trim() || '';
const GATEWAY_URL = process.env.GATEWAY_URL?.trim() || '';

// ExchangeRate-API (ou autre provider compatible)
const rawExchangeUrl = process.env.EXCHANGE_API_URL?.trim();
const baseExchangeUrl = rawExchangeUrl ? rawExchangeUrl.replace(/\/latest\/.*$/, '') : '';
const exchangeApiKey = process.env.EXCHANGE_API_KEY;
const defaultExchangeUrl = exchangeApiKey
  ? `https://v6.exchangerate-api.com/v6/${exchangeApiKey}`
  : '';

/**
 * ✅ Tokens internes (séparés = plus pro)
 * - gateway: token utilisé pour APPELER le Gateway (ou accepter des appels venant du Gateway)
 * - principal: token utilisé pour APPELER le Backend principal (ou accepter des appels venant du principal)
 * - legacy: fallback pour compat (ancien INTERNAL_TOKEN)
 */
const legacyInternalToken = (process.env.INTERNAL_TOKEN || '').trim();

const internalTokens = {
  gateway: (process.env.GATEWAY_INTERNAL_TOKEN || legacyInternalToken || '').trim(),
  principal: (
    process.env.PRINCIPAL_INTERNAL_TOKEN ||
    process.env.INTERNAL_REFERRAL_TOKEN ||
    legacyInternalToken ||
    ''
  ).trim(),
};

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,
  logLevel: process.env.LOG_LEVEL || 'info',

  // Observabilité / Docs
  sentryDsn: process.env.SENTRY_DSN || '',
  openapiSpecPath: process.env.OPENAPI_SPEC_PATH || path.join(__dirname, '../docs/openapi.yaml'),

  // URLs services
  principalUrl: PRINCIPAL_URL,
  gatewayUrl: GATEWAY_URL,

  // Connexions Mongo
  mongo: {
    users: process.env.MONGO_URI_USERS,
    transactions: process.env.MONGO_URI_TRANSACTIONS,
  },

  // Redis (rate-limit + caches)
  redis: {
    url: process.env.REDIS_URL,
    tls: true, // Upstash / hébergeurs managés
  },

  // CORS strict, mais configurable
  cors: {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
      : ['https://www.paynoval.com'],
  },

  // JWT / HMAC
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  hmacSecret: process.env.HMAC_SECRET,

  // Email SMTP (fallback si microservice emails indisponible)
  email: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  },

  // Microservice emails (SendGrid + templates pro)
  emailMicroserviceUrl: process.env.EMAIL_MICROSERVICE_URL || '',

  // Exchange service (utilisé par convertAmount)
  exchange: {
    apiUrl: baseExchangeUrl || defaultExchangeUrl || '',
    apiKey: exchangeApiKey || '',
    cacheTTL: Number(process.env.EXCHANGE_CACHE_TTL) || 3600000, // 1h
  },

  // ✅ NOUVEAU: tokens séparés
  internalTokens,

  // ✅ Legacy: gardé si tu as encore du code qui attend config.internalToken
  internalToken: internalTokens.gateway || internalTokens.principal || legacyInternalToken || '',

  // 👤 Email du compte admin trésor PayNoval
  adminEmail: process.env.ADMIN_EMAIL?.trim() || 'admin@paynoval.com',
};
