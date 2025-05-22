/* src/server.js */
require('dotenv-safe').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xssClean = require('xss-clean');
const hpp = require('hpp');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const timeout = require('connect-timeout');
const connectDB = require('./config/db');
const config = require('./config');

const transactionRoutes = require('./routes/transactionsRoutes');
const errorHandler = require('./middleware/errorHandler');

const app = express();
app.set('trust proxy', 1);

// === Sécurité HTTP Headers ===
app.use(helmet({ contentSecurityPolicy: false }));

// CORS
app.use(cors({ origin: config.corsOrigin || '*', credentials: true }));

// Parsing JSON & URL-encoded
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

// Protection contre NoSQL injection
app.use(mongoSanitize());

// Protection contre XSS
app.use(xssClean());

// Protection HTTP Parameter Pollution
app.use(hpp());

// GZIP compression
app.use(compression());

// Logging
app.use(morgan('combined'));

// Timeout requests
app.use(timeout('30s')); 
app.use((req, res, next) => req.timedout ? null : next());

// Limiter global (100 req / 15min)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, error: 'Trop de requêtes, veuillez réessayer plus tard.' }
});
app.use(globalLimiter);

// Health check
app.get('/health', (_, res) => res.json({ status: 'UP', timestamp: new Date().toISOString() }));

// API versioning
app.use('/api/v1/transactions', transactionRoutes);

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({ success: false, error: 'Ressource non trouvée' });
});

// Error handler (last middleware)
app.use(errorHandler);

// === Lancement du serveur ===
(async () => {
  try {
    await connectDB(config.mongo.transactions);
    app.listen(config.port, () => 
      console.log(`🚀 Service transactions lancé sur le port ${config.port}`)
    );
  } catch (err) {
    console.error('Échec de la connexion DB ou du démarrage du serveur:', err);
    process.exit(1);
  }
})();

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  // Optionnel: notifier, shutdown, etc.
});
