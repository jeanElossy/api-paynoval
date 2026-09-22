"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * L'ENVIRONNEMENT D'EXÉCUTION — RÉSOLU UNE FOIS, GELÉ, ANNONCÉ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ CE MODULE EST RÉPLIQUÉ OCTET POUR OCTET DANS LES TROIS SERVICES :
 *     api-paynoval/src/services/appEnv.js
 *     paynoval-backend/services/appEnv.js
 *     api-gateway/api-gateway/src/services/appEnv.js
 * Toute correction ici doit être reportée dans les deux autres. Un test
 * d'empreinte (`test/appEnvReplication.test.js`) échoue à la divergence.
 *
 * ── LE DÉFAUT QUE CE MODULE FERME ─────────────────────────────────────────
 *
 * `AuditEvent.env` avait pour énumération `["production", "test"]` et pour
 * DÉFAUT `"production"`. Tout ce qui s'écrivait depuis un poste de
 * développement était donc étiqueté « production ». Les trois autres modèles
 * de journalisation (`AuditLog`, `SecurityLog`, `AdminLog`) n'avaient aucun
 * champ d'environnement du tout.
 *
 * Ce n'est pas théorique sur ce projet : le 2026-09-22, il a été découvert que
 * le cluster porte DEUX jeux de bases (`paynoval` et `paynoval-test`) et qu'une
 * session entière avait travaillé sur le mauvais. Un tableau de bord qui
 * mélange les deux ne se corrige pas après coup — on ne peut pas départager
 * rétroactivement des événements qui ne portent pas leur origine.
 *
 * ── CE QUE FONT STRIPE ET PAYPAL, ET QU'ON FAIT ICI ───────────────────────
 *
 * Chez Stripe, un objet appartient au mode « test » ou au mode « live », le
 * champ est porté par l'objet lui-même (`livemode`), il est immuable, et
 * AUCUNE requête ne peut lire à travers la frontière. Le principe qu'on retient :
 *
 *   1. l'environnement est une propriété de la DONNÉE, pas du tableau de bord
 *      qui l'affiche — sans quoi le filtrage dépend de celui qui regarde ;
 *   2. il est résolu UNE SEULE FOIS, au démarrage, et gelé — une valeur lue à
 *      chaud pourrait changer en cours de route et couper une série en deux ;
 *   3. le défaut n'est JAMAIS « production ». Étiqueter par défaut du
 *      développement en production salit des données qu'on ne peut plus
 *      nettoyer ; l'inverse ne fait que masquer du signal, ce qui se répare.
 *
 * ── POURQUOI CE MODULE N'ÉCHOUE PAS EN FERMETURE ──────────────────────────
 *
 * La règle B.2 impose la fermeture sur le chemin de l'argent. Ce module n'y est
 * pas : c'est de l'étiquetage d'observation. Un service qui refuserait de
 * démarrer parce qu'`APP_ENV` est mal orthographiée serait une panne CAUSÉE par
 * l'outil de surveillance — exactement ce que le monitoring ne doit jamais
 * faire. On résout donc toujours une valeur, mais une valeur mal formée est
 * ANNONCÉE au démarrage avec sa conséquence (règle B.6), pas avalée.
 */

/**
 * Les quatre environnements reconnus.
 *
 * `test` est celui des suites automatisées, distinct de `development` : il ne
 * doit produire ni alerte, ni envoi vers un suivi d'erreurs externe.
 */
const ENVIRONMENTS = Object.freeze({
  DEVELOPMENT: "development",
  TEST: "test",
  STAGING: "staging",
  PRODUCTION: "production",
});

const VALID = Object.freeze(Object.values(ENVIRONMENTS));

/**
 * Synonymes tolérés. Une variable d'hébergeur ne se négocie pas : Render pose
 * `NODE_ENV=production`, certains fournisseurs écrivent `prod` ou `PROD`. Les
 * refuser ferait retomber sur le défaut, c'est-à-dire sur `development` — un
 * service de production s'annoncerait comme un poste de développement.
 */
const ALIASES = Object.freeze({
  dev: ENVIRONMENTS.DEVELOPMENT,
  develop: ENVIRONMENTS.DEVELOPMENT,
  development: ENVIRONMENTS.DEVELOPMENT,
  local: ENVIRONMENTS.DEVELOPMENT,
  test: ENVIRONMENTS.TEST,
  testing: ENVIRONMENTS.TEST,
  ci: ENVIRONMENTS.TEST,
  stage: ENVIRONMENTS.STAGING,
  staging: ENVIRONMENTS.STAGING,
  preprod: ENVIRONMENTS.STAGING,
  preproduction: ENVIRONMENTS.STAGING,
  prod: ENVIRONMENTS.PRODUCTION,
  production: ENVIRONMENTS.PRODUCTION,
  live: ENVIRONMENTS.PRODUCTION,
});

/**
 * Normalise une valeur brute. Fonction PURE — c'est la pièce à tester.
 *
 * @param {unknown} raw
 * @returns {string|null} un environnement valide, ou `null` si non reconnu.
 */
function normalizeEnv(raw) {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase();

  if (!key) return null;

  return ALIASES[key] || null;
}

/**
 * Résout l'environnement à partir d'un jeu de variables.
 *
 * Fonction PURE : tout lui est fourni, rien n'est lu de `process`. Elle rend
 * aussi la façon dont elle a tranché, parce que « production parce
 * qu'APP_ENV le dit » et « production parce que NODE_ENV le dit » ne se
 * diagnostiquent pas pareil.
 *
 * ORDRE, et il compte :
 *   1. `APP_ENV` — la variable dédiée, celle qui fait autorité ;
 *   2. `NODE_ENV` — le repli, parce que tout hébergeur la pose ;
 *   3. `development` — le défaut, JAMAIS `production` (voir en-tête).
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{env: string, source: string, raw: string, warning: string|null}}
 */
function resolveEnvironment(env = process.env) {
  const rawAppEnv = env.APP_ENV;
  const rawNodeEnv = env.NODE_ENV;

  const fromApp = normalizeEnv(rawAppEnv);
  if (fromApp) {
    return { env: fromApp, source: "APP_ENV", raw: String(rawAppEnv), warning: null };
  }

  /**
   * `APP_ENV` posée mais illisible est le cas le plus dangereux : quelqu'un a
   * VOULU déclarer un environnement et s'est trompé. Retomber silencieusement
   * sur `NODE_ENV` lui donnerait raison à tort.
   */
  const appEnvWasSet = String(rawAppEnv ?? "").trim() !== "";

  const fromNode = normalizeEnv(rawNodeEnv);
  if (fromNode) {
    return {
      env: fromNode,
      source: "NODE_ENV",
      raw: String(rawNodeEnv),
      warning: appEnvWasSet
        ? `APP_ENV="${rawAppEnv}" n'est pas reconnue — repli sur NODE_ENV="${rawNodeEnv}"`
        : null,
    };
  }

  return {
    env: ENVIRONMENTS.DEVELOPMENT,
    source: "default",
    raw: "",
    warning: appEnvWasSet
      ? `APP_ENV="${rawAppEnv}" et NODE_ENV="${rawNodeEnv ?? ""}" ne sont reconnues ni l'une ni l'autre`
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Résolution unique, au chargement du module                                 */
/* -------------------------------------------------------------------------- */

const RESOLVED = Object.freeze(resolveEnvironment(process.env));

/** L'environnement courant, gelé pour la durée du processus. */
const APP_ENV = RESOLVED.env;

const isProduction = () => APP_ENV === ENVIRONMENTS.PRODUCTION;
const isStaging = () => APP_ENV === ENVIRONMENTS.STAGING;
const isDevelopment = () => APP_ENV === ENVIRONMENTS.DEVELOPMENT;
const isTest = () => APP_ENV === ENVIRONMENTS.TEST;

/**
 * Vrai quand on sert du trafic pour de vrai — production ou pré-production.
 *
 * C'est le prédicat à utiliser pour décider d'ARMER une alerte ou d'expédier
 * vers un service externe. `isProduction()` seul oublierait la pré-production,
 * dont c'est justement le rôle de se comporter comme la production.
 */
const isLiveTraffic = () => isProduction() || isStaging();

/**
 * La ligne de démarrage — règle B.6 : annoncer, avec la conséquence.
 *
 * Rendue plutôt que journalisée, pour que le module reste sans dépendance et
 * testable. L'appelant choisit son `logger`.
 *
 * @returns {{level: "info"|"warn", message: string}}
 */
function startupReport() {
  const base = `[env] environnement = ${APP_ENV.toUpperCase()} (source: ${RESOLVED.source})`;

  if (RESOLVED.warning) {
    return {
      level: "warn",
      message:
        `${base} — ⚠️ ${RESOLVED.warning}. ` +
        `CONSÉQUENCE : tous les événements de supervision, d'audit et de sécurité ` +
        `écrits par ce processus porteront l'étiquette "${APP_ENV}". ` +
        `Poser APP_ENV à l'une de : ${VALID.join(", ")}.`,
    };
  }

  if (RESOLVED.source === "default") {
    return {
      level: "warn",
      message:
        `${base} — ni APP_ENV ni NODE_ENV ne sont posées. ` +
        `CONSÉQUENCE : le défaut est "development" (JAMAIS "production", pour ne pas ` +
        `salir les tableaux de bord de production avec des données de développement). ` +
        `Si ce processus sert du trafic réel, poser APP_ENV=production.`,
    };
  }

  return { level: "info", message: base };
}

module.exports = {
  APP_ENV,
  ENVIRONMENTS,
  VALID_ENVIRONMENTS: VALID,
  isProduction,
  isStaging,
  isDevelopment,
  isTest,
  isLiveTraffic,
  startupReport,
  // Exportées pour les tests : pures, sans lecture de `process`.
  normalizeEnv,
  resolveEnvironment,
};
