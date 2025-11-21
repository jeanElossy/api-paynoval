const path = require('path');
require('dotenv-safe').config({
  example: path.resolve(__dirname, '../.env.example'),
  allowEmptyValues: true,
});

const PRINCIPAL_URL = process.env.PRINCIPAL_URL?.trim() || '';
const GATEWAY_URL   = process.env.GATEWAY_URL?.trim()   || '';

const rawExchangeUrl   = process.env.EXCHANGE_API_URL?.trim();
const baseExchangeUrl  = rawExchangeUrl ? rawExchangeUrl.replace(/\/latest\/.*$/, '') : '';
const exchangeApiKey   = process.env.EXCHANGE_API_KEY;
const defaultExchangeUrl = `https://v6.exchangerate-api.com/v6/${exchangeApiKey}`;

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,
  logLevel: process.env.LOG_LEVEL || 'info',

  // Observabilité / Docs
  sentryDsn: process.env.SENTRY_DSN || '',
  openapiSpecPath: process.env.OPENAPI_SPEC_PATH || path.join(__dirname, '../openapi.yaml'),

  // URLs services
  principalUrl: PRINCIPAL_URL,
  gatewayUrl: GATEWAY_URL,

  // Bases
  mongo: {
    users: process.env.MONGO_URI_USERS,
    transactions: process.env.MONGO_URI_TRANSACTIONS,
  },

  redis: {
    url: process.env.REDIS_URL,
  },

  cors: {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
      : ['https://wwww.paynoval.com'],
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

  emailMicroserviceUrl: process.env.EMAIL_MICROSERVICE_URL || '',

  exchange: {
    apiUrl: baseExchangeUrl || defaultExchangeUrl,
    apiKey: exchangeApiKey || '',
    cacheTTL: Number(process.env.EXCHANGE_CACHE_TTL) || 3600000,
  },
};
