// src/server.js
require('dotenv-safe').config({
  allowEmptyValues: false,
});
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

const config               = require('./config');
const { connectTransactionsDB } = require('./config/db');
const transactionRoutes    = require('./routes/transactionsRoutes');
const errorHandler         = require('./middleware/errorHandler');

// Initialise Express
const app = express();
app.set('trust proxy', 1);

// Security headers + CSP
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // complétez selon vos besoins
    }
  }
}));
app.use(hsts({ maxAge: 31536000 }));
//Si vous souhaitez forcer HTTPS en production, installez express-sslify et décommentez :
const enforceSSL = require('express-sslify').HTTPS;
if (config.env === 'production') app.use(enforceSSL({ trustProtoHeader: true }));

// CORS strict
app.use(cors({
  origin: config.cors.origin,
  credentials: true
}));

// Parsing & sanitization
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

// Compression & logging
app.use(compression());
const winston = require('winston');
const logger  = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [ new winston.transports.Console() ],
});
app.use(morgan('combined', {
  stream: { write: msg => logger.info(msg.trim()) }
}));

// Rate limiter en mémoire
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Trop de requêtes, veuillez réessayer plus tard.'
  }
}));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'UP', timestamp: new Date().toISOString() });
});

// === Remettre la route racine ===
app.get('/', (_req, res) => {
  res.send('🚀 API PayNoval Transactions Service is running');
});

// Transactions routes
app.use('/api/v1/transactions', transactionRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Ressource non trouvée' });
});

// Global error handler
app.use(errorHandler);

// Connect DB and start server
(async () => {
  try {
    await connectTransactionsDB();
    app.listen(config.port, () => {
      logger.info(`🚀 Service transactions démarré sur le port ${config.port}`);
    });
  } catch (err) {
    logger.error('Échec de la connexion DB ou du démarrage du serveur :', err);
    process.exit(1);
  }
})();
