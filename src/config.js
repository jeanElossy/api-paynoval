require('dotenv').config();
const axios      = require('axios');
const Joi        = require('joi');
const pino       = require('pino');
const LRU        = require('lru-cache');

// Charger axios-retry quel que soit le format d’export
const rawRetry   = require('axios-retry');
const axiosRetry = rawRetry.default || rawRetry;

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ─── Validation des env vars ─────────────────────────────────────────────────
const envSchema = Joi.object({
  EXCHANGE_API_URL:   Joi.string().uri().default('https://api.exchangerate-api.com/v4'),
  EXCHANGE_API_KEY:   Joi.string(),
  EXCHANGE_CACHE_TTL: Joi.number().integer().min(1000).default(60 * 60 * 1000) // ms
}).unknown();

const { error: envError, value: env } = envSchema.validate(process.env);
if (envError) {
  logger.error({ envError }, 'Config invalide pour exchangeRates');
  throw new Error(`Config error: ${envError.message}`);
}

const BASE_URL  = env.EXCHANGE_API_URL;
const API_KEY   = env.EXCHANGE_API_KEY;
const CACHE_TTL = env.EXCHANGE_CACHE_TTL;

// ─── Setup axios + retry exponentiel ────────────────────────────────────────
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: err => axiosRetry.isNetworkOrIdempotentRequestError(err)
});

// ─── Cache LRU par devise ─────────────────────────────────────────────────────
const cache = new LRU({ max: 50, ttl: CACHE_TTL });

// ─── Validation du paramètre `base` ──────────────────────────────────────────
const baseSchema = Joi.string()
  .uppercase()
  .length(3)
  .default('USD');

// ─── Fetch depuis l’API externe ───────────────────────────────────────────────
async function fetchRatesFromApi(base) {
  const url    = `${BASE_URL}/latest/${encodeURIComponent(base)}`;
  const params = API_KEY ? { apiKey: API_KEY } : {};
  const resp   = await axios.get(url, { params, timeout: 5000 });
  if (resp.status !== 200) {
    throw new Error(`Exchange API error: ${resp.status}`);
  }
  const { base: respBase, date, rates } = resp.data;
  return { base: respBase, date, rates };
}

// ─── getRates (cache + validation) ──────────────────────────────────────────
async function getRates(rawBase) {
  const { error: baseError, value: base } = baseSchema.validate(rawBase);
  if (baseError) {
    logger.error({ baseError, rawBase }, 'Devise invalide');
    throw new Error(`Invalid base currency: ${baseError.message}`);
  }

  if (cache.has(base)) {
    logger.debug({ base }, 'Taux depuis cache');
    return cache.get(base);
  }

  try {
    const fresh = await fetchRatesFromApi(base);
    cache.set(base, fresh);
    logger.info({ base, timestamp: Date.now() }, 'Taux mis en cache');
    return fresh;
  } catch (err) {
    logger.error({ err, base }, 'Échec fetchRatesFromApi');
    throw err;
  }
}

function clearCache() {
  cache.clear();
  logger.info('Cache vidé');
}

module.exports = {
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

  emailMicroserviceUrl: process.env.EMAIL_MICROSERVICE_URL,

  // ─── Exchange Rates Service ────────────────────────────────────────────────
  exchange: {
    apiUrl:   process.env.EXCHANGE_API_URL,
    apiKey:   process.env.EXCHANGE_API_KEY,
    cacheTTL: Number(process.env.EXCHANGE_CACHE_TTL) || 3600000, // en ms
  }
};
