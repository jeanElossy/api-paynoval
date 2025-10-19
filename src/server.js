// File: src/server.js
// Chargement d'environnement : uniquement en DEV (en PROD, Render fournit les vars)
if (process.env.NODE_ENV !== 'production') {
  try {
    require('dotenv-safe').config({
      allowEmptyValues: true, // en local on permet les valeurs vides
      // path: '.env',
      // example: '.env.example',
    });
  } catch (e) {
    console.warn('[dotenv-safe] skipped:', e.message);
  }
}

// Valeurs par défaut **avant** d'importer le logger (qui lit LOG_LEVEL)
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'info';
if (process.env.SENTRY_DSN === undefined) process.env.SENTRY_DSN = '';

const path             = require('path');
const fs               = require('fs');
const express          = require('express');
const helmet           = require('helmet');
const compression      = require('compression');
const cookieParser     = require('cookie-parser');
const mongoSanitize    = require('express-mongo-sanitize');
const xssClean         = require('xss-clean'); // NOTE: déprécié, gardé pour compat. Voir README pour migrate.
const hpp              = require('hpp');
const morgan           = require('morgan');
const rateLimit        = require('express-rate-limit');
const slowDown         = require('express-slow-down');
const cors             = require('cors');
const yaml             = require('js-yaml');
const swaggerUi        = require('swagger-ui-express');

const config           = require('./config');
const { connectTransactionsDB } = require('./config/db');
const { protect }      = require('./middleware/authMiddleware');
const errorHandler     = require('./middleware/errorHandler');
const logger           = require('./utils/logger');
const { requireRole }  = require('./middleware/authz');

// ------- Sentry (optionnel) -------
let sentry = null;
if (process.env.SENTRY_DSN) {
  sentry = require('@sentry/node');
  sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 1.0 });
}

const app = express();
app.set('trust proxy', 1);

// ---------- OpenAPI ----------
const OPENAPI_PATH = process.env.OPENAPI_SPEC_PATH
  || path.join(__dirname, '../docs/openapi.yaml');

let openapiSpec = {};
try {
  const raw = fs.readFileSync(OPENAPI_PATH, 'utf8');
  openapiSpec = yaml.load(raw);
} catch (e) {
  logger.error(`[Swagger] Load error ${OPENAPI_PATH}: ${e.message}`);
  openapiSpec = { openapi: '3.0.0', info: { title: 'Docs indisponibles', version: '0.0.0' } };
}

// ---------- Security ----------
app.use(helmet({ contentSecurityPolicy: false }));    // API: pas de templates HTML globaux
app.use(helmet.hsts({ maxAge: 31536000 }));           // HSTS 1 an
if (config.env === 'production') {
  const enforceSSL = require('express-sslify').HTTPS;
  app.use(enforceSSL({ trustProtoHeader: true }));
}

// ---------- CORS (liste blanche stricte + credentials) ----------
const mergeToList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
};
const allowedOrigins = [
  ...mergeToList(process.env.CORS_ORIGINS),
  ...mergeToList(config?.cors?.origin),
];

app.use(cors({
  origin(origin, cb) {
    // Autorise outils CLI / healthchecks sans Origin
    if (!origin) return cb(null, true);
    return cb(null, allowedOrigins.includes(origin));
  },
  credentials: true,
  allowedHeaders: ['Authorization','Content-Type','X-Request-Id'],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
}));

// ---------- Parsers & sanitizers ----------
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser({
  httpOnly: true,
  secure: config.env === 'production',
  sameSite: 'strict',
}));
app.use(mongoSanitize());
app.use(xssClean()); // voir NOTE ci-dessus
app.use(hpp());

// ---------- Compression & logs ----------
app.use(compression());
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// ---------- Sentry (request) ----------
if (sentry) app.use(sentry.Handlers.requestHandler());

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ status: 'UP', timestamp: new Date().toISOString() }));
app.get('/', (_req, res) => res.send('🚀 API PayNoval Transactions Service is running'));

// ---------- Swagger UI ----------
// Protège /docs en prod par auth + rôles
const docsGuards = [];
if (config.env === 'production') {
  docsGuards.push(protect, requireRole(['admin', 'developer', 'superadmin']));
}

// CSP légère pour Swagger (nécessite parfois inline). Si possible, envisager nonces à terme.
const { contentSecurityPolicy } = require('helmet');
app.use('/docs', contentSecurityPolicy({
  useDefaults: true,
  directives: {
    "default-src": ["'self'"],
    "script-src":  ["'self'", "'unsafe-inline'"], // swagger-ui a des inlines
    "style-src":   ["'self'", "'unsafe-inline'"],
    "img-src":     ["'self'", "data:"],
    "object-src":  ["'none'"],
    "frame-ancestors": ["'none'"],
  },
}));
app.use('/docs', docsGuards, swaggerUi.serve, swaggerUi.setup(openapiSpec, {
  explorer: true,
  customSiteTitle: 'PayNoval Interne API',
  swaggerOptions: {
    displayOperationId: true,
    persistAuthorization: true,
  },
}));
app.get('/openapi.yaml', (_req, res) => {
  try {
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    res.send(fs.readFileSync(OPENAPI_PATH, 'utf8'));
  } catch (e) {
    res.status(500).json({ success: false, error: 'Spec YAML introuvable' });
  }
});
app.get('/openapi.json', (_req, res) => res.json(openapiSpec));

// ---------- Rate limiters ----------
/**
 *  Limiteur global (store distribué si REDIS_URL défini)
 *  - En mono-instance: mémoire
 *  - En scale-out: Redis
 */
let globalRateLimiter;
if (process.env.REDIS_URL) {
  try {
    const { RedisStore } = require('rate-limit-redis');
    const Redis = require('ioredis');
    const redis = new Redis(process.env.REDIS_URL);
    globalRateLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
      message: { success: false, error: 'Trop de requêtes, veuillez réessayer plus tard.' },
      skip: (req) => req.path.startsWith('/docs') || req.path.startsWith('/openapi'),
    });
    logger.info('[rate-limit] Redis store enabled');
  } catch (e) {
    logger.warn(`[rate-limit] Redis disabled (falling back to memory): ${e.message}`);
  }
}

if (!globalRateLimiter) {
  globalRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Trop de requêtes, veuillez réessayer plus tard.' },
    skip: (req) => req.path.startsWith('/docs') || req.path.startsWith('/openapi'),
  });
}
app.use(globalRateLimiter);

// Limiteurs **dédiés** pour endpoints sensibles (auth/confirmations/OTP)
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Trop de tentatives. Réessayez plus tard.' },
});
const authSlow = slowDown({
  windowMs: 10 * 60 * 1000,
  delayAfter: 10,
  delayMs: 250, // +250ms par requête au-delà de delayAfter
});

// Applique si ces routes existent dans ton app
app.use(
  ['/api/v1/auth/login', '/api/v1/payments/confirm', '/api/v1/transactions/confirm'],
  authSlow,
  authLimiter
);

// ---------- Routes ----------
let server; // pour graceful shutdown
(async () => {
  try {
    await connectTransactionsDB();

    const transactionRoutes      = require('./routes/transactionsRoutes');
    const notificationRoutes     = require('./routes/notificationRoutes');
    const payRoutes              = require('./routes/pay');
    const adminTransactionRoutes = require('./routes/admin/transactions.admin.routes');

    // Admin
    app.use('/api/v1/admin/transactions', protect, requireRole(['admin','superadmin']), adminTransactionRoutes);
    // Utilisateur
    app.use('/api/v1/transactions',   protect, transactionRoutes);
    app.use('/api/v1/notifications',  protect, notificationRoutes);
    app.use('/api/v1/pay',            protect, payRoutes);

    // 404
    app.use((req, res) => res.status(404).json({ success: false, error: 'Ressource non trouvée' }));

    // Sentry (errors) + handler global
    if (sentry) app.use(sentry.Handlers.errorHandler());
    app.use(errorHandler);

    server = app.listen(config.port, () => {
      logger.info(`🚀 Service démarré sur ${config.port} (${config.env})`);
      logger.info(`📘 Docs: /docs  —  Spec: /openapi.yaml /openapi.json`);
    });
  } catch (err) {
    logger.error('Échec démarrage:', err);
    process.exit(1);
  }
})();

// ---------- Robustesse process (graceful shutdown + guards) ----------
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException:', err);
  process.exit(1);
});

const graceful = async (signal) => {
  try {
    logger.info(`[${signal}] Arrêt en cours…`);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      logger.info('HTTP server fermé');
    }
    // TODO: fermer proprement DB, Redis, files, etc.
    process.exit(0);
  } catch (e) {
    logger.error('Erreur shutdown:', e);
    process.exit(1);
  }
};
process.on('SIGTERM', () => graceful('SIGTERM'));
process.on('SIGINT',  () => graceful('SIGINT'));
