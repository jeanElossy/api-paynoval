"use strict";

/**
 * ============================================================================
 * LECTURE DE LA RÉFÉRENCE CLIENT — bornée, mise en cache, jamais bloquante
 * ============================================================================
 *
 * `behaviorBaseline.js` compare. Ce module-ci va CHERCHER de quoi comparer.
 * La séparation n'est pas cosmétique : la comparaison doit rester testable sans
 * base de données, et la lecture doit rester remplaçable sans toucher à la
 * règle.
 *
 * ── ⚠️ CETTE LECTURE EST SUR LE CHEMIN D'UN PAIEMENT ────────────────────
 *
 * Elle s'exécute pendant qu'un client attend son virement. Trois gardes, et
 * aucune n'est facultative :
 *
 *   1. **Bornée en volume** — au plus `maxSamples` opérations lues. Un
 *      commerçant à 40 000 virements ne doit pas coûter plus cher qu'un
 *      particulier à 12.
 *   2. **Bornée en temps** — `maxTimeMS` côté serveur Mongo. Sans lui, une
 *      base lente transforme un contrôle de risque en panne de paiement.
 *   3. **Mise en cache** — une habitude ne change pas en quinze minutes.
 *      Recalculer à chaque virement serait payer un coût permanent pour une
 *      valeur quasi constante.
 *
 * ── ⚠️ CE MODULE NE LÈVE JAMAIS ─────────────────────────────────────────
 *
 * Il rend `null` quand il n'a pas pu lire. `riskScore` traduit ce `null` en
 * `SIGNAL_UNAVAILABLE` — « je ne sais pas », qui n'est ni « tout va bien » ni
 * « refuser ». Faire échouer un virement parce qu'une statistique n'a pas
 * répondu serait un défaut plus grave que le risque qu'elle couvre.
 *
 * ── ⚠️ REDIS N'EST QU'UN CACHE ICI (invariant A.1) ──────────────────────
 *
 * Aucune décision financière ne dépend de sa persistance : sa perte fait
 * recalculer, jamais se tromper. Chaque clé porte un TTL explicite (A.6).
 *
 * ── LA RÉFÉRENCE EST CALCULÉE SUR LES SEULES OPÉRATIONS `confirmed` ─────
 *
 * Volontaire. Une tentative refusée, annulée ou en attente n'est pas une
 * habitude : l'inclure laisserait un fraudeur FABRIQUER sa propre référence en
 * multipliant les essais avant le virement qui compte.
 */

const {
  BASELINE_CONFIG,
  summarizeHistory,
} = require("./behaviorBaseline");

/** Seules les opérations réellement abouties font l'habitude. */
const BASELINE_STATUSES = Object.freeze(["confirmed"]);

/** Durée de vie du cache, en secondes. Une habitude bouge en semaines. */
const CACHE_TTL_SECONDS = 900;

/**
 * ⚠️ VERSION DANS LA CLÉ. Le jour où la forme du résumé change, les anciennes
 * entrées ne doivent pas être relues comme si elles étaient les nouvelles :
 * elles seraient interprétées de travers, silencieusement, pendant tout le TTL.
 */
const CACHE_PREFIX = "risk:baseline:v1";

/** Budget serveur de l'agrégation, en millisecondes. */
const QUERY_TIMEOUT_MS = 1500;

function cacheKey(userId, currencyIso) {
  return `${CACHE_PREFIX}:${userId}:${currencyIso || "ANY"}`;
}

/**
 * @param {object} deps
 * @param {object|null} deps.redisClient   client ioredis, ou `null` (sans cache)
 * @param {Function} deps.resolveModel     rend le modèle `Transaction`
 * @param {Function} deps.buildCurrencyMatch
 * @param {Function} deps.buildAmountExpr
 * @param {Function} [deps.now]
 * @param {object} [deps.config]
 */
function createBaselineStore({
  redisClient = null,
  resolveModel,
  buildCurrencyMatch = () => ({}),
  buildAmountExpr,
  now = () => Date.now(),
  config = BASELINE_CONFIG,
  logger = null,
} = {}) {
  const cfg = { ...BASELINE_CONFIG, ...(config || {}) };

  const cacheUsable = () =>
    Boolean(redisClient) &&
    (redisClient.status === undefined || redisClient.status === "ready");

  /** Compteurs d'exploitation — annoncés au démarrage, règles B.6 et B.7. */
  const compteurs = { hits: 0, miss: 0, erreurs: 0, calculs: 0 };

  async function lireCache(cle) {
    if (!cacheUsable()) return null;

    try {
      const brut = await redisClient.get(cle);
      if (!brut) return null;

      const valeur = JSON.parse(brut);

      /**
       * Une entrée illisible est traitée comme absente, PAS comme vide : rendre
       * `{count: 0}` ferait croire à une habitude non établie alors qu'on n'a
       * simplement pas su relire le cache.
       */
      if (!valeur || typeof valeur !== "object") return null;
      if (!Array.isArray(valeur.hourCounts)) return null;

      return valeur;
    } catch {
      return null;
    }
  }

  async function ecrireCache(cle, valeur) {
    if (!cacheUsable()) return false;

    try {
      await redisClient.set(cle, JSON.stringify(valeur), "EX", CACHE_TTL_SECONDS);
      return true;
    } catch {
      /**
       * Best-effort assumé : ne pas avoir mis en cache coûte un recalcul, pas
       * une erreur. Le signaler au client serait absurde.
       */
      return false;
    }
  }

  /**
   * Agrégation bornée. `$hour` travaille en UTC — et la comparaison dans
   * `evaluateBaseline` utilise la MÊME référence, donc l'ensemble reste
   * cohérent même si ce n'est pas l'heure locale du client.
   */
  async function calculer({ userId, currencyIso }) {
    const Transaction = resolveModel();

    const depuis = new Date(now() - cfg.lookbackDays * 24 * 60 * 60 * 1000);

    const match = {
      sender: String(userId),
      createdAt: { $gte: depuis },
      status: { $in: [...BASELINE_STATUSES] },
    };

    const currencyMatch = buildCurrencyMatch(currencyIso);

    const pipeline = [
      {
        $match:
          currencyMatch && Object.keys(currencyMatch).length
            ? { $and: [match, currencyMatch] }
            : match,
      },
      { $sort: { createdAt: -1 } },
      { $limit: cfg.maxSamples },
      {
        $project: {
          _id: 0,
          amount: buildAmountExpr(),
          hour: { $hour: "$createdAt" },
        },
      },
    ];

    const lignes = await Transaction.aggregate(pipeline).option({
      maxTimeMS: QUERY_TIMEOUT_MS,
    });

    compteurs.calculs += 1;

    return summarizeHistory(Array.isArray(lignes) ? lignes : []);
  }

  /**
   * @returns {Promise<object|null>} résumé, ou `null` si rien n'a pu être lu.
   */
  async function read({ userId, currencyIso = null } = {}) {
    const uid = String(userId || "").trim();
    if (!uid) return null;

    const cle = cacheKey(uid, currencyIso);

    const enCache = await lireCache(cle);

    if (enCache) {
      compteurs.hits += 1;
      return enCache;
    }

    compteurs.miss += 1;

    try {
      const resume = await calculer({ userId: uid, currencyIso });

      // Best-effort, sans attendre : le client n'a pas à patienter pour un cache.
      ecrireCache(cle, resume).catch(() => {});

      return resume;
    } catch (error) {
      compteurs.erreurs += 1;

      /**
       * ⚠️ ON SIGNALE, ON N'AVALE PAS (règle B.1). Un `catch` muet ici
       * rendrait une panne d'agrégation indiscernable d'un client sans
       * historique — et les deux ne veulent PAS dire la même chose.
       */
      logger?.warn?.("[risk] référence client illisible", {
        cause: error?.code || error?.name || "inconnue",
      });

      return null;
    }
  }

  /**
   * Invalide la référence d'un client — appelée après une opération confirmée,
   * pour que l'habitude intègre le virement qui vient d'aboutir.
   */
  async function invalidate({ userId, currencyIso = null } = {}) {
    const uid = String(userId || "").trim();
    if (!uid || !cacheUsable()) return false;

    try {
      await redisClient.del(cacheKey(uid, currencyIso));
      return true;
    } catch {
      return false;
    }
  }

  function stats() {
    return { ...compteurs, cacheEnabled: cacheUsable() };
  }

  return { read, invalidate, stats };
}

module.exports = {
  BASELINE_STATUSES,
  CACHE_TTL_SECONDS,
  CACHE_PREFIX,
  QUERY_TIMEOUT_MS,
  cacheKey,
  createBaselineStore,
};
