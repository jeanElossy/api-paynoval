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

let cached = null;
let loadedAt = 0;
let inFlight = null;
let hits = 0;
let misses = 0;

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

/** Appelée après toute publication. Le prochain devis rechargera. */
function invalidateRuleCache() {
  cached = null;
  loadedAt = 0;
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
  cacheStats,
  defaultLoader,
  DEFAULT_TTL_MS,
};
