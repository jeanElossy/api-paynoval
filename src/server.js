require('dotenv-safe').config();
const express       = require('express');
const helmet        = require('helmet');
const hsts          = require('helmet').hsts;
const compression   = require('compression');
const cookieParser  = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const xssClean      = require('xss-clean');
const hpp           = require('hpp');
const morgan        = require('morgan');
const { createClient } = require('redis');
const rateLimit     = require('express-rate-limit');
const RedisStore    = require('rate-limit-redis');
const enforceSSL    = require('express-sslify').HTTPS;

const config       = require('./config');
const { connectTransactionsDB } = require('./config/db');
const transactionRoutes = require('./routes/transactionsRoutes');
const errorHandler     = require('./middleware/errorHandler');

// Initialise Express
const app = express();
app.set('trust proxy', 1);

// Sécurité
app.use(helmet({ contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"],
  }
}}));
app.use(hsts({ maxAge: 31536000 }));
if (config.env === 'production') app.use(enforceSSL({ trustProtoHeader: true }));

// CORS strict
app.use(require('cors')({ origin: config.cors.origin, credentials: true }));

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

// Winston logger pour Morgan
const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [ new winston.transports.Console() ],
});
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// Rate limiter via Redis
const redisClient = createClient({ url: config.redis.url });
redisClient.connect().catch(console.error);
app.use(rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ sendCommand: (...args) => redisClient.sendCommand(args) }),
  message: { success: false, error: 'Trop de requêtes, réessayez plus tard.' }
}));

// Routes
app.get('/health', (_req, res) => res.json({ status: 'UP', timestamp: new Date().toISOString() }));
app.use('/api/v1/transactions', transactionRoutes);

// 404
app.use((req, res) => res.status(404).json({ success: false, error: 'Ressource non trouvée' }));

// Error handler
app.use(errorHandler);

// Connexion DB et lancement serveur
(async () => {
  await connectTransactionsDB();
  app.listen(config.port, () => logger.info(`🚀 Service transactions sur port ${config.port}`));
})();