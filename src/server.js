// File: src/server.js
require('dotenv-safe').config({ allowEmptyValues: false });

const path             = require('path');
const fs               = require('fs');
const express          = require('express');
const helmet           = require('helmet');
const compression      = require('compression');
const cookieParser     = require('cookie-parser');
const mongoSanitize    = require('express-mongo-sanitize');
const xssClean         = require('xss-clean');
const hpp              = require('hpp');
const morgan           = require('morgan');
const rateLimit        = require('express-rate-limit');
const cors             = require('cors');
const yaml             = require('js-yaml');
const swaggerUi        = require('swagger-ui-express');

const config           = require('./config');
const { connectTransactionsDB } = require('./config/db');
const { protect }      = require('./middleware/authMiddleware');
const errorHandler     = require('./middleware/errorHandler');
const logger           = require('./utils/logger');
const { requireRole }  = require('./middleware/authz');

let sentry = null;
if (process.env.SENTRY_DSN) {
  sentry = require('@sentry/node');
  sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 1.0 });
}

const app = express();
app.set('trust proxy', 1);

// ---------- OpenAPI ----------
const OPENAPI_PATH = process.env.OPENAPI_SPEC_PATH
  || path.join(__dirname, '../docs/openapi.yaml'); // <- standardise ici

let openapiSpec = {};
try {
  const raw = fs.readFileSync(OPENAPI_PATH, 'utf8');
  openapiSpec = yaml.load(raw);
} catch (e) {
  logger.error(`[Swagger] Load error ${OPENAPI_PATH}: ${e.message}`);
  openapiSpec = { openapi: '3.0.0', info: { title: 'Docs indisponibles', version: '0.0.0' } };
}

// ---------- Security ----------
app.use(helmet({ contentSecurityPolicy: false }));
app.use(helmet.hsts({ maxAge: 31536000 }));
if (config.env === 'production') {
  const enforceSSL = require('express-sslify').HTTPS;
  app.use(enforceSSL({ trustProtoHeader: true }));
}

// ---------- CORS ----------
app.use(cors({ origin: config.cors.origin, credentials: true }));

// ---------- Parsers & sanitizers ----------
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser({
  httpOnly: true,
  secure: config.env === 'production',
  sameSite: 'strict',
}));
app.use(mongoSanitize());
app.use(xssClean());
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
// (Optionnel) protège /docs en prod
const docsGuards = [];
if (config.env === 'production') {
  docsGuards.push(protect, requireRole(['admin', 'developer', 'superadmin']));
}
// CSP léger pour Swagger (scripts/styles inline)
const { contentSecurityPolicy } = require('helmet');
app.use('/docs', contentSecurityPolicy({
  useDefaults: true,
  directives: {
    "script-src": ["'self'", "'unsafe-inline'"],
    "style-src":  ["'self'", "'unsafe-inline'"],
    "img-src":    ["'self'", "data:"],
  },
}));
app.use('/docs', docsGuards, swaggerUi.serve, swaggerUi.setup(openapiSpec, {
  explorer: true,
  customSiteTitle: 'PayNoval Interne API',
  swaggerOptions: {
    displayOperationId: true,
    persistAuthorization: true, // ← garde le Bearer entre refresh
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

// ---------- Rate limiter (après /docs pour ne pas brider l’UI) ----------
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Trop de requêtes, veuillez réessayer plus tard.' },
  skip: (req) => req.path.startsWith('/docs') || req.path.startsWith('/openapi'),
});
app.use(limiter);

// ---------- Routes ----------
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

    app.listen(config.port, () => {
      logger.info(`🚀 Service démarré sur ${config.port} (${config.env})`);
      logger.info(`📘 Docs: /docs  —  Spec: /openapi.yaml /openapi.json`);
    });
  } catch (err) {
    logger.error('Échec démarrage:', err);
    process.exit(1);
  }
})();
