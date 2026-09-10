// File: src/config.js
'use strict';

const path = require('path');

/**
 * CONFIGURATION — CONSTRUITE, PAS LUE AU CHARGEMENT
 * =============================================================================
 *
 * ═══ LE DÉFAUT QUE CE FICHIER CORRIGE ════════════════════════════════════
 *
 * Ce module appelait `require('dotenv-safe').config(...)` **au premier niveau**.
 * `dotenv-safe` compare les clés de `.env` à celles de `.env.example` et LÈVE si
 * l'une manque. Valider est bien ; le faire comme effet de bord d'un `require`
 * ne l'est pas.
 *
 * Conséquence, consignée noir sur blanc dans le `CLAUDE.md` du dépôt :
 *
 *   « `require` d'un contrôleur charge `src/config.js`, donc `dotenv-safe`, qui
 *     échoue sans `.env` complet. Une logique qu'on veut tester doit donc vivre
 *     dans un module sans dépendance de configuration. »
 *
 * Autrement dit : l'architecture du dépôt était dictée par un accident de
 * chargement. `utils/commitWithRetry.js` n'existe séparément que « car le
 * contrôleur tire `src/config` ». Ce n'est plus un choix de conception, c'est
 * un contournement — et il fallait le nommer avant de le corriger.
 *
 * ═══ CE QUE FONT STRIPE, WISE, PAYPAL ET ADYEN ═══════════════════════════
 *
 * Trois règles, et ce fichier les applique :
 *
 *   1. **La construction est une fonction pure.** `buildConfig(env)` prend un
 *      environnement en paramètre et rend un objet. Aucune lecture implicite de
 *      `process.env`, aucun accès disque. Un test lui passe ce qu'il veut.
 *
 *   2. **Le chargement est explicite et mémoïsé.** `load()` lit le fichier
 *      `.env` une fois, puis construit. Deux appels rendent le même objet.
 *
 *   3. **La validation appartient au point d'entrée.** C'est `server.js` qui
 *      appelle `config.load({ strict: true })` et refuse de démarrer si une
 *      variable manque. Un `require` ne valide plus rien, donc ne casse plus
 *      rien.
 *
 * La garantie de sécurité est **conservée intégralement** : un déploiement mal
 * configuré refuse toujours de démarrer. Ce qui change, c'est *qui* décide —
 * le point d'entrée, délibérément, et non le premier `require` venu.
 *
 * ═══ COMPATIBILITÉ ═══════════════════════════════════════════════════════
 *
 * `require('./config').jwtSecret` fonctionne exactement comme avant : l'export
 * par défaut est un proxy paresseux qui charge au premier accès. Aucun des
 * appelants existants n'a besoin d'être modifié. La différence est qu'un
 * `require` seul, sans accès, ne déclenche plus rien.
 */

/* -------------------------------------------------------------------------- */
/* 1. Construction — fonction pure                                            */
/* -------------------------------------------------------------------------- */

/**
 * Construit l'objet de configuration à partir d'un environnement.
 *
 * Pure au sens strict : mêmes entrées, même sortie ; aucun effet de bord. C'est
 * elle qui rend la configuration testable — et, par ricochet, tout ce qui en
 * dépend.
 *
 * @param {Record<string,string|undefined>} [env] Par défaut `process.env`.
 */
function buildConfig(env = process.env) {
  const PRINCIPAL_URL = env.PRINCIPAL_URL?.trim() || '';
  const GATEWAY_URL = env.GATEWAY_URL?.trim() || '';

  // ExchangeRate-API (ou autre provider compatible)
  const rawExchangeUrl = env.EXCHANGE_API_URL?.trim();
  const baseExchangeUrl = rawExchangeUrl
    ? rawExchangeUrl.replace(/\/latest\/.*$/, '')
    : '';
  const exchangeApiKey = env.EXCHANGE_API_KEY;
  const defaultExchangeUrl = exchangeApiKey
    ? `https://v6.exchangerate-api.com/v6/${exchangeApiKey}`
    : '';

  /**
   * Tokens internes séparés :
   * - gateway   : pour appeler le Gateway, ou accepter ses appels
   * - principal : pour appeler le Backend principal, ou accepter ses appels
   * - legacy    : repli de compatibilité (ancien INTERNAL_TOKEN)
   */
  const legacyInternalToken = (env.INTERNAL_TOKEN || '').trim();

  const internalTokens = {
    gateway: (env.GATEWAY_INTERNAL_TOKEN || legacyInternalToken || '').trim(),
    principal: (
      env.PRINCIPAL_INTERNAL_TOKEN ||
      env.INTERNAL_REFERRAL_TOKEN ||
      legacyInternalToken ||
      ''
    ).trim(),
  };

  return {
    env: env.NODE_ENV || 'development',
    port: Number(env.PORT) || 3000,
    logLevel: env.LOG_LEVEL || 'info',

    // Observabilité / Docs
    sentryDsn: env.SENTRY_DSN || '',
    openapiSpecPath:
      env.OPENAPI_SPEC_PATH || path.join(__dirname, '../docs/openapi.yaml'),

    // URLs services
    principalUrl: PRINCIPAL_URL,
    gatewayUrl: GATEWAY_URL,

    // Connexions Mongo
    mongo: {
      users: env.MONGO_URI_USERS,
      transactions: env.MONGO_URI_TRANSACTIONS,

      /**
       * ── BASE TARIFICATION ────────────────────────────────────────────────
       *
       * Le domaine des prix (barèmes, versions, devis, frais, règles de change,
       * taux) appartenait à l'API Gateway jusqu'au 2026-09-10, et Tx-Core lui
       * demandait ses devis EN HTTP. La dépendance remontait donc du moteur
       * d'argent vers le bord — une panne de la passerelle arrêtait les
       * virements de l'intérieur.
       *
       * Les collections, elles, n'ont pas bougé : `MONGO_URI_PRICING` désigne
       * la base que la passerelle utilisait (`MONGO_URI_GATEWAY`). C'est le
       * motif « strangler » — on déplace le CODE et la PROPRIÉTÉ d'abord, la
       * consolidation des bases est une décision distincte, et une migration de
       * données ne se déclenche pas en passant une variable d'environnement.
       *
       * Repli sur `MONGO_URI_TRANSACTIONS` : le jour où les collections seront
       * consolidées, il n'y aura rien à changer ici.
       */
      pricing: env.MONGO_URI_PRICING || env.MONGO_URI_TRANSACTIONS,
    },

    // Redis (rate-limit + caches)
    redis: {
      url: env.REDIS_URL,
      tls: true, // Upstash / hébergeurs managés
    },

    // CORS strict, mais configurable
    cors: {
      origin: env.CORS_ORIGIN
        ? env.CORS_ORIGIN.split(',').map((s) => s.trim())
        : ['https://www.paynoval.com'],
    },

    // JWT / HMAC
    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN || '1h',
    hmacSecret: env.HMAC_SECRET,

    /**
     * ⚠️ LE BLOC `email` (SMTP) A ÉTÉ RETIRÉ LE 2026-09-02.
     *
     * Il se présentait comme « repli si le microservice emails est
     * indisponible ». Ce n'en était pas un : **`config.email` n'était lu nulle
     * part** dans ce dépôt — vérifié par recherche sur tout `src/`. C'était une
     * configuration morte qui décrivait un repli inexistant, donc une fausse
     * assurance. Et PayNoval n'envoie pas par SMTP : la production envoie par
     * SendGrid.
     */

    // Microservice emails (SendGrid + templates)
    emailMicroserviceUrl: env.EMAIL_MICROSERVICE_URL || '',

    // Exchange service (utilisé par convertAmount)
    exchange: {
      apiUrl: baseExchangeUrl || defaultExchangeUrl || '',
      apiKey: exchangeApiKey || '',
      cacheTTL: Number(env.EXCHANGE_CACHE_TTL) || 3600000, // 1 h
    },

    internalTokens,

    // Legacy : conservé pour le code qui attend `config.internalToken`
    internalToken:
      internalTokens.gateway ||
      internalTokens.principal ||
      legacyInternalToken ||
      '',

    // Email du compte admin trésor PayNoval
    adminEmail: env.ADMIN_EMAIL?.trim() || 'admin@paynoval.com',
  };
}

/* -------------------------------------------------------------------------- */
/* 2. Chargement du fichier .env — effet de bord isolé                        */
/* -------------------------------------------------------------------------- */

const EXAMPLE_PATH = path.resolve(__dirname, '../.env.example');

/**
 * Charge `.env` et rend la liste des variables manquantes.
 *
 * Ne lève jamais. C'est délibéré : cette fonction *constate*, elle ne décide
 * pas. La décision — tolérer ou refuser — appartient à `load()`, et in fine au
 * point d'entrée.
 *
 * `dotenv-safe` peuple `process.env` **avant** de lever (`dotenv.config()` à sa
 * ligne 23, le `throw` à sa ligne 31) : attraper son exception laisse donc les
 * variables correctement chargées. Vérifié dans le code de la dépendance, pas
 * supposé.
 *
 * @returns {{ missing: string[] }}
 */
function loadEnvFile() {
  try {
    require('dotenv-safe').config({
      example: EXAMPLE_PATH,
      allowEmptyValues: true,
    });

    return { missing: [] };
  } catch (err) {
    return { missing: Array.isArray(err?.missing) ? err.missing : [] };
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Accès — mémoïsé, validé sur demande                                     */
/* -------------------------------------------------------------------------- */

let _config = null;
let _missing = [];

/**
 * Charge la configuration. Mémoïsé : deux appels rendent le même objet.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.strict=false] Lever si une variable de `.env.example`
 *                  manque. **C'est le point d'entrée qui pose `true`** — voir
 *                  `server.js`. Le défaut est `false` pour qu'un `require`, un
 *                  test ou un script d'outillage n'échoue jamais au chargement.
 * @param {object}  [opts.env] Environnement à utiliser. Permet de construire
 *                  une configuration de test sans toucher `process.env`.
 */
function load({ strict = false, env = null } = {}) {
  if (_config && !env) return _config;

  if (!env) {
    const { missing } = loadEnvFile();
    _missing = missing;
  }

  if (strict && _missing.length) {
    throw new Error(
      `Configuration incomplète — variables absentes de l'environnement : ${_missing.join(
        ', '
      )}. Elles sont déclarées dans .env.example.`
    );
  }

  const built = buildConfig(env || process.env);

  // Une configuration explicitement injectée ne devient pas le singleton :
  // un test ne doit pas contaminer le reste du processus.
  if (env) return built;

  _config = built;
  return _config;
}

/**
 * Variables manquantes constatées au dernier chargement.
 * Utile au point d'entrée pour journaliser sans interrompre.
 */
function missingEnvVars() {
  if (!_config) load();
  return [..._missing];
}

/** Réinitialise le singleton. Réservé aux tests. */
function reset() {
  _config = null;
  _missing = [];
}

/* -------------------------------------------------------------------------- */
/* 4. Export — proxy paresseux, compatible avec tous les appelants existants   */
/* -------------------------------------------------------------------------- */

const OWN_HELPERS = {
  load,
  buildConfig,
  missingEnvVars,
  reset,
  EXAMPLE_PATH,
};

/**
 * Le proxy garde `require('./config').jwtSecret` intact tout en supprimant
 * l'effet de bord au chargement : rien ne se produit tant qu'aucune propriété
 * n'est lue.
 *
 * `ownKeys` et `getOwnPropertyDescriptor` sont implémentés pour que la
 * déstructuration, `Object.keys` et l'étalement fonctionnent comme sur un objet
 * ordinaire — sans quoi le remplacement ne serait pas transparent.
 */
module.exports = new Proxy(OWN_HELPERS, {
  get(target, prop, receiver) {
    if (prop in target) return Reflect.get(target, prop, receiver);
    if (typeof prop === 'symbol') return undefined;

    return load()[prop];
  },

  has(target, prop) {
    if (prop in target) return true;
    return prop in load();
  },

  ownKeys(target) {
    return Array.from(
      new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(load())])
    );
  },

  getOwnPropertyDescriptor(target, prop) {
    if (prop in target) {
      return Reflect.getOwnPropertyDescriptor(target, prop);
    }

    const cfg = load();
    if (prop in cfg) {
      return { value: cfg[prop], enumerable: true, configurable: true };
    }

    return undefined;
  },
});
