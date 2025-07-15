// File: src/server.js

require('dotenv-safe').config({ allowEmptyValues: false });
const express       = require('express');
const helmet        = require('helmet');
const compression   = require('compression');
const cookieParser  = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const xssClean      = require('xss-clean');
const hpp           = require('hpp');
const morgan        = require('morgan');
const rateLimit     = require('express-rate-limit');
const cors          = require('cors');
const config        = require('./config');
const { connectTransactionsDB } = require('./config/db');
const { protect }   = require('./middleware/authMiddleware');
const errorHandler  = require('./middleware/errorHandler');
const logger        = require('./utils/logger');

// ───── Optionnel : Sentry monitoring erreurs ─────
let sentry = null;
if (process.env.SENTRY_DSN) {
  sentry = require('@sentry/node');
  sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 1.0 });
}

const app = express();
app.set('trust proxy', 1);


// ─── Security middleware ──────────────────────────
app.use(helmet({
  contentSecurityPolicy: false // Pour éviter les soucis CORS en dev (mets true en prod)
}));
app.use(helmet.hsts({ maxAge: 31536000 }));
if (config.env === 'production') {
  const enforceSSL = require('express-sslify').HTTPS;
  app.use(enforceSSL({ trustProtoHeader: true }));
}

// ─── CORS ────────────────────────────────────────
app.use(cors({ origin: config.cors.origin, credentials: true }));

// ─── Body, cookies, sanitize ─────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser({
  httpOnly: true,
  secure: config.env === 'production',
  sameSite: 'strict'
}));
app.use(mongoSanitize());
app.use(xssClean());
app.use(hpp());


// ─── Compression & logging ───────────────────────
app.use(compression());
app.use(morgan('combined', {
  stream: { write: msg => logger.info(msg.trim()) }
}));


// ─── Rate limiter ────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Trop de requêtes, veuillez réessayer plus tard.' }
}));


// ─── Sentry middleware (request) ─────────────────
if (sentry) app.use(sentry.Handlers.requestHandler());


// ─── Healthcheck ─────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'UP', timestamp: new Date().toISOString() })
);
app.get('/', (_req, res) =>
  res.send('🚀 API PayNoval Transactions Service is running')
);


// ─── Connect DB + Register routes ────────────────
(async () => {
  try {
    await connectTransactionsDB();
    const transactionRoutes  = require('./routes/transactionsRoutes');
    const notificationRoutes = require('./routes/notificationRoutes');
    const payRoutes          = require('./routes/pay');

    // ==== ADMIN ROUTES ====
    // (pense à sécuriser avec un middleware admin, ex: requireRole(['admin','superadmin']))
    const adminTransactionRoutes = require('./routes/admin/transactions.admin.routes');
    app.use('/api/v1/admin/transactions', protect, requireRole(['admin','superadmin']), adminTransactionRoutes);

    // ==== API UTILISATEUR ====
    app.use('/api/v1/transactions', protect, transactionRoutes);
    app.use('/api/v1/notifications', protect, notificationRoutes);
    app.use('/api/v1/pay', protect, payRoutes);

    // ── 404 Not found ──
    app.use((req, res) =>
      res.status(404).json({ success: false, error: 'Ressource non trouvée' })
    );

    // ── Error logging ──
    if (sentry) app.use(sentry.Handlers.errorHandler());
    app.use(errorHandler);

    // ── Start server ──
    app.listen(config.port, () => {
      logger.info(`🚀 Service transactions démarré sur le port ${config.port}`);
    });
  } catch (err) {
    logger.error('Échec de la connexion DB ou du démarrage du serveur', err);
    process.exit(1);
  }
})();

