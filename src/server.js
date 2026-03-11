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
const logger = require("./logger");
const { requireRole } = require("./middleware/authz");

const tryRequire = (name) => {
  try {
    return require(name);
  } catch (_) {
    return null;
  }
};

function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || "").trim(), "utf8");
  const bb = Buffer.from(String(b || "").trim(), "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function getInternalTokens() {
  const legacy = String(process.env.INTERNAL_TOKEN || config.internalToken || "").trim();

  const gateway = String(
    process.env.GATEWAY_INTERNAL_TOKEN || config?.internalTokens?.gateway || legacy
  ).trim();

  const principal = String(
    process.env.PRINCIPAL_INTERNAL_TOKEN ||
      process.env.INTERNAL_REFERRAL_TOKEN ||
      config?.internalTokens?.principal ||
      legacy
  ).trim();

  return { legacy, gateway, principal };
}

function getHeaderInternalToken(req) {
  const raw = req.headers["x-internal-token"] || "";
  return Array.isArray(raw) ? raw[0] : raw;
}

function isTrustedInternalCall(req) {
  const got = String(getHeaderInternalToken(req) || "").trim();
  if (!got) return false;

  const { gateway, principal, legacy } = getInternalTokens();
  const expected = [gateway, principal, legacy]
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  if (!expected.length) return false;

  return expected.some((exp) => timingSafeEqualStr(got, exp));
}

// ─────────────────────────────────────────────────────────────
// Sentry
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// OpenAPI
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// Security headers
// ─────────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(helmet.hsts({ maxAge: 31536000, includeSubDomains: true, preload: true }));

if (config.env === "production") {
  const sslify = tryRequire("express-sslify");
  if (sslify?.HTTPS) {
    app.use(sslify.HTTPS({ trustProtoHeader: true }));
  } else {
    logger.warn("[ssl] express-sslify non installé — redirection HTTPS non appliquée");
  }
}

// ─────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────
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
      "x-provider",
      "x-rail",
      "x-signature",
      "x-timestamp",
      "x-wave-signature",
      "x-wave-timestamp",
      "x-orange-signature",
      "x-orange-timestamp",
      "x-mtn-signature",
      "x-mtn-timestamp",
      "x-moov-signature",
      "x-moov-timestamp",
      "x-bank-signature",
      "x-bank-timestamp",
      "stripe-signature",
      "x-stripe-signature",
      "x-visa-signature",
      "x-visa-timestamp",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

// ─────────────────────────────────────────────────────────────
// Compression & logs
// ─────────────────────────────────────────────────────────────
app.use(compression());
app.use(
  morgan("combined", {
    stream: { write: (msg) => logger.info(msg.trim()) },
  })
);

if (sentry && sentry.Handlers?.requestHandler) {
  app.use(sentry.Handlers.requestHandler());
}

// ─────────────────────────────────────────────────────────────
// Body parsers
// ─────────────────────────────────────────────────────────────
app.use(
  express.json({
    limit: "256kb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

app.use(express.urlencoded({ extended: true, limit: "50kb" }));
app.use(cookieParser());

// ─────────────────────────────────────────────────────────────
// Health / Root
// ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ status: "UP", timestamp: new Date().toISOString() })
);
app.get("/", (_req, res) =>
  res.send("🚀 API PayNoval Transactions Service is running")
);

// ─────────────────────────────────────────────────────────────
// Swagger UI
// ─────────────────────────────────────────────────────────────
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
  } catch (_e) {
    res.status(500).json({ success: false, error: "Spec YAML introuvable" });
  }
});

app.get("/openapi.json", (_req, res) => res.json(openapiSpec));

// ─────────────────────────────────────────────────────────────
// Sanitizers
// IMPORTANT:
// - Les webhooks providers seront montés APRÈS bootstrap DB
// - mais TOUJOURS avant mongoSanitize/xssClean/hpp
// ─────────────────────────────────────────────────────────────
function mountSanitizers() {
  app.use(mongoSanitize());
  app.use(xssClean());
  app.use(hpp());
}

// ─────────────────────────────────────────────────────────────
// Rate limit global
// ─────────────────────────────────────────────────────────────
let globalRateLimiter;
let RedisStore, Redis, redisClient;

try {
  ({ RedisStore } = require("rate-limit-redis"));
  Redis = require("ioredis");
} catch (_) {
  // modules absents
}

const baseRateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Trop de requêtes, veuillez réessayer plus tard.",
  },
  skip: (req) => {
    if (
      req.path.startsWith("/docs") ||
      req.path.startsWith("/openapi") ||
      req.path === "/health" ||
      req.path === "/api/v1/health" ||
      req.path.startsWith("/webhooks/providers")
    ) {
      return true;
    }

    if (isTrustedInternalCall(req)) return true;

    return false;
  },
};

if (process.env.REDIS_URL && RedisStore && Redis) {
  redisClient = new Redis(process.env.REDIS_URL, { tls: {} });

  globalRateLimiter = rateLimit({
    ...baseRateLimitConfig,
    store: new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
    }),
  });

  logger.info("[rate-limit] Redis store activé");
} else {
  globalRateLimiter = rateLimit(baseRateLimitConfig);

  if (process.env.REDIS_URL) {
    logger.warn("[rate-limit] REDIS_URL défini mais modules absents — fallback mémoire activé");
  }
}

app.use(globalRateLimiter);

// ─────────────────────────────────────────────────────────────
// Slow-down / protection routes sensibles
// ─────────────────────────────────────────────────────────────
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

let server = null;

async function bootstrap() {
  try {
    await connectTransactionsDB();

    // IMPORTANT:
    // on charge les routes seulement APRÈS la connexion DB
    const providerWebhookRoutes = require("./routes/providerWebhookRoutes");
    const transactionRoutes = require("./routes/transactionsRoutes");
    const notificationRoutes = require("./routes/notificationRoutes");
    const payRoutes = require("./routes/pay");
    const adminTransactionRoutes = require("./routes/admin/transactions.admin.routes");
    const internalPaymentsRoutes = require("./routes/internalPaymentsRoutes");
    const internalTxRoutes = require("./routes/internalTransactions.routes");
    const cagnotteSettlementRoutes = require("./routes/cagnotteSettlementRoutes");

    // Webhooks AVANT sanitizers
    app.use("/webhooks/providers", providerWebhookRoutes);

    // Sanitizers après webhooks
    mountSanitizers();

    // Admin
    app.use(
      "/api/v1/admin/transactions",
      protect,
      requireRole(["admin", "superadmin"]),
      adminTransactionRoutes
    );

    // Public / user
    app.use("/api/v1/transactions", transactionRoutes);
    app.use("/api/v1/notifications", protect, notificationRoutes);
    app.use("/api/v1/pay", protect, payRoutes);

    // Internal
    app.use("/api/v1/internal", internalTxRoutes);
    app.use("/api/v1/internal-payments", internalPaymentsRoutes);

    app.use("/api/v1/cagnotte", cagnotteSettlementRoutes);

    app.get("/api/v1/health", (_req, res) =>
      res.status(200).json({ status: "ok", timestamp: new Date().toISOString() })
    );

    app.use((_req, res) =>
      res.status(404).json({ success: false, error: "Ressource non trouvée" })
    );

    if (sentry && sentry.Handlers?.errorHandler) {
      app.use(sentry.Handlers.errorHandler());
    }

    app.use(errorHandler);

    server = app.listen(config.port, () => {
      logger.info(`🚀 Service démarré sur ${config.port} (${config.env})`);
      logger.info(`📘 Docs: /docs  —  Spec: /openapi.yaml /openapi.json`);
      logger.info("🔐 Webhooks providers: /webhooks/providers/:rail/:provider");
    });
  } catch (err) {
    logger.error("Échec démarrage:", err);
    process.exit(1);
  }
}

bootstrap();

// ─────────────────────────────────────────────────────────────
// Robustesse process
// ─────────────────────────────────────────────────────────────
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

    try {
      if (redisClient) await redisClient.quit();
    } catch (_) {}

    process.exit(0);
  } catch (e) {
    logger.error("Erreur shutdown:", e);
    process.exit(1);
  }
};

process.on("SIGTERM", () => graceful("SIGTERM"));
process.on("SIGINT", () => graceful("SIGINT"));