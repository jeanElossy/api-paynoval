"use strict";

/**
 * ============================================================================
 * CACHE DES BARÈMES ACTIFS — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
 * ============================================================================
 *
 * ── Pourquoi ce fichier a changé de dépôt ───────────────────────────────────
 *
 * Le domaine des prix vivait dans la passerelle, et Tx-Core — le moteur
 * d'argent — lui demandait ses devis EN HTTP
 * (`services/transactions/shared/pricing.js` → GATEWAY_URL + /pricing/quote).
 *
 * La dépendance remontait donc du cœur vers le bord. Tx-Core l'annonçait
 * lui-même au démarrage : « GATEWAY_URL absente ⇒ toute transaction nécessitant
 * un devis échouera en 503 ». Une panne de la passerelle arrêtait les virements
 * **depuis l'intérieur du moteur**, et la passerelle ne pouvait plus être
 * déployée ni redémarrée seule.
 *
 * Stripe, PayPal et Adyen tiennent la même règle : les dépendances DESCENDENT.
 * Le bord route et authentifie ; il ne possède aucun domaine et ne détient
 * aucune base. Le devis est désormais un appel de fonction dans le processus
 * qui en a besoin.
 *
 * ── Résolution PARESSEUSE du modèle ─────────────────────────────────────────
 *
 * Le fichier d'origine faisait son `require` de modèle au chargement, ce qui
 * fonctionnait parce que la passerelle liait ses modèles à la connexion
 * Mongoose GLOBALE, déjà ouverte. Tx-Core ouvre des connexions NOMMÉES, et
 * aucune n'existe au moment où ce module est requis.
 *
 * Le modèle est donc résolu à l'APPEL, par `getPricingModel`, qui LÈVE une
 * erreur nommée si la base n'est pas là. Un `require` au chargement aurait
 * échoué au démarrage ; un accès optionnel aurait rendu `undefined`, puis un
 * devis vide, puis un prix de zéro (règle B.2).
 */
/**
 * CACHE MÉMOIRE DES RÈGLES TARIFAIRES ACTIVES
 * -----------------------------------------------------------------------------
 * /pricing/quote est ouvert sans JWT et lisait la collection entière à CHAQUE
 * devis. Le workflow de gouvernance fournit un point d'invalidation exact :
 * toute publication purge le cache. C'est la raison pour laquelle ce cache
 * arrive après la gouvernance et non avant — sans elle, il aurait fallu se
 * contenter d'un TTL aveugle.
 *
 * ⚠️ La fenêtre startsAt/endsAt N'EST PAS filtrée ici : une règle démarrant dans
 * une heure doit être en cache pour entrer en vigueur toute seule. C'est
 * `pickBestRule` qui évalue la fenêtre, à chaque devis.
 *
 * Le TTL reste un filet pour le cas multi-instances, où l'invalidation ne touche
 * que le process qui a publié.
 */

const { getPricingModel } = require("../../config/db");

/** Résolu à l'appel : la connexion n'existe pas au chargement du module. */
const modelePricingRule = () => getPricingModel("PricingRule");

const DEFAULT_TTL_MS = Number(process.env.PRICING_RULES_CACHE_TTL_MS || 120000);

/**
 * ============================================================================
 * L'INVALIDATION DOIT TRAVERSER LES INSTANCES (2026-09-16)
 * ============================================================================
 *
 * `invalidateRuleCache()` ne vidait que la mémoire du PROCESSUS qui publie. Sur
 * plusieurs instances — le cas dès qu'on passe à deux conteneurs —, les autres
 * continuaient de servir l'ancien barème jusqu'à l'expiration du TTL : jusqu'à
 * deux minutes pendant lesquelles deux clients identiques recevaient deux prix
 * différents, selon l'instance qui répondait.
 *
 * Le TTL restait donc, seul, à faire un travail qu'il ne sait pas faire : il
 * borne l'écart, il ne le supprime pas.
 *
 * Le motif est celui DÉJÀ retenu pour la liste noire de conformité
 * (`server.js`) : un client Redis DÉDIÉ à l'abonnement — un client passé en
 * mode abonné ne peut plus exécuter de commandes ordinaires — et un repli sur
 * le TTL seul quand Redis est absent, annoncé au démarrage (règle B.6).
 *
 * ⚠️ Ce canal ne transporte AUCUNE donnée tarifaire : seulement le signal
 * « relis la base ». Un prix qui voyagerait par Redis ferait de Redis une
 * source de vérité financière (invariant A1).
 */
const CANAL_INVALIDATION = "paynoval:pricing:rules:invalidate";

let cached = null;
let loadedAt = 0;
let inFlight = null;
let hits = 0;
let misses = 0;

/** Client Redis utilisé pour DIFFUSER l'invalidation. Jamais pour lire un prix. */
let diffuseur = null;
let abonne = false;

/** Chargement par défaut : règles actives et non archivées. */
async function defaultLoader() {
  return modelePricingRule().find({ active: true, archivedAt: null }).lean();
}

/**
 * @param {{loader?: function, ttlMs?: number}} options
 * @returns {Promise<Array>}
 */
async function getActiveRules({ loader = defaultLoader, ttlMs = DEFAULT_TTL_MS } = {}) {
  const fresh = cached !== null && Date.now() - loadedAt < ttlMs;

  if (fresh) {
    hits += 1;
    return cached;
  }

  // Une seule requête en vol : dix devis simultanés sur un cache froid ne
  // doivent pas produire dix lectures de la collection.
  if (inFlight) return inFlight;

  misses += 1;

  inFlight = (async () => {
    try {
      const rules = await loader();
      cached = Array.isArray(rules) ? rules : [];
      loadedAt = Date.now();
      return cached;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Vide la mémoire de CE processus. */
function viderCacheLocal() {
  cached = null;
  loadedAt = 0;
}

/**
 * Appelée après toute publication tarifaire. Le prochain devis rechargera —
 * sur cette instance immédiatement, sur les autres dès réception du signal.
 *
 * La diffusion est au mieux : si Redis est absent ou tombe, les autres
 * instances retombent sur le TTL. On ne fait pas échouer une publication
 * tarifaire réussie parce qu'un cache n'a pas pu être prévenu — mais on le DIT.
 */
function invalidateRuleCache({ diffuser = true } = {}) {
  viderCacheLocal();

  if (!diffuser || !diffuseur) return;

  try {
    const envoi = diffuseur.publish(CANAL_INVALIDATION, String(Date.now()));

    if (envoi && typeof envoi.catch === "function") {
      envoi.catch((err) => {
        console.warn(
          `⚠️ [PRICING] invalidation non diffusée (${err?.message || err}) — ` +
            "CONSÉQUENCE : les autres instances serviront l'ancien barème " +
            "jusqu'à l'expiration de leur TTL."
        );
      });
    }
  } catch (err) {
    console.warn(
      `⚠️ [PRICING] invalidation non diffusée (${err?.message || err}) — ` +
        "CONSÉQUENCE : les autres instances serviront l'ancien barème " +
        "jusqu'à l'expiration de leur TTL."
    );
  }
}

/**
 * Branche la diffusion et l'écoute de l'invalidation.
 *
 * @param {object} params
 * @param {object} [params.publisher]   Client Redis ordinaire, pour diffuser.
 * @param {object} [params.subscriber]  Client Redis DÉDIÉ, pour écouter.
 * @param {object} [params.logger]
 * @returns {{diffusion: boolean, abonnement: boolean, canal: string}} le régime EFFECTIF
 */
function initRuleCacheInvalidation({ publisher, subscriber, logger } = {}) {
  diffuseur = publisher || null;

  if (subscriber && typeof subscriber.subscribe === "function") {
    try {
      subscriber.subscribe(CANAL_INVALIDATION);

      subscriber.on("message", (canal) => {
        if (canal !== CANAL_INVALIDATION) return;

        /* `diffuser: false` : sans cela, chaque instance rediffuserait le
           signal qu'elle vient de recevoir — une boucle sans fin. */
        invalidateRuleCache({ diffuser: false });
      });

      abonne = true;
    } catch (err) {
      abonne = false;
      logger?.warn?.(
        `[pricing] abonnement à l'invalidation impossible : ${err?.message || err}`
      );
    }
  }

  return {
    diffusion: Boolean(diffuseur),
    abonnement: abonne,
    canal: CANAL_INVALIDATION,
  };
}

/** Remise à zéro — tests uniquement. */
function __resetInvalidation() {
  diffuseur = null;
  abonne = false;
  viderCacheLocal();
}

function cacheStats() {
  return {
    size: Array.isArray(cached) ? cached.length : 0,
    loadedAt: loadedAt || null,
    hits,
    misses,
  };
}

module.exports = {
  getActiveRules,
  invalidateRuleCache,
  initRuleCacheInvalidation,
  cacheStats,
  defaultLoader,
  DEFAULT_TTL_MS,
  CANAL_INVALIDATION,
  __resetInvalidation,
};
