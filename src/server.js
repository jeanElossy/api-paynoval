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
const { auditerIndex } = require("./services/indexAudit");
const {
  resolveRedisConnection,
  diagnoseRedisError,
} = require("./services/redisUrl");

/**
 * ⚠️ AU NIVEAU DU MODULE, PAS DANS LE BLOC `if (redisUrl)`.
 *
 * `closeOfflineQueueWhenReady` sert à DEUX endroits distincts : le client de
 * limitation de débit (dans ce bloc) et le client d'abonnement du moteur de
 * risque (dans `bootstrap()`). Un `const` déclaré dans le premier n'est pas
 * visible depuis le second — l'erreur ne serait apparue qu'à l'exécution, au
 * démarrage, en production.
 */
const {
  closeOfflineQueueWhenReady,
  neutralizeScriptLoadRejections,
} = require("./services/redisStoreSafety");
const { createMetrics } = require("./services/metrics");
const { registerRedisMetrics } = require("./services/redisMetrics");
const { registerMongoPoolMetrics } = require("./services/mongoPoolMetrics");
const { registerWorkerMetrics } = require("./services/workerMetrics");
const {
  createTxMetrics,
  setTxMetrics,
  getTxMetrics: getTxMetricsInstance,
} = require("./services/txMetrics");
const {
  startReconciliationWorker,
} = require("./services/reconciliation/reconciliationScheduler");
const {
  startSettlementReplayWorker,
} = require("./services/settlement/settlementReplay");
const {
  checkCriticalIndexes,
  formatCriticalIndexesReport,
} = require("./services/ledger/verifyDedupIndex");
const {
  describeProviderRails,
  formatProviderRailsReport,
  assertProviderRails,
} = require("./providers/providerConfigReport");
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

/**
 * ═══ MÉTRIQUES ════════════════════════════════════════════════════════════
 *
 * Ce service n'avait AUCUNE instrumentation : impossible de dire si une
 * confirmation lente vient de Mongo, de la tarification, ou de Wave. Or c'est
 * la seule question dont la réponse change ce qu'on fait pendant un incident.
 *
 * `metrics` mesure les requêtes HTTP par motif de route (cardinalité bornée —
 * voir l'en-tête du module). `txMetrics` ajoute la latence et le taux d'erreur
 * PRESTATAIRE, instrumentés en un point unique (`providers/providerSelector.js`).
 *
 * L'instance est posée dans le registre de processus **avant** tout montage de
 * route : `providerSelector` la lit paresseusement, et tant qu'elle n'est pas
 * posée les appels prestataires fonctionnent sans être mesurés.
 */
const metrics = createMetrics({ client: require("prom-client") });

setTxMetrics(
  createTxMetrics({ client: require("prom-client"), register: metrics.register })
);

/**
 * Monté TÔT, pour englober le temps passé dans les autres intergiciels et pas
 * seulement dans le contrôleur.
 */
/**
 * ⚠️ MONTÉ AVANT LES MÉTRIQUES, ET C'EST L'ORDRE QUI COMPTE.
 *
 * Tout ce qui journalise ensuite — un rejet 429, une erreur de validation, un
 * refus d'idempotence — doit disposer du MÊME identifiant. Monté plus bas, la
 * moitié des lignes qui décrivent un échec n'en auraient pas : exactement
 * celles qu'on cherche quand on remonte un incident.
 *
 * `utils/idempotency.js`, `providerHttpClient.js` et
 * `internalPaymentsController.js` lisaient déjà `req.headers["x-request-id"]`
 * avec un repli sur chaîne vide. Ils reçoivent désormais une valeur toujours
 * présente et toujours inoffensive, sans qu'aucun d'eux ait à changer.
 */
const { requestIdMiddleware } = require("./utils/requestId");

app.use(requestIdMiddleware);

app.use(metrics.httpMiddleware);

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

      // `x-bank-*` et `stripe-signature` retirés le 2026-09-08 : ces rails
      // n'existent plus, donc aucun rappel ne peut légitimement les porter.
      // Un en-tête accepté pour un rail mort élargit la surface sans usage.
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
 * ⚠️ `/metrics` N'EST PAS PUBLIQUE.
 *
 * Elle divulgue la carte du service : routes internes, volumes, taux d'erreur,
 * noms de prestataires. C'est un plan de reconnaissance offert. Elle est donc
 * derrière le jeton interne, comme `/api/v1/internal` — même posture que le
 * backend principal.
 */
app.get("/metrics", async (req, res) => {
  if (!isTrustedInternalCall(req)) {
    return res.status(404).end();
  }

  try {
    res.set("Content-Type", metrics.contentType);
    res.set("Cache-Control", "no-store");
    return res.send(await metrics.metrics());
  } catch (err) {
    return res.status(500).send(`# collecte impossible: ${err?.message || err}\n`);
  }
});

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
      req.path === "/api/v1/cagnotte/closure-fees/settle" ||
      /**
       * Participation par LIEN PUBLIC. Exemptée pour la même raison que ses
       * trois voisines : c'est un appel service-à-service du backend principal,
       * pas du trafic utilisateur. La limiter reviendrait à perdre des rappels
       * prestataires déjà authentifiés — donc de l'argent encaissé et non
       * crédité — précisément aux heures de forte affluence.
       */
      req.path === "/api/v1/cagnotte/external-participation/settle" ||
      /**
       * ⚠️ EXEMPTÉE POUR UNE RAISON DIFFÉRENTE DES QUATRE PRÉCÉDENTES, et il
       * faut la dire : celles-là sont du trafic service-à-service pur, celle-ci
       * a une ORIGINE PUBLIQUE — un payeur anonyme sur la page de contribution.
       *
       * Elle est exemptée ICI parce que Tx-Core ne voit que l'adresse de la
       * passerelle : un compteur par IP les fondrait tous en un seul, et le
       * premier afflux de contributions bloquerait tous les payeurs à la fois.
       *
       * La limite qui compte est donc portée par la PASSERELLE, qui voit la
       * vraie adresse du payeur. Si elle disparaissait là-bas, ce chemin
       * n'aurait plus de limite du tout — c'est la contrepartie de cette ligne,
       * et `test/collectionIntent.test.js` la verrouille.
       */
      req.path === "/api/v1/collections/initiate"
    ) {
      return true;
    }

    return false;
  },
};

/**
 * Résolution de la connexion Redis — voir `src/services/redisUrl.js`.
 *
 * Auparavant : `if (process.env.REDIS_URL && …)`. Tester la PRÉSENCE d'une
 * variable n'est pas tester sa VALIDITÉ : une valeur non vide mais fautive
 * construisait un client qui ne se connectait jamais, et le repli s'activait
 * en silence. Le résolveur accepte en outre la forme discrète
 * (REDIS_HOST/PORT/USERNAME/PASSWORD/TLS), qui était déclarée dans le `.env`
 * de ce service sans qu'aucune ligne de code ne la lise.
 */
const redisConn = resolveRedisConnection({
  logger,
  scope: "rate-limit",
  consequence:
    "Comptage EN MÉMOIRE : correct sur une seule instance ; à plusieurs, " +
    "chaque limite est multipliée par le nombre d'instances.",
});

if (redisConn.url && RedisStore && Redis) {
  const redisUrl = redisConn.url;

  /**
   * ═══ TROIS RÉGLAGES, TROIS RAISONS ══════════════════════════════════════
   *
   * • TLS UNIQUEMENT SUR `rediss://`. Le `{ tls: {} }` inconditionnel d'avant
   *   forçait une poignée de main TLS même sur une URL `redis://` : elle
   *   échouait, le client ne se connectait jamais, et le service tournait avec
   *   un magasin inutilisable — sans repli, puisque `RedisStore` était bel et
   *   bien construit. La limitation de débit ne comptait donc plus rien.
   *
   * • `enableOfflineQueue: false` **une fois connecté**. Sans cela, une coupure
   *   Redis met les commandes EN ATTENTE : chaque requête HTTP se bloquerait
   *   jusqu'au délai de connexion au lieu d'échouer vite.
   *
   *   ⚠️ Le poser dès la construction faisait rejeter les `SCRIPT LOAD` du
   *   constructeur de `RedisStore`, avant l'ouverture de la socket — d'où les
   *   `unhandledRejection` observés au déploiement du 2026-08-26. La file est
   *   ouverte le temps de la connexion, puis fermée. Voir
   *   `services/redisStoreSafety.js`.
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
    /**
     * ⚠️ `true` AU DÉMARRAGE, `false` DÈS LA CONNEXION ÉTABLIE.
     *
     * `false` d'emblée faisait REJETER les deux `SCRIPT LOAD` que le
     * constructeur de `RedisStore` envoie immédiatement — la socket n'étant
     * pas encore ouverte. Ces rejets sont remontés en `unhandledRejection` au
     * déploiement du 2026-08-26. Raisonnement complet dans
     * `services/redisStoreSafety.js`.
     */
    enableOfflineQueue: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    keepAlive: 30000,
    ...(redisUrl.startsWith("rediss://") ? { tls: {} } : {}),
  });

  closeOfflineQueueWhenReady(redisClient, { logger, label: "rate-limit" });

  /**
   * ⚠️ UN SEUL CLIENT REDIS PAR PROCESSUS (invariant A8).
   *
   * Le domaine de la tarification, accueilli le 2026-09-10, cache le
   * référentiel des règles de change. Sans ce registre, il aurait dû ouvrir un
   * SECOND client — doublant sockets, reconnexions et métriques pour la même
   * base. On enregistre donc celui-ci, déjà ouvert.
   */
  require("./services/redisClientAccessor").setClient(redisClient);

  /**
   * ⚠️ LE DIAGNOSTIC EST ÉTRANGLÉ ET EXPLICITE.
   *
   * Cet avertissement se contentait du message brut d'ioredis — « wrong version
   * number », par exemple — qui ne désigne pas le coupable. Et il se répétait à
   * chaque tentative de reconnexion, donc plusieurs fois par seconde : le
   * journal se remplissait d'un message que personne ne lisait plus.
   *
   * Désormais : une explication actionnable (voir `diagnoseRedisError`) et une
   * ligne par minute au maximum.
   */
  let lastRedisLogAt = 0;

  redisClient.on("error", (err) => {
    const now = Date.now();
    if (now - lastRedisLogAt < 60000) return;
    lastRedisLogAt = now;

    logger.warn(
      `[rate-limit] Redis indisponible — comptage EN MÉMOIRE, donc par instance. ` +
        `${diagnoseRedisError(err, redisUrl)} (message d'origine : ${err?.message || err})`
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
      primary: neutralizeScriptLoadRejections(
        new RedisStore({
          prefix: "rl:tx-core-global:",
          sendCommand: (...args) => redisClient.call(...args),
        }),
        { logger }
      ),
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

/**
 * ─────────────────────────────────────────────────────────────
 * MÉTRIQUES DES DÉPENDANCES : REDIS (§37) ET POOL MONGO (§41)
 * ─────────────────────────────────────────────────────────────
 *
 * ⚠️ ICI, ET PAS PLUS HAUT : `redisClient` n'existe qu'après le bloc
 * ci-dessus. Le brancher avant enregistrerait les jauges avec un client
 * `undefined`, donc rien du tout — et le journal de démarrage annoncerait
 * une absence de Redis qui n'en est pas une.
 *
 * On PASSE le client déjà ouvert (`getClient`), on n'en construit aucun :
 * invariant 8 — aucune requête HTTP ne crée de connexion Redis. La scrutation
 * `/metrics` réutilise la connexion de la limitation de débit.
 *
 * Les jauges de pool Mongo s'enregistrent maintenant, alors qu'aucune connexion
 * n'est encore ouverte (`bootstrap()` s'en charge plus tard) : elles parcourent
 * le registre de pools AU MOMENT de la scrutation, donc un pool connecté ensuite
 * apparaît de lui-même. Voir `services/mongoPoolMetrics.js`.
 */
registerRedisMetrics(metrics, {
  getClient: () => redisClient || null,
  logger,
});

registerMongoPoolMetrics(metrics, { logger });

/**
 * MÉTRIQUES DES TRAVAILLEURS DE FOND.
 *
 * Même raison d'être ici que pour les pools Mongo : les jauges s'enregistrent
 * MAINTENANT, alors qu'aucun worker n'a démarré (`bootstrap()` s'en charge plus
 * loin). Elles parcourent le registre de workers AU MOMENT de la scrutation,
 * donc un worker déclaré ensuite apparaît de lui-même — et un worker qui ne se
 * déclare JAMAIS sort en `worker_enabled=-1`, ce qui est précisément le signal
 * qu'on n'avait pas : jusqu'ici, un worker mort laissait `/metrics` muet et
 * `/readyz` vert. Voir `services/workerMetrics.js`.
 */
registerWorkerMetrics(metrics, { logger });

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
let reconciliationWorker = null;
let settlementReplayWorker = null;
let referralOutboxWorker = null;
let eventRelay = null;

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
    /**
     * Sur quelles données travaille-t-on ? (règle B.6, défaut A1)
     *
     * Tx Core est le moteur qui déplace l'argent : une erreur de base y est la
     * plus coûteuse des trois services. La garde annonce cluster et base, et
     * refuse un démarrage dont NODE_ENV contredit ce qu'elle voit.
     */
    try {
      const { assertDatabaseEnvironment } = require("./utils/dbEnvironmentGuard");

      for (const [label, uri] of [
        ["base Users", process.env.MONGO_URI_USERS],
        ["base Transactions", process.env.MONGO_URI_TRANSACTIONS],
      ]) {
        if (uri) assertDatabaseEnvironment(uri, { label, logger });
      }
    } catch (err) {
      logger.error(
        `❌ Démarrage refusé — garde d'environnement de base : ${err?.message}`
      );
      process.exit(1);
    }

    await connectTransactionsDB();
    readiness.markStarted();

    /**
     * AUDIT DES INDEX — contrepartie observable de `autoIndex: false`.
     *
     * Les index ne se créent plus au démarrage (voir `config/db.js`). Le prix
     * de cette sécurité, c'est qu'un index déclaré et jamais posé n'existe
     * pas et ne dit rien : la requête rend le bon résultat, en balayant la
     * collection. Cet audit rend l'écart visible, nommément, au démarrage.
     *
     * Volontairement NON bloquant et sans `await` fautif : un audit
     * indisponible ne doit pas empêcher un service sain de servir. Il ne crée
     * ni ne supprime jamais d'index.
     */
    auditerIndex(getTxConn(), { logger }).catch(() => {});

    /**
     * ÉTAT DES RAILS DE PAIEMENT — AVANT D'ACCEPTER LA MOINDRE REQUÊTE
     * -------------------------------------------------------------------
     * Les sept adapters démarraient en mode simulé par défaut : un rail non
     * configuré ACCEPTAIT l'ordre de virement, réservait les fonds, et ne
     * payait jamais. Rien ne le signalait.
     *
     * `resolveProviderMode()` a fermé cette porte côté paiement. Ce bloc-ci
     * déplace la découverte au démarrage : le journal dit désormais lesquels
     * des sept rails sont réels, lesquels sont simulés, et pourquoi.
     *
     * En production, un rail mal configuré ARRÊTE le démarrage — c'est le
     * `catch` ci-dessous qui fait `process.exit(1)`. Ailleurs, on journalise
     * et on continue : le développement doit tourner sans les identifiants.
     */
    /**
     * ========================================================================
     * MOTEUR DE RISQUE — LISTE NOIRE DYNAMIQUE ET VÉLOCITÉ
     * ========================================================================
     *
     * Amorcé APRÈS la connexion : le magasin de liste noire lit MongoDB, et
     * `getTxConn()` lève tant que `connectTransactionsDB()` n'a pas tourné.
     *
     * ⚠️ LE CLIENT D'ABONNEMENT EST DÉDIÉ, ET C'EST OBLIGATOIRE. Un client
     * Redis passé en mode abonné ne peut plus exécuter de commandes
     * ordinaires : réutiliser `redisClient` casserait la limitation de débit —
     * silencieusement, puisque `resilientStore` bascule en mémoire sans se
     * plaindre.
     *
     * Sans Redis, tout continue de fonctionner : la vélocité rend `null` (que
     * le score traduit en `SIGNAL_UNAVAILABLE`, jamais en zéro) et la liste
     * noire se rafraîchit par TTL au lieu du pub/sub.
     */
    try {
      let riskSubscriber = null;

      if (redisClient && Redis) {
        try {
          /**
           * ⚠️ `enableOfflineQueue: true` EST INDISPENSABLE ICI, ET LE DÉFAUT
           * NE L'AURAIT PAS DONNÉ.
           *
           * `duplicate()` recopie `this.options` — y compris la valeur COURANTE
           * de `enableOfflineQueue`, que `closeOfflineQueueWhenReady` a déjà
           * remise à `false` sur le client principal une fois connecté. Le
           * client dupliqué héritait donc d'une file FERMÉE alors que sa propre
           * poignée de main TLS n'avait pas encore eu lieu — un client dupliqué
           * ouvre sa PROPRE connexion, mesurée à ~1,2 s sur cette
           * infrastructure.
           *
           * Résultat observé en production le 2026-08-26 :
           *
           *     [AML] abonnement à l'invalidation impossible
           *     (Stream isn't writeable and enableOfflineQueue options is false)
           *     — la liste noire se rafraîchira par TTL seul.
           *
           * La conséquence n'est pas cosmétique : ajouter quelqu'un à la liste
           * noire ne se propageait plus aux autres instances qu'à l'expiration
           * du TTL. Une décision de conformité prise à l'instant T ne prenait
           * effet qu'à T + TTL, sur des instances qui continuaient d'accepter
           * ses virements.
           *
           * On rouvre donc la file pour la durée de la connexion, puis on la
           * referme — exactement le traitement du client principal.
           */
          riskSubscriber = redisClient.duplicate({ enableOfflineQueue: true });

          closeOfflineQueueWhenReady(riskSubscriber, {
            logger,
            label: "risk",
          });

          riskSubscriber.on("error", (err) => {
            logger.warn(
              `[risk] abonnement liste noire indisponible : ${err?.message || err}`
            );
          });
        } catch (err) {
          logger.warn(`[risk] duplication du client Redis impossible : ${err?.message || err}`);
          riskSubscriber = null;
        }
      }

      const riskEngine = require("./services/risk");
      const etat = await riskEngine.initRiskEngine({
        redisClient,
        redisSubscriber: riskSubscriber,
        logger,
      });

      logger.info(
        `[risk] moteur amorcé — vélocité ${etat.velocityEnabled ? "ACTIVE" : "INACTIVE (pas de Redis)"}, ` +
          `invalidation liste noire ${etat.blacklistSubscribed ? "par pub/sub" : "par TTL seul"}`
      );
    } catch (err) {
      // Fail-open DÉLIBÉRÉ : sans moteur, la liste statique et les limites de
      // base continuent de s'appliquer. Refuser de démarrer priverait les
      // utilisateurs du service entier pour une couche de signalement.
      logger.error(`[risk] amorçage impossible : ${err?.message || err}`);
    }

    /**
     * L'index de déduplication du grand livre est-il bien en place ?
     *
     * Il se crée à la main (`scripts/ensure-ledger-indexes.js`). S'il manque,
     * le code écrit des clés qu'aucune contrainte n'observe : la protection est
     * affichée mais absente. On le dit bruyamment, sans arrêter le démarrage —
     * priver les utilisateurs du service entier pour une protection qui ne
     * concerne qu'un régime dégradé serait un mauvais arbitrage.
     */
    try {
      const criticalIndexes = await checkCriticalIndexes(getTxConn());
      for (const line of formatCriticalIndexesReport(criticalIndexes)) {
        if (line.includes("❌")) logger.error(line);
        else if (line.includes("⚠️")) logger.warn(line);
        else logger.info(line);
      }
    } catch (err) {
      logger.warn(`[ledger] contrôle de l'index de déduplication ignoré : ${err?.message || err}`);
    }

    /**
     * ══════════════════════════════════════════════════════════════════════
     * ÉTAT DE LA CONFORMITÉ — règle B.6 : le démarrage dit la vérité
     * ══════════════════════════════════════════════════════════════════════
     *
     * Ces deux annonces existent parce que les deux défauts qu'elles couvrent
     * ont été MESURÉS le 2026-09-10, et qu'aucun des deux ne se voyait :
     *
     *   1. le criblage sanctions — 1 359 lignes de service, branché sur l'AML,
     *      et ÉTEINT : `SANCTIONS_SCREENING_ENABLED` n'est renseignée nulle
     *      part et vaut `false` par défaut. Rien ne le disait ;
     *
     *   2. le jeton interne — les routes admin lisaient trois noms de variable
     *      dont AUCUN n'était posé, pendant que la passerelle en envoyait un
     *      quatrième. Tout le back-office rendait 500, et le message accusait
     *      une variable plutôt que la divergence qui l'avait produite.
     *
     * Un service qui démarre en annonçant « j'écoute » sans dire ce qu'il ne
     * fait pas est la panne la plus chère à diagnostiquer.
     */
    try {
      const {
        annoncerPrincipal,
      } = require("./utils/principalEndpoint");

      annoncerPrincipal(process.env, logger);
    } catch (err) {
      logger.error(
        `❌ Annonce du backend principal impossible : ${err?.message || err}`
      );
    }

    try {
      const {
        annoncerJetonsInternes,
      } = require("./utils/internalTokens");

      annoncerJetonsInternes(process.env, logger);
    } catch (err) {
      logger.error(
        `❌ Annonce des jetons internes impossible : ${err?.message || err}`
      );
    }

    /**
     * ⚠️ CE BLOC PEUT REFUSER LE DÉMARRAGE, ET C'EST SA RAISON D'ÊTRE.
     *
     * Le criblage sanctions a été trouvé ÉTEINT le 2026-09-10 : 1 359 lignes de
     * service, branchées sur les deux chemins de l'argent, et
     * `SANCTIONS_SCREENING_ENABLED` renseignée nulle part. Aucun bénéficiaire
     * n'était confronté à une liste, et rien ne le disait.
     *
     * En développement, l'état est toléré et ANNONCÉ avec sa conséquence. En
     * production, il refuse le démarrage : activer par défaut ne réglerait rien
     * — sans fournisseur, le service retombe sur `mock`, qui répond « aucune
     * correspondance » à tout. On remplacerait un contrôle éteint par un
     * contrôle qui MENT, ce qui est pire.
     *
     * Voir `utils/screeningGuard.js` pour les trois régimes et l'échappatoire
     * d'incident.
     */
    try {
      const { assertScreeningReady } = require("./utils/screeningGuard");
      assertScreeningReady(process.env, logger);
    } catch (err) {
      logger.error(`❌ Démarrage refusé — ${err?.message || err}`);
      process.exit(1);
    }

    const providerReport = describeProviderRails();
    for (const line of formatProviderRailsReport(providerReport)) {
      if (line.includes("❌")) logger.error(line);
      else if (line.includes("⚠️")) logger.warn(line);
      else logger.info(line);
    }

    if (!providerReport.ok) {
      assertProviderRails();
    }

    /**
     * L'état simulé/réel des rails devient OBSERVABLE en continu, et pas
     * seulement dans une ligne de journal au démarrage.
     *
     * `provider_rails_mocked > 0` en production attrape le cas où quelqu'un a
     * posé `ALLOW_PROVIDER_MOCK_IN_PRODUCTION=true` « le temps d'un test » et
     * l'a oublié — un rail qui accepte les ordres sans jamais payer.
     */
    getTxMetricsInstance().setRailModes(providerReport);

    /**
     * ── TARIFICATION : LA DÉPENDANCE NE REMONTE PLUS ──────────────────────
     *
     * Jusqu'au 2026-09-10, ce bloc contrôlait `GATEWAY_URL` et annonçait :
     * « GATEWAY_URL absente ⇒ toute transaction nécessitant un devis échouera
     * en 503 ». C'était exact, et c'était le symptôme d'un défaut
     * d'architecture : **le moteur d'argent dépendait du bord**. Une panne ou
     * un redémarrage de la passerelle arrêtait les virements de l'intérieur.
     *
     * Le domaine des prix appartient désormais à Tx-Core (`services/pricing/`,
     * base `MONGO_URI_PRICING`) et le devis est un appel de fonction. Ce qui
     * doit être annoncé au démarrage n'est donc plus l'URL de la passerelle,
     * mais la présence de la BASE des barèmes — la nouvelle dépendance réelle.
     *
     * Le contrôle vit dans `config/db.js`, au moment de l'ouverture de la
     * connexion, parce que c'est là qu'on sait si elle a abouti. En dire quoi
     * que ce soit ici serait le répéter sans le vérifier.
     *
     * Règle B.6 : on annonce ce qui est mesuré, avec sa conséquence — et on
     * cesse d'annoncer ce qui n'est plus vrai.
     */
    if (String(process.env.GATEWAY_URL || "").trim()) {
      logger.info(
        "ℹ️ GATEWAY_URL renseignée — elle ne sert plus à la tarification " +
          "(devis calculés localement depuis le 2026-09-10). Les autres usages " +
          "de cette variable restent inchangés."
      );
    }

    const providerWebhookRoutes = require("./routes/providerWebhookRoutes");
    const transactionRoutes = require("./routes/transactionsRoutes");
    const notificationRoutes = require("./routes/notificationRoutes");
    const payRoutes = require("./routes/pay");

    const internalPaymentsRoutes = require("./routes/internalPaymentsRoutes");
    const internalTxRoutes = require("./routes/internalTransactions.routes");
    const internalWalletRoutes = require("./routes/internalWallets.routes");
    const internalReferralRoutes = require("./routes/internalReferralRoutes");
    const internalCancelRefundRoutes = require("./routes/internalCancelRefund.routes");

    const cagnotteSettlementRoutes = require("./routes/cagnotteSettlementRoutes");
    const cagnotteVaultSettlementRoutes = require("./routes/cagnotteVaultSettlementRoutes");
    const cagnotteClosureFeesRoutes = require("./routes/cagnotteClosureFeesRoutes");
    const cagnotteExternalSettlementRoutes = require("./routes/cagnotteExternalSettlementRoutes");
    const collectionRoutes = require("./routes/collectionRoutes");
    const depositPhoneVerificationRoutes = require("./routes/depositPhoneVerification.routes");
    const pricingRoutes = require("./routes/pricingRoutes");
    const pricingRulesRoutes = require("./routes/pricingRulesRoutes");
    const pricingChangeRequestsRoutes = require("./routes/pricingChangeRequestsRoutes");
    const feesRoutes = require("./routes/feesRoutes");
    const fxRulesRoutes = require("./routes/fxRulesRoutes");
    const exchangeRatesRoutes = require("./routes/exchangeRatesRoutes");

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

    /**
     * `POST /api/v1/internal/wallets/ensure` — le backend principal DEMANDE un
     * portefeuille, Tx-Core l'écrit.
     *
     * Il écrivait auparavant lui-même dans `tx_wallet_balances`, avec un schéma
     * qui déclare `amount` en `Number` là où le propriétaire le déclare en
     * `Decimal128` : toute écriture y stockait un flottant sous un champ lu
     * comme décimal exact (invariant 12).
     */
    app.use("/api/v1/internal", internalWalletRoutes);
    app.use("/api/v1/internal-payments", internalPaymentsRoutes);
    app.use("/api/v1/internal/referral", internalReferralRoutes);

    // Cagnotte settlements.
    app.use("/api/v1/cagnotte", cagnotteSettlementRoutes);
    app.use("/api/v1/cagnotte", cagnotteVaultSettlementRoutes);
    app.use("/api/v1/cagnotte", cagnotteClosureFeesRoutes);

    /**
     * Participation par lien public. Montée sur le MÊME préfixe que ses trois
     * voisines, avec un chemin propre (`/external-participation/settle`) : la
     * parenté se lit dans l'URL, et la garde de jeton interne est la même.
     */
    app.use("/api/v1/cagnotte", cagnotteExternalSettlementRoutes);

    /**
     * ── ENCAISSEMENTS ENTRANTS ────────────────────────────────────────────
     *
     * `POST /api/v1/collections/initiate` — l'argent qui ENTRE, depuis un payeur
     * qui n'a pas de compte PayNoval.
     *
     * ⚠️ Ce chemin n'écrit RIEN au grand livre. Il demande à un prestataire de
     * prélever, et rend `pending`. Le grand livre est écrit au rappel signé,
     * par `/api/v1/cagnotte/external-participation/settle` (règle B.3).
     */
    app.use("/api/v1/collections", collectionRoutes);

    /**
     * ── CONFIANCE D'UN NUMÉRO DE DÉPÔT ────────────────────────────────────
     *
     * Descendue du bord le 2026-09-10. Le contrôle qui AUTORISE un encaissement
     * appartient au moteur qui déplace l'argent, comme l'AML avant lui.
     *
     * ⚠️ Le chemin est celui que l'application mobile appelle DÉJÀ. Il rendait
     * 404 : le bord ne montait pas sa route native (353 l. de contrôleur
     * référencées par aucun fichier) et ne relayait pas le préfixe. Un dépôt
     * vers un numéro tiers ne pouvait donc jamais être débloqué — le 403 du
     * contrôle citait trois routes inexistantes.
     */
    app.use("/api/v1/phone-verification", depositPhoneVerificationRoutes);

    /**
     * ── TARIFICATION ──────────────────────────────────────────────────────
     *
     * Déplacée depuis l'API Gateway le 2026-09-10. La passerelle expose
     * `/api/v1/pricing/*` au monde et relaie ici ; Tx-Core, lui, n'appelle plus
     * aucune route de devis — il utilise `services/pricing/quoteService` en
     * direct.
     *
     * ⚠️ C'est ce qui referme l'inversion de dépendance : le moteur d'argent
     * appelait le bord pour connaître ses prix, et une panne de la passerelle
     * arrêtait les virements de l'intérieur.
     */
    app.use("/api/v1/pricing", pricingRoutes);
    app.use("/api/v1/pricing-rules", pricingRulesRoutes);
    app.use("/api/v1/pricing-change-requests", pricingChangeRequestsRoutes);
    app.use("/api/v1/fees", feesRoutes);
    app.use("/api/v1/fx-rules", fxRulesRoutes);
    app.use("/api/v1/exchange-rates", exchangeRatesRoutes);

    app.get("/api/v1/health", (_req, res) =>
      res.status(200).json({
        status: "ok",
        timestamp: new Date().toISOString(),
      })
    );

    // Démarrage des workers après la connexion DB et le montage des routes.
    autoCancelWorker = startAutoCancelWorker();
    referralOutboxWorker = startReferralWorker();

    /**
     * ══════════════════════════════════════════════════════════════════════
     * LE RELAIS D'ÉVÉNEMENTS — LA MOITIÉ PRODUCTRICE DU BUS
     * ══════════════════════════════════════════════════════════════════════
     *
     * Il lit `domain_events` (écrit DANS les transactions du moteur) et publie
     * sur le flux Redis. Il ne décide rien : il transporte.
     *
     * ⚠️ IL TOURNE DANS CE PROCESSUS, LES CONSOMMATEURS NON.
     *
     * Le relais appartient au producteur — il lit la base du moteur, et le
     * faire tourner ailleurs ferait sortir cette lecture de son propriétaire.
     * Les consommateurs, eux, ont leur propre point d'entrée
     * (`workers/riskMonitor.js`) : ils se déploient et se redémarrent
     * séparément, et une surveillance qui s'effondre n'emporte pas le moteur
     * d'argent avec elle.
     *
     * C'est l'étape vers le service `Risk/AML` du schéma cible : processus
     * séparé d'abord, dépôt séparé ensuite. L'inverse — extraire le dépôt avant
     * d'avoir séparé le processus — oblige à inventer un contrat réseau avant
     * de savoir ce qu'il doit porter.
     *
     * ⚠️ Sans Redis, le relais tourne À VIDE et ne marque RIEN comme publié :
     * les événements s'accumulent en base, intacts, et repartent dès que le
     * transport revient. Il ne perd rien en silence.
     */
    try {
      const relais = require("./services/events/relay");
      const fluxEv = require("./services/events/stream");

      if (!fluxEv.clientOuNull()) {
        logger.warn(
          "⚠️ Bus d'événements SANS TRANSPORT (Redis absent) — CONSÉQUENCE : " +
            "les événements de domaine s'accumulent dans `domain_events` et " +
            "AUCUN consommateur ne les reçoit. La surveillance AML asynchrone " +
            "est donc à l'arrêt. Rien n'est perdu : tout repart au retour de Redis."
        );
      }

      eventRelay = relais.start({ logger });
    } catch (err) {
      logger.error("❌ Relais d'événements non démarré", {
        message: err?.message || err,
        consequence:
          "aucun événement de domaine ne sera publié ; la surveillance de " +
          "conformité et tout consommateur en aval sont aveugles",
      });
    }

    /**
     * RÉCONCILIATION PLANIFIÉE.
     *
     * Le service de réconciliation existait déjà et n'était déclenché que par
     * `npm run reconcile:transactions`, à la main. Il tourne désormais seul, un
     * seul exécutant par fenêtre (verrou Mongo), et consigne chaque exécution
     * dans `reconciliation_runs`.
     *
     * ⚠️ Il ne CORRIGE rien — il lit, compare et signale. Voir l'en-tête de
     * `services/reconciliation/transactionReconciliationService.js`.
     *
     * Désactivable par `RECONCILIATION_WORKER=false` (par exemple si un service
     * dédié s'en charge).
     */
    reconciliationWorker = startReconciliationWorker();

    /**
     * ⚠️ CELUI-CI DÉPLACE DE L'ARGENT — ET IL EST DÉSACTIVÉ PAR DÉFAUT.
     *
     * Il termine des règlements que nous avions DÉJÀ acceptés : des rappels
     * prestataire authentifiés dont le traitement s'est interrompu, et que plus
     * personne ne réémettra. Sans lui, ces événements restent dans le registre,
     * signalés par la réconciliation et corrigés à la main.
     *
     * La distinction avec le worker ci-dessus est nette :
     *   - la réconciliation DÉDUIT des écarts et ne corrige rien ;
     *   - le rejeu ACHÈVE un engagement déjà pris.
     *
     * `SETTLEMENT_REPLAY_WORKER=true` l'active. Sans cette variable, le rejeu
     * reste entièrement disponible à la demande (`npm run replay:settlements`,
     * avec `--dry-run` pour voir sans agir).
     */
    settlementReplayWorker = startSettlementReplayWorker();

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
      reconciliationWorker?.stop?.();
      settlementReplayWorker?.stop?.();
    } catch (err) {
      logger.warn("Erreur arrêt worker de réconciliation", {
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

    try {
      eventRelay?.stop?.();
      logger.info("📨 Relais d'événements arrêté");
    } catch (err) {
      logger.warn("Erreur arrêt relais d'événements", {
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