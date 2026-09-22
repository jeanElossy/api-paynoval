"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SUIVI D'ERREURS — VOIR, SANS JAMAIS EXPOSER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── LE DÉFAUT QUE CE MODULE FERME (D1) ────────────────────────────────────
 *
 * `src/server.js` montait Sentry ainsi, à deux endroits :
 *
 *     if (sentry && sentry.Handlers?.requestHandler) {
 *       app.use(sentry.Handlers.requestHandler());
 *     }
 *
 * `Sentry.Handlers` a été RETIRÉ du SDK en v8. La version installée ici est la
 * 9.47.1, où `Sentry.Handlers` vaut `undefined`. L'opérateur `?.` faisait donc
 * que les deux blocs étaient sautés EN SILENCE : le seul service serveur équipé
 * d'un suivi d'erreurs n'en avait aucun, et rien nulle part ne le disait.
 *
 * Second défaut, moins visible : `Sentry.init()` était appelé ligne 217, APRÈS
 * le `require("express")` du haut de fichier. Depuis la v8, l'instrumentation
 * automatique repose sur OpenTelemetry, qui doit enrober les modules AVANT
 * qu'ils ne soient chargés. Même avec les bons gestionnaires, l'initialisation
 * arrivait trop tard.
 *
 * ── CE QUE CE MODULE GARANTIT, ET QUI EST LE POINT ────────────────────────
 *
 * ⚠️ IL N'Y A PLUS AUCUN `?.` SUR UNE API DU SDK. Une API absente est un SDK
 * incompatible : le module le DIT, avec sa conséquence (règle B.6). C'est
 * exactement ce que l'ancien code ne faisait pas — et la raison pour laquelle
 * le défaut a survécu à une montée de version majeure sans qu'on s'en aperçoive.
 *
 * ── RÈGLE B.4, TENUE À LA SORTIE ──────────────────────────────────────────
 *
 * Le filtrage n'est PAS confié aux sites d'appel. C'est la leçon de
 * `redactSensitive.js` : « le masquage y dépend de la discipline de chaque site
 * d'appel, exactement ce que le module a été écrit pour supprimer. » Ici, tout
 * passe par `beforeSend` et `beforeBreadcrumb` — le dernier point avant que
 * l'octet ne quitte le processus. C'est ce que fait déjà
 * `payNoval-master/utils/monitoring.js` côté mobile, et ce module en reprend
 * les règles de chaîne, éprouvées par `utils/monitoring.test.js`.
 *
 * Deux niveaux, parce qu'un seul ne suffit pas :
 *   1. par CLÉ — `redactSensitive` (`securityAnswer`, `otp`, `token`, …) ;
 *   2. par VALEUR — un JWT, un e-mail, un IBAN ou un numéro de carte peuvent
 *      se trouver AU MILIEU d'un message d'erreur, sous aucune clé.
 *
 * ── CE QUE CE MODULE NE FAIT JAMAIS ───────────────────────────────────────
 *
 * Il ne lève pas. Jamais. Un suivi d'erreurs qui fait tomber une transaction
 * est un défaut bien pire que l'absence de suivi — c'est le raisonnement déjà
 * posé dans `txMetrics.js:34-37`, et il vaut ici mot pour mot.
 */

const { APP_ENV, isTest, ENVIRONMENTS } = require("./appEnv");
const { redactSensitive } = require("../utils/redactSensitive");

/* -------------------------------------------------------------------------- */
/* 1) Masquage par VALEUR — les motifs                                        */
/* -------------------------------------------------------------------------- */

const REDACTED = "[redacted]";

/**
 * Longueur maximale d'une chaîne expédiée. Au-delà, on tronque : une pile
 * d'appels ou un corps recopié dans un message peut peser des kilo-octets, et
 * ce qui n'est pas lu ne mérite pas de sortir du processus.
 */
const MAX_STRING = 1000;

/**
 * ⚠️ L'ORDRE EST SIGNIFICATIF, et l'inverser rouvre des fuites :
 *
 *  - « Bearer xyz » AVANT la règle clé=valeur, sinon `Authorization: Bearer x`
 *    ne masquerait que le mot « Bearer » et laisserait passer le jeton ;
 *  - le JWT AVANT l'e-mail : un JWT contient des points qui ressemblent à un
 *    domaine, et la règle e-mail en mangerait un morceau ;
 *  - l'IBAN AVANT le numéro long : un IBAN contient une suite de chiffres qui
 *    satisferait la règle « carte ».
 *
 * Reprises de `payNoval-master/utils/monitoring.js`, où elles sont couvertes
 * par des tests. Toute modification ici doit être reportée là-bas — les deux
 * protègent la même donnée, sur deux chemins différents.
 */
const STRING_RULES = Object.freeze([
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`],
  [
    /(["']?\b(?:password|passwd|pass|pwd|passcode|pin|pincode|otp|otpCode|code2fa|twoFaCode|securityAnswer|securityCode|validationCode|answer|cvv|cvc|cvv2|token|accessToken|refreshToken|idToken|secret|clientSecret|apiKey|api_key|authorization|cookie|set-cookie|sessionId|iban|pan|cardNumber|documentNumber|idNumber|nationalId|passportNumber)\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi,
    `$1${REDACTED}`,
  ],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[jwt]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, "[iban]"],
  [/\b(?:\d[ -]?){12,18}\d\b/g, "[number]"],
  /**
   * Téléphone : au moins 8 chiffres. En deçà, c'est un montant, une date, un
   * code HTTP ou un identifiant de corrélation — toutes choses utiles au
   * diagnostic et sans donnée de personne. Masquer large ici reviendrait à
   * rendre les rapports illisibles pour ne rien protéger de plus.
   */
  [
    /\+?\d[\d ().-]{6,}\d/g,
    (match) =>
      /^\d{4}-\d{2}-\d{2}$/.test(match) || match.replace(/\D/g, "").length < 8
        ? match
        : "[phone]",
  ],
]);

/**
 * Masque l'intérieur d'une chaîne. PURE — la pièce à tester en priorité.
 *
 * @param {unknown} value
 * @returns {string}
 */
function redactString(value) {
  let out = String(value ?? "");

  for (const [pattern, replacement] of STRING_RULES) {
    out = out.replace(pattern, replacement);
  }

  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

/**
 * Une URL sans chaîne de requête ni fragment : les paramètres portent des
 * données (jeton de réinitialisation, identifiant, clé d'idempotence).
 *
 * @param {unknown} url
 * @returns {string}
 */
function stripUrlQuery(url) {
  const text = String(url ?? "");
  const cut = text.search(/[?#]/);
  return cut === -1 ? text : text.slice(0, cut);
}

/**
 * Applique les deux niveaux — clé puis valeur — récursivement.
 *
 * PURE. Ne mute jamais l'entrée : l'objet d'origine poursuit sa route, et sur
 * le chemin de l'argent il porte des valeurs dont on a besoin.
 *
 * @param {unknown} value
 * @param {number} [depth=0]
 */
function deepRedact(value, depth = 0) {
  if (depth >= 8) return "[TRUNCATED]";
  if (value == null) return value;

  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => deepRedact(item, depth + 1));
  }

  // Niveau 1 : par clé. `redactSensitive` rend une copie, jamais l'original.
  const byKey = redactSensitive(value, depth);
  if (typeof byKey !== "object" || byKey === null) return byKey;

  // Niveau 2 : par valeur, sur ce qui a survécu au niveau 1.
  const out = {};
  for (const [key, val] of Object.entries(byKey)) {
    out[key] = val === "[REDACTED]" ? val : deepRedact(val, depth + 1);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 2) Nettoyage d'un événement Sentry                                         */
/* -------------------------------------------------------------------------- */

/**
 * Les contextes que le SDK produit lui-même (runtime, os, device, trace…) ne
 * portent pas de donnée de personne et sont utiles au diagnostic. Tout autre
 * contexte vient de l'application : il passe par le masquage.
 */
const SDK_CONTEXTS = new Set(["runtime", "os", "device", "culture", "trace", "cloud_resource"]);

/**
 * Nettoie un événement AVANT expédition. PURE.
 *
 * Ce qui est retiré sans condition, parce que rien n'y est nécessaire au
 * diagnostic et que tout peut y être sensible :
 *   - `request.data`   : le corps de la requête (règle B.4, explicitement) ;
 *   - `request.cookies`: la session ;
 *   - `request.headers`: `Authorization`, cookies, jetons internes ;
 *   - les variables locales des piles d'appel (`frame.vars`) — elles portent
 *     les arguments de fonction, donc les montants, les identifiants, et sur
 *     ce service les corps de rappels prestataires.
 *
 * @param {object} event
 * @returns {object}
 */
function scrubEvent(event) {
  if (!event || typeof event !== "object") return event;

  const out = { ...event };

  if (out.request && typeof out.request === "object") {
    const req = { ...out.request };
    delete req.data;
    delete req.cookies;
    delete req.headers;
    if (req.url) req.url = stripUrlQuery(req.url);
    if (req.query_string) delete req.query_string;
    out.request = req;
  }

  /** L'utilisateur est réduit à son identifiant interne. Ni e-mail, ni IP. */
  if (out.user && typeof out.user === "object") {
    out.user = out.user.id ? { id: String(out.user.id) } : undefined;
  }

  if (out.message) out.message = redactString(out.message);

  if (Array.isArray(out.exception?.values)) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map((ex) => ({
        ...ex,
        value: ex.value ? redactString(ex.value) : ex.value,
        stacktrace: ex.stacktrace
          ? {
              ...ex.stacktrace,
              frames: (ex.stacktrace.frames || []).map((frame) => {
                const f = { ...frame };
                delete f.vars;
                return f;
              }),
            }
          : ex.stacktrace,
      })),
    };
  }

  if (out.contexts && typeof out.contexts === "object") {
    const contexts = {};
    for (const [key, val] of Object.entries(out.contexts)) {
      contexts[key] = SDK_CONTEXTS.has(key) ? val : deepRedact(val);
    }
    out.contexts = contexts;
  }

  if (out.extra) out.extra = deepRedact(out.extra);
  if (out.tags) out.tags = deepRedact(out.tags);

  if (Array.isArray(out.breadcrumbs)) {
    out.breadcrumbs = out.breadcrumbs.map(scrubBreadcrumb).filter(Boolean);
  } else if (out.breadcrumbs?.values) {
    out.breadcrumbs = {
      ...out.breadcrumbs,
      values: out.breadcrumbs.values.map(scrubBreadcrumb).filter(Boolean),
    };
  }

  return out;
}

/**
 * Nettoie une miette de piste. PURE.
 *
 * Les miettes HTTP portent l'URL appelée : on en retire la chaîne de requête,
 * jamais l'URL entière — savoir QUELLE route a été appelée juste avant une
 * erreur est souvent toute l'information utile.
 *
 * @param {object} crumb
 */
function scrubBreadcrumb(crumb) {
  if (!crumb || typeof crumb !== "object") return crumb;

  const out = { ...crumb };

  if (out.message) out.message = redactString(out.message);

  if (out.data && typeof out.data === "object") {
    const data = { ...out.data };
    if (data.url) data.url = stripUrlQuery(data.url);
    delete data.body;
    delete data.headers;
    out.data = deepRedact(data);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* 3) Le cycle de vie                                                         */
/* -------------------------------------------------------------------------- */

const SERVICE_NAME = "paynoval-transactions";

/**
 * Fabrique testable : toutes les dépendances sont fournies. L'instance par
 * défaut, en bas de fichier, lit le vrai environnement.
 *
 * @param {object} deps
 * @param {() => object|null} deps.loadSdk  charge `@sentry/node`, ou rend null
 * @param {string} deps.dsn
 * @param {string} deps.environment
 * @param {string} [deps.release]
 * @param {object} deps.logger
 */
function createErrorTracking({ loadSdk, dsn, environment, release, logger }) {
  let sdk = null;
  let started = false;

  const say = (level, message) => {
    const fn = logger && typeof logger[level] === "function" ? logger[level] : null;
    if (fn) fn.call(logger, message);
    else if (level === "error" || level === "warn") console[level === "error" ? "error" : "warn"](message);
  };

  /**
   * @returns {{enabled: boolean, reason: string}} l'état, pour le journal de
   * démarrage ET pour la sonde `/health/dependencies`. Une capacité qui ne
   * s'affirme que dans un log ne se vérifie pas à chaud (règle B.7).
   */
  function init() {
    if (started) return status();
    started = true;

    /**
     * En suite de tests, on n'expédie rien : un test qui pollue un projet
     * Sentry rend le tableau de bord inutilisable, et le bruit y coûte plus
     * cher que le signal qu'il apporterait.
     */
    if (environment === ENVIRONMENTS.TEST) {
      return status("suite de tests — expédition désactivée par conception");
    }

    if (!dsn) {
      say(
        "warn",
        "[errorTracking] SENTRY_DSN absente — AUCUNE erreur ne sera expédiée. " +
          "CONSÉQUENCE : une exception non rattrapée en production ne laissera de trace " +
          "que dans la sortie standard de l'instance, qui est locale et perdue au redéploiement."
      );
      return status("SENTRY_DSN absente");
    }

    const Sentry = safely(loadSdk, null);

    if (!Sentry) {
      say(
        "error",
        "[errorTracking] SENTRY_DSN est posée mais @sentry/node n'a pas pu être chargé. " +
          "CONSÉQUENCE : le suivi d'erreurs est INACTIF alors que la configuration affirme le contraire."
      );
      return status("@sentry/node introuvable");
    }

    /**
     * ⚠️ LA VÉRIFICATION QUI MANQUAIT — voir l'en-tête (D1).
     *
     * On refuse d'initialiser un SDK dont l'API attendue est absente, plutôt
     * que de sauter le montage sans rien dire. `setupExpressErrorHandler`
     * n'existe qu'à partir de la v8 ; s'il manque, le SDK installé est une v7
     * ou antérieure et ce module ne sait pas la piloter.
     */
    if (typeof Sentry.setupExpressErrorHandler !== "function") {
      say(
        "error",
        "[errorTracking] @sentry/node est chargé mais n'expose pas setupExpressErrorHandler : " +
          "SDK incompatible (v7 ou antérieure attendue en v8+). " +
          "CONSÉQUENCE : le suivi d'erreurs reste INACTIF. " +
          "C'est le défaut D1 — l'ancien code utilisait Sentry.Handlers, retiré en v8, " +
          "et le sautait en silence. Ne pas remettre de `?.` ici."
      );
      return status("SDK incompatible");
    }

    const ok = safely(() => {
      Sentry.init({
        dsn,
        environment,
        release,
        /**
         * Aucune donnée de personne par défaut : le SDK n'attache ni IP, ni
         * en-tête, ni corps. C'est le réglage que `beforeSend` ne doit pas
         * avoir à rattraper — deux verrous, pas un.
         */
        sendDefaultPii: false,
        /**
         * Échantillonnage des traces de performance. 0 en développement : on
         * ne paie pas un quota pour du trafic qu'on génère soi-même. Le jour
         * où de vrais utilisateurs arrivent, `SENTRY_TRACES_SAMPLE_RATE`
         * permet de monter sans redéployer de code.
         */
        tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
        beforeSend: (event) => safely(() => scrubEvent(event), null),
        beforeSendTransaction: (event) => safely(() => scrubEvent(event), null),
        beforeBreadcrumb: (crumb) => safely(() => scrubBreadcrumb(crumb), null),
      });
      Sentry.setTag("service", SERVICE_NAME);
      return true;
    }, false);

    if (!ok) return status("Sentry.init a échoué");

    sdk = Sentry;
    say("info", `[errorTracking] actif — environnement « ${environment} », service « ${SERVICE_NAME} »`);
    return status();
  }

  function status(reason = "") {
    return { enabled: Boolean(sdk), reason: sdk ? "" : reason || "non initialisé" };
  }

  /**
   * Monte le gestionnaire d'erreurs Express. À appeler APRÈS toutes les
   * routes et AVANT le gestionnaire d'erreurs applicatif.
   *
   * Rend `true` s'il a été monté — l'appelant peut ainsi le journaliser plutôt
   * que de le supposer.
   */
  function setupExpressErrorHandler(app) {
    if (!sdk) return false;
    return safely(() => {
      sdk.setupExpressErrorHandler(app);
      return true;
    }, false);
  }

  /**
   * Signale une erreur explicitement, avec un contexte déjà masqué.
   *
   * Ne lève jamais et ne rend jamais d'erreur : un appelant sur le chemin de
   * l'argent ne doit pas avoir à envelopper cet appel dans un try/catch.
   */
  function captureError(error, context = {}) {
    if (!sdk) return false;
    return safely(() => {
      sdk.withScope((scope) => {
        const safe = deepRedact(context);
        for (const [key, value] of Object.entries(safe || {})) {
          scope.setExtra(key, value);
        }
        if (safe && safe.requestId) scope.setTag("requestId", String(safe.requestId));
        sdk.captureException(error);
      });
      return true;
    }, false);
  }

  function setUser(userId) {
    if (!sdk) return false;
    return safely(() => {
      sdk.setUser(userId ? { id: String(userId) } : null);
      return true;
    }, false);
  }

  return { init, status, setupExpressErrorHandler, captureError, setUser };
}

/**
 * Exécute et absorbe. Le seul endroit du module où une erreur est avalée, et
 * c'est délibéré : le suivi d'erreurs ne doit jamais devenir la cause d'une
 * panne. L'échec n'est pas pour autant muet — chaque appelant rend un état que
 * `status()` expose, et la sonde de dépendances le publie.
 */
function safely(fn, fallback) {
  try {
    const out = fn();
    return out === undefined ? fallback : out;
  } catch {
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* 4) L'instance du service                                                   */
/* -------------------------------------------------------------------------- */

const instance = createErrorTracking({
  loadSdk: () => {
    try {
      // eslint-disable-next-line global-require
      return require("@sentry/node");
    } catch {
      return null;
    }
  },
  dsn: String(process.env.SENTRY_DSN || "").trim(),
  environment: APP_ENV,
  release: process.env.SENTRY_RELEASE || undefined,
  logger: console,
});

module.exports = {
  initErrorTracking: instance.init,
  errorTrackingStatus: instance.status,
  setupExpressErrorHandler: instance.setupExpressErrorHandler,
  captureError: instance.captureError,
  setErrorTrackingUser: instance.setUser,
  // Exportés pour les tests — tous purs.
  createErrorTracking,
  redactString,
  stripUrlQuery,
  deepRedact,
  scrubEvent,
  scrubBreadcrumb,
  isTest,
};
