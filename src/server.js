// File: src/server.js

require('dotenv-safe').config({ allowEmptyValues: false });
const express       = require('express');
const helmet        = require('helmet');
const hsts          = require('helmet').hsts;
const compression   = require('compression');
const cookieParser  = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const xssClean      = require('xss-clean');
const hpp           = require('hpp');
const morgan        = require('morgan');
const rateLimit     = require('express-rate-limit');
const cors          = require('cors');
const winston       = require('winston');

const config                   = require('./config');
const { connectTransactionsDB } = require('./config/db');
const { protect }              = require('./middleware/authMiddleware');
const errorHandler             = require('./middleware/errorHandler');

// Initialise Express
const app = express();
app.set('trust proxy', 1);

// ─── Security middleware ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: { defaultSrc: ["'self'"] }
  }
}));
app.use(hsts({ maxAge: 31536000 }));
if (config.env === 'production') {
  const enforceSSL = require('express-sslify').HTTPS;
  app.use(enforceSSL({ trustProtoHeader: true }));
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({ origin: config.cors.origin, credentials: true }));

// ─── Parsing & sanitization ────────────────────────────────────────────────────
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

// ─── Compression & logging ────────────────────────────────────────────────────
app.use(compression());
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console()]
});
app.use(morgan('combined', {
  stream: { write: msg => logger.info(msg.trim()) }
}));

// ─── Rate limiter ──────────────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Trop de requêtes, veuillez réessayer plus tard.' }
}));

// ─── Health check & root ───────────────────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'UP', timestamp: new Date().toISOString() })
);
app.get('/', (_req, res) =>
  res.send('🚀 API PayNoval Transactions Service is running')
);

// ─── Connexion aux DBs et démarrage du serveur ─────────────────────────────────
(async () => {
  try {
    // 1) On initialise les connexions Mongoose (Users + Transactions)
    await connectTransactionsDB();

    // 2) Une fois les DBs prêtes, on peut importer les routes qui utilisent les modèles
    const transactionRoutes  = require('./routes/transactionsRoutes');
    const notificationRoutes = require('./routes/notificationRoutes');
    const payRoutes          = require('./routes/pay');
    // 3) Routes protégées
    app.use('/api/v1/transactions', protect, transactionRoutes);
    app.use('/api/v1/notifications', protect, notificationRoutes);
    app.use('/api/v1/pay', protect, payRoutes);


    // 4) 404 handler
    app.use((req, res) =>
      res.status(404).json({ success: false, error: 'Ressource non trouvée' })
    );

    // 5) Error handler
    app.use(errorHandler);

    // 6) Lancement du serveur
    app.listen(config.port, () => {
      logger.info(`🚀 Service transactions démarré sur le port ${config.port}`);
    });
  } catch (err) {
    logger.error('Échec de la connexion DB ou du démarrage du serveur :', err);
    process.exit(1);
  }
})();
