"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * VALIDATION DE LA CONFIGURATION — ICI, ET NULLE PART AILLEURS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * C'est le point d'entrée du service : c'est donc lui qui décide si
 * l'environnement est acceptable. Auparavant, `src/config.js` levait au premier
 * `require`, ce qui rendait tout module en dépendant impossible à charger dans
 * un test — et a façonné l'architecture du dépôt par accident plutôt que par
 * choix (voir l'en-tête de `src/config.js`).
 *
 * Le contrôle est **plus strict qu'avant**, pas moins : il s'applique désormais
 * en développement comme en production, alors que le bloc précédent avalait
 * l'erreur hors production (`console.warn("[dotenv-safe] skipped")`). Un
 * démarrage avec une variable manquante s'arrête net et dit laquelle.
 *
 * `CONFIG_STRICT=false` est une échappatoire d'outillage — jamais pour un
 * service qui sert du trafic.
 */
const config = require("./config");

const CONFIG_STRICT =
  String(process.env.CONFIG_STRICT ?? "true").toLowerCase() !== "false";

try {
  config.load({ strict: CONFIG_STRICT });
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
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
const jwt = require("jsonwebtoken");
const cors = require("cors");
const yaml = require("js-yaml");
const swaggerUi = require("swagger-ui-express");

// `config` est déjà chargé et validé en tête de fichier.
const { connectTransactionsDB } = require("./config/db");
const { protect } = require("./middleware/authMiddleware");
const errorHandler = require("./middleware/errorHandler");
const logger = require("./logger");

const { getTxConn, getUsersConn } = require("./config/db");
const { createReadiness } = require("./services/readiness");

/**
 * Sondes de disponibilité — voir `src/services/readiness.js`.
 *
 * Les deux connexions sont critiques : `tx` porte le grand livre, `users` sert
 * à résoudre les comptes. L'une sans l'autre ne permet pas de traiter une
 * transaction.
 */
const readiness = createReadiness({
  readConnections: () => {
    const states = ["disconnected", "connected", "connecting", "disconnecting"];
    const label = (rs) => states[rs] || "unknown";

    const read = (getter) => {
      try {
        const c = getter?.();
        return c ? label(c.readyState) : "not_initialized";
      } catch {
        return "unknown";
      }
    };

    return { tx: read(getTxConn), users: read(getUsersConn) };
  },
  required: ["tx", "users"],
  logger,
});
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
  const legacy = String(
    process.env.INTERNAL_TOKEN || config.internalToken || ""
  ).trim();

  const gateway = String(
    process.env.GATEWAY_INTERNAL_TOKEN ||
      config?.internalTokens?.gateway ||
      legacy
  ).trim();

  const principal = String(
    process.env.PRINCIPAL_INTERNAL_TOKEN ||
      process.env.INTERNAL_REFERRAL_TOKEN ||
      config?.internalTokens?.principal ||
      legacy
  ).trim();

  const txCore = String(
    process.env.TX_CORE_INTERNAL_TOKEN ||
      config?.internalTokens?.txCore ||
      legacy
  ).trim();

  return {
    legacy,
    gateway,
    principal,
    txCore,
  };
}

function getHeaderInternalToken(req) {
  const raw =
    req.headers["x-internal-token"] ||
    req.headers["x-paynoval-internal-token"] ||
    "";

  return Array.isArray(raw) ? raw[0] : raw;
}

function isTrustedInternalCall(req) {
  const got = String(getHeaderInternalToken(req) || "").trim();
  if (!got) return false;

  const { gateway, principal, legacy, txCore } = getInternalTokens();

  const expected = [gateway, principal, legacy, txCore]
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
    sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 1.0,
    });
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
    info: {
      title: "Docs indisponibles",
      version: "0.0.0",
    },
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

app.use(
  helmet.hsts({
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  })
);

if (config.env === "production") {
  const sslify = tryRequire("express-sslify");

  if (sslify?.HTTPS) {
    app.use(sslify.HTTPS({ trustProtoHeader: true }));
  } else {
    logger.warn(
      "[ssl] express-sslify non installé — redirection HTTPS non appliquée"
    );
  }
}

// ─────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────
const mergeToList = (value) => {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

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

      "Idempotency-Key",
      "idempotency-key",
      "x-idempotency-key",

      "x-internal-token",
      "x-paynoval-internal-token",
      "x-service-name",
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
    stream: {
      write: (msg) => logger.info(msg.trim()),
    },
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
/**
 * VIVACITÉ. Toujours 200 tant que la boucle d'événements répond — elle ne doit
 * dépendre d'aucune dépendance externe, sinon l'orchestrateur redémarre
 * l'instance en boucle pendant une panne Mongo. Voir `src/services/readiness.js`.
 */
app.get("/health", (_req, res) =>
  res.json({
    status: "UP",
    timestamp: new Date().toISOString(),
  })
);

app.get("/healthz", (_req, res) =>
  res.json({
    status: "UP",
    timestamp: new Date().toISOString(),
  })
);

/**
 * DISPONIBILITÉ. 503 quand une connexion critique manque.
 *
 * ⚠️ C'est CETTE route que le répartiteur doit interroger. Sur ce service en
 * particulier, une instance qui ne peut pas atteindre la base des transactions
 * ne doit recevoir AUCUNE requête : elle échouerait au milieu d'un mouvement
 * d'argent plutôt qu'avant.
 */
app.get("/readyz", (_req, res) => {
  const state = readiness.snapshot();

  res.set("Cache-Control", "no-store");

  return res.status(state.httpStatus).json({
    ready: state.ready,
    status: state.status,
    checks: state.checks,
    timestamp: new Date().toISOString(),
  });
});

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
    res.status(500).json({
      success: false,
      error: "Spec YAML introuvable",
    });
  }
});

app.get("/openapi.json", (_req, res) => res.json(openapiSpec));

// ─────────────────────────────────────────────────────────────
// Sanitizers
// IMPORTANT :
// - Les webhooks providers doivent rester AVANT les sanitizers
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
let RedisStore;
let Redis;
let redisClient;

try {
  ({ RedisStore } = require("rate-limit-redis"));
  Redis = require("ioredis");
} catch (_) {
  // fallback mémoire
}

/**
 * ═══ LE PLAFOND SE COMPTE PAR COMPTE, PLUS PAR ADRESSE ══════════════════════
 *
 * Tx-Core n'est jamais joint directement : tout son trafic utilisateur arrive
 * par la passerelle, donc d'une poignée d'adresses. Le plafond par IP — la clé
 * par défaut d'`express-rate-limit` — comptait donc les requêtes de TOUS les
 * clients dans un seul seau de 100. Le 2026-08-19, un utilisateur seul l'a
 * épuisé et `GET /api/v1/transactions` a répondu 429 ; la passerelle a traduit
 * l'échec en liste vide, et l'historique a paru disparaître.
 *
 * Stripe, PayPal et Wise comptent par compte, jamais par adresse réseau. La
 * défense contre les inondations appartient à la couche qui voit les vraies
 * adresses — chez nous la passerelle. Chaque étage protège ce qu'il est seul à
 * pouvoir observer.
 *
 * La décision vit dans `src/utils/rateLimitKey.js`, module pur et testé.
 */
const rateLimitKey = require("./utils/rateLimitKey");

const RL_AUTH_MAX = (() => {
  const n = Number(process.env.RATE_LIMIT_AUTH_MAX);
  return Number.isFinite(n) && n > 0 ? n : rateLimitKey.DEFAULT_AUTH_MAX;
})();

const RL_ANON_MAX = (() => {
  const n = Number(process.env.RATE_LIMIT_ANON_MAX);
  return Number.isFinite(n) && n > 0 ? n : rateLimitKey.DEFAULT_ANON_MAX;
})();

/**
 * Vérifie la SIGNATURE, et rien d'autre.
 *
 * On ne contrôle ni l'émetteur ni l'audience ici : ces règles appartiennent à
 * `authMiddleware`, qui s'exécute plus loin et rejette pour de bon. Les
 * dupliquer les ferait diverger — et un jeton refusé ici mais accepté là
 * retomberait dans le seau partagé sans que personne ne comprenne pourquoi.
 * Tout ce qu'on demande à cette étape, c'est de ne pas prendre pour argent
 * comptant un identifiant que l'appelant aurait écrit lui-même.
 */
function verifyForRateLimit(token) {
  const secret = process.env.JWT_SECRET || "";
  if (!secret) return null;

  return jwt.verify(token, secret, { algorithms: ["HS256"] });
}

function identifyCaller(req) {
  return rateLimitKey.identify(req, verifyForRateLimit);
}

const baseRateLimitConfig = {
  windowMs: 15 * 60 * 1000,

  keyGenerator: (req) =>
    rateLimitKey.bucketFor({ ...identifyCaller(req), ip: req.ip }),

  max: (req) =>
    rateLimitKey.limitFor(identifyCaller(req), {
      authMax: RL_AUTH_MAX,
      anonMax: RL_ANON_MAX,
    }),

  standardHeaders: true,
  legacyHeaders: false,

  /**
   * `Retry-After` est ce qui rend le 429 exploitable : sans lui, un client
   * réessaie immédiatement et aggrave la saturation qu'il vient de provoquer.
   */
  handler: (req, res) => {
    const resetTime = req.rateLimit?.resetTime;
    const seconds = resetTime
      ? Math.max(1, Math.ceil((new Date(resetTime).getTime() - Date.now()) / 1000))
      : 60;

    res.set("Retry-After", String(seconds));

    return res.status(429).json({
      success: false,
      code: "rate_limited",
      error: "Trop de requêtes, veuillez réessayer plus tard.",
      retryAfterSec: seconds,
    });
  },

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

    if (isTrustedInternalCall(req)) {
      return true;
    }

    if (
      req.path === "/api/v1/cagnotte/participation/settle" ||
      req.path === "/api/v1/cagnotte/vault-withdrawals/settle" ||
      req.path === "/api/v1/cagnotte/closure-fees/settle"
    ) {
      return true;
    }

    return false;
  },
};

if (process.env.REDIS_URL && RedisStore && Redis) {
  const redisUrl = String(process.env.REDIS_URL).trim();

  /**
   * ═══ TROIS RÉGLAGES, TROIS RAISONS ══════════════════════════════════════
   *
   * • TLS UNIQUEMENT SUR `rediss://`. Le `{ tls: {} }` inconditionnel d'avant
   *   forçait une poignée de main TLS même sur une URL `redis://` : elle
   *   échouait, le client ne se connectait jamais, et le service tournait avec
   *   un magasin inutilisable — sans repli, puisque `RedisStore` était bel et
   *   bien construit. La limitation de débit ne comptait donc plus rien.
   *
   * • `enableOfflineQueue: false`. Sans cela, une coupure Redis met les
   *   commandes EN ATTENTE : chaque requête HTTP se bloquerait jusqu'au délai
   *   de connexion au lieu d'échouer vite.
   *
   * • `passOnStoreError: true`. Une panne du compteur ne doit pas arrêter les
   *   transactions : on laisse passer et on journalise. C'est le choix de
   *   Stripe — la limitation protège d'un abus, ce n'est pas une règle métier.
   *
   * Le préfixe est explicite : ce service n'a qu'un limiteur global
   * aujourd'hui, mais il partagera le même Redis que la passerelle et le
   * backend. Sans préfixe, leurs compteurs fusionneraient.
   */
  redisClient = new Redis(redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    keepAlive: 30000,
    ...(redisUrl.startsWith("rediss://") ? { tls: {} } : {}),
  });

  redisClient.on("error", (err) => {
    logger.warn(
      `[rate-limit] Redis indisponible — les requêtes passent sans limitation : ${
        err?.message || err
      }`
    );
  });

  /**
   * ⚠️ `passOnStoreError` N'EXISTE PAS EN express-rate-limit v6 (version de ce
   * service). Une erreur du magasin y remonte en 500 : brancher Redis tel quel
   * ferait échouer TOUTES les requêtes de transaction pendant une coupure du
   * cache. Le repli est donc fourni explicitement — voir
   * `src/services/resilientStore.js`.
   */
  const { createResilientStore } = require("./services/resilientStore");
  const { MemoryStore } = require("express-rate-limit");

  globalRateLimiter = rateLimit({
    ...baseRateLimitConfig,
    store: createResilientStore({
      primary: new RedisStore({
        prefix: "rl:tx-core-global:",
        sendCommand: (...args) => redisClient.call(...args),
      }),
      fallback: new MemoryStore(),
      logger,
    }),
  });

  logger.info("[rate-limit] magasin Redis partagé actif (rl:tx-core-global:)");
} else {
  globalRateLimiter = rateLimit(baseRateLimitConfig);

  if (process.env.REDIS_URL) {
    logger.warn(
      "[rate-limit] REDIS_URL défini mais modules absents — fallback mémoire activé"
    );
  }
}

// Debug interne temporaire.
app.use((req, _res, next) => {
  if (
    req.path.startsWith("/api/v1/cagnotte") ||
    req.path.startsWith("/api/v1/internal")
  ) {
    logger.info("[TX CORE][internal-check]", {
      path: req.path,
      internalTokenPresent:
        !!req.headers["x-internal-token"] ||
        !!req.headers["x-paynoval-internal-token"],
      trusted: isTrustedInternalCall(req),
    });
  }

  next();
});

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
  message: {
    success: false,
    error: "Trop de tentatives. Réessayez plus tard.",
  },
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
  [
    "/api/v1/auth/login",
    "/api/v1/payments/confirm",
    "/api/v1/transactions/confirm",
  ],
  authSlow,
  authLimiter
);

// ─────────────────────────────────────────────────────────────
// Worker auto-cancel transactions
// ─────────────────────────────────────────────────────────────
let server = null;
let autoCancelWorker = null;
let referralOutboxWorker = null;

/**
 * Worker de livraison des evenements de parrainage.
 *
 * Il consomme la file ecrite par `referralEventOutbox` lors de la confirmation
 * des transactions et notifie le backend principal. Son absence ne bloque aucun
 * mouvement financier : les evenements s'accumulent en file et repartiront des
 * son demarrage — c'est precisement la propriete recherchee.
 */
function startReferralWorker() {
  try {
    const {
      startReferralOutboxWorker,
    } = require("./services/referral/referralOutboxWorker");

    const worker = startReferralOutboxWorker();

    logger.info("🎁 Worker parrainage active", {
      intervalMs: Number(process.env.REFERRAL_OUTBOX_INTERVAL_MS || 5000),
      batchSize: Number(process.env.REFERRAL_OUTBOX_BATCH_SIZE || 50),
    });

    return worker;
  } catch (err) {
    logger.error("❌ Worker parrainage non demarre", {
      err: err?.message || err,
    });
    return null;
  }
}

function startAutoCancelWorker() {
  if (process.env.TX_AUTO_CANCEL_WORKER === "false") {
    logger.warn("⏱️ Auto-cancel TX worker désactivé par TX_AUTO_CANCEL_WORKER=false");
    return null;
  }

  try {
    const {
      startTransactionAutoCancelWorker,
    } = require("./services/transactionAutoCancelService");

    if (typeof startTransactionAutoCancelWorker !== "function") {
      throw new Error(
        "startTransactionAutoCancelWorker introuvable dans services/transactionAutoCancelService"
      );
    }

    const worker = startTransactionAutoCancelWorker({
      intervalMs: Number(process.env.TX_AUTO_CANCEL_INTERVAL_MS || 300000),
      batchSize: Number(process.env.TX_AUTO_CANCEL_BATCH_SIZE || 50),
    });

    logger.info("⏱️ Auto-cancel TX worker activé", {
      intervalMs: Number(process.env.TX_AUTO_CANCEL_INTERVAL_MS || 300000),
      batchSize: Number(process.env.TX_AUTO_CANCEL_BATCH_SIZE || 50),
      afterDays: Number(process.env.TX_AUTO_CANCEL_AFTER_DAYS || 7),
    });

    return worker;
  } catch (err) {
    logger.error("❌ Impossible de démarrer le worker auto-cancel TX", {
      message: err?.message || err,
      stack: err?.stack || "",
    });

    const required =
      String(process.env.TX_AUTO_CANCEL_REQUIRED || "true").toLowerCase() !==
      "false";

    if (required) {
      throw err;
    }

    return null;
  }
}

async function bootstrap() {
  try {
    await connectTransactionsDB();
    readiness.markStarted();

    const providerWebhookRoutes = require("./routes/providerWebhookRoutes");
    const transactionRoutes = require("./routes/transactionsRoutes");
    const notificationRoutes = require("./routes/notificationRoutes");
    const payRoutes = require("./routes/pay");

    const internalPaymentsRoutes = require("./routes/internalPaymentsRoutes");
    const internalTxRoutes = require("./routes/internalTransactions.routes");
    const internalReferralRoutes = require("./routes/internalReferralRoutes");
    const internalCancelRefundRoutes = require("./routes/internalCancelRefund.routes");

    const cagnotteSettlementRoutes = require("./routes/cagnotteSettlementRoutes");
    const cagnotteVaultSettlementRoutes = require("./routes/cagnotteVaultSettlementRoutes");
    const cagnotteClosureFeesRoutes = require("./routes/cagnotteClosureFeesRoutes");

    const internalAdminTransactionsRoutes = require("./routes/internalAdminTransactions.routes");

    // Webhooks AVANT sanitizers.
    app.use("/webhooks/providers", providerWebhookRoutes);

    // Sanitizers APRÈS webhooks.
    mountSanitizers();

    /**
     * IMPORTANT :
     * Les routes admin back-office doivent rester dans le backend principal.
     * tx-core expose seulement des routes internes sécurisées pour les opérations financières.
     *
     * Endpoint :
     * POST /api/v1/internal/transactions/:transactionId/cancel-refund
     */
    app.use("/api/v1", internalCancelRefundRoutes);
    app.use("/api/v1", internalAdminTransactionsRoutes);

    logger.info(
      "🔐 Internal admin transactions: /api/v1/internal/admin/transactions"
    );

    // Public / user.
    app.use("/api/v1/transactions", transactionRoutes);

    app.use("/api/v1/notifications", protect, notificationRoutes);
    app.use("/api/v1/pay", protect, payRoutes);

    // Internal.
    app.use("/api/v1/internal", internalTxRoutes);
    app.use("/api/v1/internal-payments", internalPaymentsRoutes);
    app.use("/api/v1/internal/referral", internalReferralRoutes);

    // Cagnotte settlements.
    app.use("/api/v1/cagnotte", cagnotteSettlementRoutes);
    app.use("/api/v1/cagnotte", cagnotteVaultSettlementRoutes);
    app.use("/api/v1/cagnotte", cagnotteClosureFeesRoutes);

    app.get("/api/v1/health", (_req, res) =>
      res.status(200).json({
        status: "ok",
        timestamp: new Date().toISOString(),
      })
    );

    // Démarrage des workers après la connexion DB et le montage des routes.
    autoCancelWorker = startAutoCancelWorker();
    referralOutboxWorker = startReferralWorker();

    app.use((_req, res) =>
      res.status(404).json({
        success: false,
        error: "Ressource non trouvée",
      })
    );

    if (sentry && sentry.Handlers?.errorHandler) {
      app.use(sentry.Handlers.errorHandler());
    }

    app.use(errorHandler);

    server = app.listen(config.port, () => {
      logger.info(`🚀 Service démarré sur ${config.port} (${config.env})`);
      logger.info("📘 Docs: /docs  —  Spec: /openapi.yaml /openapi.json");
      logger.info("🔐 Webhooks providers: /webhooks/providers/:rail/:provider");
      logger.info(
        "🔐 Internal cancel/refund: /api/v1/internal/transactions/:transactionId/cancel-refund"
      );
      logger.info(
        "💰 Cagnotte TX settlement: /api/v1/cagnotte/participation/settle"
      );
      logger.info(
        "💰 Cagnotte close TX settlement: /api/v1/cagnotte/closure-fees/settle"
      );
      logger.info(
        "🏦 Cagnotte Vault TX settlement: /api/v1/cagnotte/vault-withdrawals/settle"
      );
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
  /**
   * VIDAGE AVANT FERMETURE.
   *
   * `/readyz` bascule en 503 d'abord : le répartiteur retire l'instance de la
   * rotation pendant que les requêtes en cours se terminent. Sur ce service,
   * couper une requête en vol veut dire interrompre un mouvement d'argent au
   * milieu — le pire moment possible.
   */
  try {
    readiness.beginDraining();
    await new Promise((r) => setTimeout(r, Number(process.env.DRAIN_DELAY_MS || 5000)));
  } catch (err) {
    logger.warn("Erreur pendant le vidage", { message: err?.message || err });
  }

  try {
    logger.info(`[${signal}] Arrêt en cours…`);

    try {
      autoCancelWorker?.stop?.();
      logger.info("⏱️ Auto-cancel TX worker arrêté");
    } catch (err) {
      logger.warn("Erreur arrêt auto-cancel TX worker", {
        message: err?.message || err,
      });
    }

    try {
      referralOutboxWorker?.stop?.();
      logger.info("🎁 Worker parrainage arrêté");
    } catch (err) {
      logger.warn("Erreur arrêt worker parrainage", {
        message: err?.message || err,
      });
    }

    if (server) {
      await new Promise((resolve) => server.close(resolve));
      logger.info("HTTP server fermé");
    }

    try {
      if (redisClient) {
        await redisClient.quit();
      }
    } catch (_) {}

    process.exit(0);
  } catch (e) {
    logger.error("Erreur shutdown:", e);
    process.exit(1);
  }
};

process.on("SIGTERM", () => graceful("SIGTERM"));
process.on("SIGINT", () => graceful("SIGINT"));