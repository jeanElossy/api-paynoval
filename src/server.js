// File: src/server.js
"use strict";

if (process.env.NODE_ENV !== "production") {
  try {
    require("dotenv-safe").config({ allowEmptyValues: true });
  } catch (e) {
    console.warn("[dotenv-safe] skipped:", e.message);
  }
}

if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "info";
if (process.env.SENTRY_DSN === undefined) process.env.SENTRY_DSN = "";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const mongoSanitize = require("express-mongo-sanitize");
const xssClean = require("xss-clean");
const hpp = require("hpp");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const yaml = require("js-yaml");
const swaggerUi = require("swagger-ui-express");

const config = require("./config");
const { connectTransactionsDB } = require("./config/db");
const { protect } = require("./middleware/authMiddleware");
const errorHandler = require("./middleware/errorHandler");
const logger = require("./utils/logger");
const { requireRole } = require("./middleware/authz");

const tryRequire = (name) => {
  try {
    return require(name);
  } catch (_) {
    return null;
  }
};

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || config.internalToken || "";

// Sentry
let sentry = null;
if (process.env.SENTRY_DSN) {
  const Sentry = tryRequire("@sentry/node");
  if (Sentry) {
    sentry = Sentry;
    sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 1.0 });
  } else {
    logger.warn("[sentry] @sentry/node non installé — Sentry désactivé");
  }
}

const app = express();
app.set("trust proxy", 1);

// OpenAPI
const OPENAPI_PATH =
  process.env.OPENAPI_SPEC_PATH || path.join(__dirname, "../docs/openapi.yaml");

let openapiSpec = {};
try {
  const raw = fs.readFileSync(OPENAPI_PATH, "utf8");
  openapiSpec = yaml.load(raw);
} catch (e) {
  logger.error(`[Swagger] Load error ${OPENAPI_PATH}: ${e.message}`);
  openapiSpec = {
    openapi: "3.0.0",
    info: { title: "Docs indisponibles", version: "0.0.0" },
  };
}

// Security
app.use(helmet({ contentSecurityPolicy: false }));
app.use(helmet.hsts({ maxAge: 31536000 }));

if (config.env === "production") {
  const sslify = tryRequire("express-sslify");
  if (sslify?.HTTPS) {
    app.use(sslify.HTTPS({ trustProtoHeader: true }));
  } else {
    logger.warn("[ssl] express-sslify non installé — redirection HTTPS non appliquée");
  }
}

// CORS
const mergeToList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

const configCors =
  config?.cors?.origins ||
  config?.cors?.origin ||
  config?.cors?.allowedOrigins ||
  [];

const allowedOrigins = [
  ...mergeToList(process.env.CORS_ORIGINS),
  ...mergeToList(configCors),
].filter(Boolean);

const hasWildcard = allowedOrigins.includes("*");

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (hasWildcard) return cb(null, true);
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "X-Request-Id",
      "x-request-id",
      "x-internal-token",
      "x-user-id",
      "x-device-id",
      "x-session-id",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

// Parsers & sanitizers
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser());
app.use(mongoSanitize());
app.use(xssClean());
app.use(hpp());

// Compression & logs
app.use(compression());
app.use(
  morgan("combined", {
    stream: { write: (msg) => logger.info(msg.trim()) },
  })
);

// Sentry (request)
if (sentry) app.use(sentry.Handlers.requestHandler());

// Health
app.get("/health", (_req, res) =>
  res.json({ status: "UP", timestamp: new Date().toISOString() })
);
app.get("/", (_req, res) =>
  res.send("🚀 API PayNoval Transactions Service is running")
);

// Swagger UI
const docsGuards = [];
if (config.env === "production") {
  docsGuards.push(protect, requireRole(["admin", "developer", "superadmin"]));
}
const { contentSecurityPolicy } = require("helmet");

app.use(
  "/docs",
  contentSecurityPolicy({
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"],
    },
  })
);

app.use(
  "/docs",
  docsGuards,
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec, {
    explorer: true,
    customSiteTitle: "PayNoval Interne API",
    swaggerOptions: {
      displayOperationId: true,
      persistAuthorization: true,
    },
  })
);

app.get("/openapi.yaml", (_req, res) => {
  try {
    res.setHeader("Content-Type", "text/yaml; charset=utf-8");
    res.send(fs.readFileSync(OPENAPI_PATH, "utf8"));
  } catch (e) {
    res.status(500).json({ success: false, error: "Spec YAML introuvable" });
  }
});
app.get("/openapi.json", (_req, res) => res.json(openapiSpec));

// Rate limit global
let globalRateLimiter;
let RedisStore, Redis, redisClient;

try {
  ({ RedisStore } = require("rate-limit-redis"));
  Redis = require("ioredis");
} catch (_) {
  /* modules absents */
}

const isTrustedInternalCall = (req) => {
  const headerToken = req.headers["x-internal-token"];
  if (!headerToken || !INTERNAL_TOKEN) return false;
  return safeEqual(headerToken, INTERNAL_TOKEN);
};

if (process.env.REDIS_URL && RedisStore && Redis) {
  redisClient = new Redis(process.env.REDIS_URL, { tls: {} });

  // @ts-ignore
  globalRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
    }),
    message: { success: false, error: "Trop de requêtes, veuillez réessayer plus tard." },
    skip: (req) => {
      if (
        req.path.startsWith("/docs") ||
        req.path.startsWith("/openapi") ||
        req.path === "/health" ||
        req.path === "/api/v1/health"
      ) return true;
      if (isTrustedInternalCall(req)) return true;
      return false;
    },
  });

  logger.info("[rate-limit] Redis store activé");
} else {
  globalRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Trop de requêtes, veuillez réessayer plus tard." },
    skip: (req) => {
      if (
        req.path.startsWith("/docs") ||
        req.path.startsWith("/openapi") ||
        req.path === "/health" ||
        req.path === "/api/v1/health"
      ) return true;
      if (isTrustedInternalCall(req)) return true;
      return false;
    },
  });

  if (process.env.REDIS_URL) {
    logger.warn("[rate-limit] REDIS_URL défini mais modules absents — fallback mémoire activé");
  }
}
app.use(globalRateLimiter);

// Slow-down sur auth / confirmations sensibles
const slowDown = tryRequire("express-slow-down");

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Trop de tentatives. Réessayez plus tard." },
  skip: (req) => isTrustedInternalCall(req),
});

const authSlow = slowDown
  ? slowDown({
      windowMs: 10 * 60 * 1000,
      delayAfter: 10,
      delayMs: () => 250,
    })
  : (_req, _res, next) => next();

app.use(
  ["/api/v1/auth/login", "/api/v1/payments/confirm", "/api/v1/transactions/confirm"],
  authSlow,
  authLimiter
);

// Routes
let server;
(async () => {
  try {
    await connectTransactionsDB();

    const transactionRoutes = require("./routes/transactionsRoutes");
    const notificationRoutes = require("./routes/notificationRoutes");
    const payRoutes = require("./routes/pay");
    const adminTransactionRoutes = require("./routes/admin/transactions.admin.routes");
    const internalPaymentsRoutes = require("./routes/internalPaymentsRoutes");

    app.use(
      "/api/v1/admin/transactions",
      protect,
      requireRole(["admin", "superadmin"]),
      adminTransactionRoutes
    );
    app.use("/api/v1/transactions", protect, transactionRoutes);
    app.use("/api/v1/notifications", protect, notificationRoutes);
    app.use("/api/v1/pay", protect, payRoutes);

    // Appels internes (Gateway, jobs, microservices)
    app.use("/api/v1/internal-payments", internalPaymentsRoutes);

    app.get("/api/v1/health", (_req, res) => res.status(200).json({ status: "ok" }));

    app.use((_req, res) =>
      res.status(404).json({ success: false, error: "Ressource non trouvée" })
    );

    if (sentry) app.use(sentry.Handlers.errorHandler());
    app.use(errorHandler);

    server = app.listen(config.port, () => {
      logger.info(`🚀 Service démarré sur ${config.port} (${config.env})`);
      logger.info(`📘 Docs: /docs  —  Spec: /openapi.yaml /openapi.json`);
    });
  } catch (err) {
    logger.error("Échec démarrage:", err);
    process.exit(1);
  }
})();

// Robustesse process
process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException:", err);
  process.exit(1);
});

const graceful = async (signal) => {
  try {
    logger.info(`[${signal}] Arrêt en cours…`);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      logger.info("HTTP server fermé");
    }
    process.exit(0);
  } catch (e) {
    logger.error("Erreur shutdown:", e);
    process.exit(1);
  }
};
process.on("SIGTERM", () => graceful("SIGTERM"));
process.on("SIGINT", () => graceful("SIGINT"));
