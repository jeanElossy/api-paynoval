"use strict";

/**
 * ============================================================================
 * MODE D'EXÉCUTION D'UN PRESTATAIRE — RÉEL OU SIMULÉ
 * ============================================================================
 *
 * CE QUE CE MODULE CORRIGE
 * ------------------------
 * Les adapters (sept à l'époque ; six depuis le retrait du rail bancaire le
 * 2026-08-26) portaient tous la même ligne :
 *
 *     mock: String(process.env.ORANGE_MOCK || "true").toLowerCase() === "true"
 *
 * Le défaut était `"true"`. Et chaque opération élargissait encore le repli :
 *
 *     if (cfg.mock || !cfg.baseURL) return okResult({ externalStatus: "PENDING" })
 *
 * Deux chemins menaient donc au mode simulé — la variable non renseignée, ET
 * l'URL absente — et aucun des deux ne produisait la moindre erreur.
 *
 * Conséquence en production : un rail non configuré **accepte** l'ordre de
 * virement. Les fonds sont réservés chez l'expéditeur, jamais capturés, le
 * bénéficiaire n'est jamais payé, et l'application a pourtant accusé réception.
 * La transaction reste en `pending` jusqu'à ce que l'auto-annulation la ramasse.
 *
 * Ce n'est pas un vol d'argent — le simulé rend `PENDING`, pas `completed`.
 * C'est pire dans un sens : c'est un **fail-open sur le chemin de l'argent**,
 * la classe de défaut qui ne se voit ni dans les journaux, ni dans les
 * métriques, ni dans les tests.
 *
 * LA RÈGLE APPLIQUÉE ICI
 * ----------------------
 * Un rail de paiement qui ne peut pas payer doit **refuser**, jamais accepter.
 * C'est ce que font Stripe et Wise : une clé d'API absente produit une erreur de
 * configuration au démarrage, pas un paiement fantôme.
 *
 * Mais le développement doit continuer de fonctionner sans les identifiants de
 * production. D'où la séparation par environnement, et elle est explicite :
 *
 *   ┌────────────────────┬──────────────┬───────────────────────────────────┐
 *   │ X_MOCK             │ X_BASE_URL   │ Résultat                          │
 *   ├────────────────────┼──────────────┼───────────────────────────────────┤
 *   │ "false"            │ présente     │ RÉEL                              │
 *   │ "false"            │ absente      │ ERREUR — réel demandé, non config │
 *   │ "true"             │ quelconque   │ SIMULÉ (erreur si production)     │
 *   │ non renseignée     │ présente     │ RÉEL — l'URL vaut déclaration     │
 *   │ non renseignée     │ absente      │ SIMULÉ hors prod · ERREUR en prod │
 *   └────────────────────┴──────────────┴───────────────────────────────────┘
 *
 * La dernière ligne est le correctif central : en production, un rail non
 * configuré ne peut plus se simuler lui-même en silence.
 *
 * POURQUOI LEVER, ET POURQUOI C'EST SÛR ICI
 * -----------------------------------------
 * `submitExternalExecution()` appelle `resolved.execute()` **sans try/catch**
 * (`handlers/submitExternalExecution.js:365`). Une exception y remonte donc
 * jusqu'au gestionnaire d'erreurs, et la transaction reste dans l'état où elle
 * était : `pending`, fonds réservés, rien de capturé, rien de crédité.
 *
 * C'est exactement le comportement voulu. Vérifié, pas supposé : l'appel
 * prestataire est délibérément hors transaction Mongo (le commentaire du
 * fichier explique pourquoi), et la persistance ne vient qu'après.
 *
 * L'ÉCHAPPATOIRE DE PRODUCTION
 * ----------------------------
 * `ALLOW_PROVIDER_MOCK_IN_PRODUCTION=true` autorise le simulé en production.
 * Elle existe pour un cas réel — une recette sur l'environnement de production
 * avant l'ouverture d'un rail — et pour une seule raison : sans échappatoire
 * déclarée, quelqu'un finira par remettre le défaut permissif. Mieux vaut une
 * porte nommée, journalisée et cherchable qu'une régression silencieuse.
 */

/** Environnements où un rail non configuré peut se simuler sans danger. */
const MOCK_ALLOWED_BY_DEFAULT = Object.freeze(["development", "test", "sandbox"]);

/**
 * Erreur de configuration d'un rail.
 *
 * `503` et non `500` : le service est sain, c'est le rail qui est indisponible.
 * La distinction compte pour l'appelant, qui peut réessayer plus tard ou router
 * vers un autre prestataire, et pour la supervision, qui ne doit pas confondre
 * un bogue avec un rail non ouvert.
 */
class ProviderConfigError extends Error {
  constructor(message, { provider, envPrefix, code = "PROVIDER_NOT_CONFIGURED" } = {}) {
    super(message);
    this.name = "ProviderConfigError";
    this.status = 503;
    this.statusCode = 503;
    this.code = code;
    this.provider = provider || null;
    this.envPrefix = envPrefix || null;
    this.expose = false;
  }
}

function readFlag(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === null) return null;

  const v = String(raw).trim().toLowerCase();
  if (v === "") return null;
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;

  // Une valeur non reconnue n'est pas un `false` implicite : c'est une faute de
  // frappe, et la traiter comme « réel » sur un rail non configuré ferait
  // échouer les paiements sans expliquer pourquoi.
  return null;
}

function isProduction(env) {
  const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase();
  return !MOCK_ALLOWED_BY_DEFAULT.includes(nodeEnv) && nodeEnv !== "";
}

/**
 * Détermine si un adapter doit appeler le prestataire ou le simuler.
 *
 * Fonction **pure** : `env` est un paramètre, donc elle se teste sans toucher
 * à `process.env`.
 *
 * @param {object}  opts
 * @param {string}  opts.provider   nom canonique ("orange", "stripe"…)
 * @param {string}  opts.envPrefix  préfixe des variables ("ORANGE", "STRIPE"…)
 * @param {string}  opts.baseURL    URL de base résolue, chaîne vide si absente
 * @param {object} [opts.env]       source des variables (défaut `process.env`)
 * @returns {{ mock: boolean, reason: string }}
 * @throws  {ProviderConfigError}
 */
function resolveProviderMode({ provider, envPrefix, baseURL, env = process.env }) {
  const prefix = String(envPrefix || "").trim().toUpperCase();
  const name = String(provider || prefix || "inconnu").trim().toLowerCase();
  const url = String(baseURL || "").trim();

  const explicit = readFlag(env, `${prefix}_MOCK`);
  const prod = isProduction(env);

  /* Simulé demandé explicitement -------------------------------------------- */
  if (explicit === true) {
    if (prod && readFlag(env, "ALLOW_PROVIDER_MOCK_IN_PRODUCTION") !== true) {
      throw new ProviderConfigError(
        `Rail « ${name} » en mode simulé alors que NODE_ENV=production. ` +
          `Poser ${prefix}_MOCK=false et configurer ${prefix}_BASE_URL, ou ` +
          `ALLOW_PROVIDER_MOCK_IN_PRODUCTION=true si la simulation est voulue.`,
        { provider: name, envPrefix: prefix, code: "PROVIDER_MOCK_IN_PRODUCTION" }
      );
    }

    return { mock: true, reason: "explicit" };
  }

  /* Réel demandé explicitement ---------------------------------------------- */
  if (explicit === false) {
    if (!url) {
      throw new ProviderConfigError(
        `Rail « ${name} » déclaré réel (${prefix}_MOCK=false) mais ` +
          `${prefix}_BASE_URL est absente. Le rail ne peut pas payer.`,
        { provider: name, envPrefix: prefix }
      );
    }

    return { mock: false, reason: "explicit" };
  }

  /* Non renseigné ------------------------------------------------------------ */

  // Une URL de base configurée vaut déclaration d'intention : personne ne
  // renseigne l'URL d'Orange pour continuer à simuler.
  if (url) {
    return { mock: false, reason: "inferred-from-base-url" };
  }

  if (prod) {
    throw new ProviderConfigError(
      `Rail « ${name} » non configuré (ni ${prefix}_BASE_URL, ni ${prefix}_MOCK) ` +
        `et NODE_ENV=production. Un rail non configuré ne doit pas accepter ` +
        `d'ordre de paiement.`,
      { provider: name, envPrefix: prefix }
    );
  }

  return { mock: true, reason: "default-non-production" };
}

/**
 * Variante non levante, pour le démarrage et la supervision : rend l'erreur
 * plutôt que de la propager.
 *
 * Le démarrage doit pouvoir décrire TOUS les rails, y compris ceux qui sont mal
 * configurés — s'arrêter au premier ne dirait pas combien il en reste.
 */
function inspectProviderMode({ provider, envPrefix, baseURL, env = process.env }) {
  try {
    const mode = resolveProviderMode({ provider, envPrefix, baseURL, env });
    return { provider, envPrefix, ok: true, ...mode, error: null };
  } catch (err) {
    return {
      provider,
      envPrefix,
      ok: false,
      mock: null,
      reason: "error",
      error: err,
    };
  }
}

module.exports = {
  ProviderConfigError,
  resolveProviderMode,
  inspectProviderMode,
  MOCK_ALLOWED_BY_DEFAULT,
  // exportés pour les tests
  readFlag,
  isProduction,
};
