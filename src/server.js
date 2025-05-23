/* src/server.js */
require('dotenv-safe').config();
const express          = require('express');
const helmet           = require('helmet');
const cors             = require('cors');
const compression      = require('compression');
const rateLimit        = require('express-rate-limit');
const mongoSanitize    = require('express-mongo-sanitize');
const xssClean         = require('xss-clean');
const hpp              = require('hpp');
const morgan           = require('morgan');
const cookieParser     = require('cookie-parser');
const timeout          = require('connect-timeout');
const { connectTransactionsDB } = require('./config/db');
const config           = require('./config');

const transactionRoutes = require('./routes/transactionsRoutes');
const errorHandler     = require('./middleware/errorHandler');

const app = express();
app.set('trust proxy', 1);

// ─── Sécurité HTTP Headers ───────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: config.corsOrigin || '*',
  credentials: true
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

// ─── Protection NoSQL / XSS / HPP ─────────────────────────────────────────────
app.use(mongoSanitize());
app.use(xssClean());
app.use(hpp());

// ─── Compression & Logging ────────────────────────────────────────────────────
app.use(compression());
app.use(morgan('combined'));

// ─── Timeout des requêtes ─────────────────────────────────────────────────────
app.use(timeout('30s'));
app.use((req, res, next) => req.timedout ? null : next());

// ─── Rate limiter global (100 requêtes / 15 minutes) ──────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    error: 'Trop de requêtes, veuillez réessayer plus tard.'
  }
}));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'UP', timestamp: new Date().toISOString() })
);

// ─── Routes API ───────────────────────────────────────────────────────────────
app.use('/api/v1/transactions', transactionRoutes);

// ─── 404 si aucune route ne matche ────────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({ success: false, error: 'Ressource non trouvée' })
);

// ─── Middleware global de gestion d’erreurs ──────────────────────────────────
app.use(errorHandler);

// ─── Lancement du serveur après connexion à la DB ─────────────────────────────
(async () => {
  try {
    await connectTransactionsDB();  // <-- plus d’argument ici
    app.listen(config.port, () =>
      console.log(`🚀 Service transactions lancé sur le port ${config.port}`)
    );
  } catch (err) {
    console.error('Échec de la connexion DB ou du démarrage du serveur :', err);
    process.exit(1);
  }
})();

// ─── Catch des promesses non gérées ───────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Optionnel : notifier ou shutdown si besoin
});
