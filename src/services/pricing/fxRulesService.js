"use strict";

/**
 * ============================================================================
 * RÈGLES DE MARGE DE CHANGE — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
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
const { getPricingModel } = require("../../config/db");

/** Résolu à l'appel : la connexion n'existe pas au chargement du module. */
const modeleFxRule = () => getPricingModel("FxRule");
const { createCache } = require("../cache/cacheService");
const { getClient } = require("../redisClientAccessor");

/**
 * Cache du RÉFÉRENTIEL de change — pas des devis.
 *
 * `pickFxRule` fait deux choses de nature très différentes :
 *   1. LIRE le jeu de règles actives pour une paire de devises (accès base,
 *      identique pour tous les appelants de cette paire) ;
 *   2. CHOISIR la règle applicable selon le montant, le pays, l'opérateur —
 *      un calcul pur, dépendant de l'appel.
 *
 * Seul (1) est caché. (2) rejoue intégralement à chaque appel.
 *
 * ⚠️ CE QUI N'EST PAS CACHÉ, ET NE DOIT PAS L'ÊTRE : le devis lui-même. Un
 * devis est un PRIX. Le servir depuis un cache, c'est afficher un taux qui
 * n'est plus celui appliqué à la confirmation — et cela déferait la frontière
 * de tarification « échec en fermeture ». On cache la donnée, jamais la
 * décision.
 *
 * Le client Redis est celui de la limitation de débit, réutilisé (§12 : aucune
 * requête HTTP ne crée de connexion). Sans Redis, `getClient()` rend `null` et
 * le cache est inerte : chaque appel relit la base, exactement comme avant.
 */
let _cache = null;

function cache() {
  if (_cache) return _cache;
  _cache = createCache({
    client: getClient(),
    env: process.env.NODE_ENV || "development",
    service: "gateway",
    logger: console,
  });
  return _cache;
}

/** Identifiant de cache d'une paire. Majuscules : `eur` et `EUR` sont la même paire. */
function clePaire(fromCurrency, toCurrency) {
  return `${toUpper(fromCurrency)}-${toUpper(toCurrency)}`;
}

function toUpper(v) {
  return String(v || "").trim().toUpperCase();
}

function toLower(v) {
  return String(v || "").trim().toLowerCase();
}

function isWildcard(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "" || s === "all" || s === "*";
}

function inRange(amount, minAmount, maxAmount) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return false;

  const min = Number(minAmount || 0);
  const max = maxAmount == null ? null : Number(maxAmount);

  if (a < min) return false;
  if (max != null && Number.isFinite(max) && a > max) return false;

  return true;
}

function matchOptionalLower(val, ruleVal) {
  if (isWildcard(ruleVal)) return true;
  return toLower(val) === toLower(ruleVal);
}

function matchOptionalUpper(val, ruleVal) {
  if (isWildcard(ruleVal)) return true;
  return toUpper(val) === toUpper(ruleVal);
}

function computeSpecificityScore(rule, ctx) {
  let score = 0;

  if (!isWildcard(rule.txType) && matchOptionalUpper(ctx.txType, rule.txType)) score += 50;
  if (!isWildcard(rule.method) && matchOptionalUpper(ctx.method, rule.method)) score += 45;
  if (!isWildcard(rule.provider) && matchOptionalLower(ctx.provider, rule.provider)) score += 40;

  if (!isWildcard(rule.country) && matchOptionalLower(ctx.country, rule.country)) score += 30;
  if (!isWildcard(rule.fromCountry) && matchOptionalLower(ctx.fromCountry, rule.fromCountry)) score += 35;
  if (!isWildcard(rule.toCountry) && matchOptionalLower(ctx.toCountry, rule.toCountry)) score += 35;

  if (!isWildcard(rule.fromCurrency) && matchOptionalUpper(ctx.fromCurrency, rule.fromCurrency)) score += 25;
  if (!isWildcard(rule.toCurrency) && matchOptionalUpper(ctx.toCurrency, rule.toCurrency)) score += 25;

  if (rule.minAmount != null) score += 5;
  if (rule.maxAmount != null) score += 5;

  return score;
}

async function pickFxRule(ctx) {
  const query = {
    active: true,
    fromCurrency: toUpper(ctx.fromCurrency),
    toCurrency: toUpper(ctx.toCurrency),
  };

  // Le jeu de règles ne dépend que de la paire de devises — le reste du filtrage
  // est en mémoire, sur des données déjà chargées. C'est ce qui rend cette
  // lecture cachable sans toucher à la justesse de la sélection.
  const rules = await cache().getOrSet("pricing-rules", clePaire(ctx.fromCurrency, ctx.toCurrency), () =>
    modeleFxRule().find(query).lean()
  );

  const candidates = rules
    .filter((r) => {
      if (!matchOptionalUpper(ctx.txType, r.txType)) return false;
      if (!matchOptionalUpper(ctx.method, r.method)) return false;
      if (!matchOptionalLower(ctx.provider, r.provider)) return false;
      if (!matchOptionalLower(ctx.country, r.country)) return false;
      if (!matchOptionalLower(ctx.fromCountry, r.fromCountry)) return false;
      if (!matchOptionalLower(ctx.toCountry, r.toCountry)) return false;
      if (!inRange(ctx.amount, r.minAmount, r.maxAmount)) return false;
      return true;
    })
    .map((r) => ({
      rule: r,
      specificity: computeSpecificityScore(r, ctx),
      priority: Number(r.priority || 0),
      updatedAt: r.updatedAt ? new Date(r.updatedAt).getTime() : 0,
      minAmount: Number(r.minAmount || 0),
    }))
    .sort((a, b) => {
      if (b.specificity !== a.specificity) return b.specificity - a.specificity;
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (b.minAmount !== a.minAmount) return b.minAmount - a.minAmount;
      return b.updatedAt - a.updatedAt;
    });

  return candidates[0]?.rule || null;
}

function applyFxRule(baseRate, rule) {
  const b = Number(baseRate);

  if (!Number.isFinite(b) || b <= 0) {
    return {
      rate: null,
      info: { error: "invalid_base_rate" },
    };
  }

  if (!rule || String(rule.mode || "").toUpperCase() === "PASS_THROUGH") {
    return {
      rate: b,
      info: {
        mode: "PASS_THROUGH",
        baseRate: b,
        adjustedRate: b,
      },
    };
  }

  const mode = String(rule.mode || "").toUpperCase();
  let out = b;

  if (mode === "OVERRIDE") {
    out = Number(rule.overrideRate);
  } else if (mode === "MARKUP_PERCENT") {
    out = b * (1 + Number(rule.markupPercent || 0) / 100);
  } else if (mode === "DELTA_PERCENT") {
    out = b * (1 + Number(rule.percent || 0) / 100);
  } else if (mode === "DELTA_ABS") {
    out = b + Number(rule.deltaAbs || 0);
  }

  if (!Number.isFinite(out) || out <= 0) {
    return {
      rate: null,
      info: {
        mode,
        error: "invalid_adjusted_rate",
      },
    };
  }

  const rounded = Math.round(out * 1e8) / 1e8;

  return {
    rate: rounded,
    info: {
      mode,
      baseRate: b,
      adjustedRate: rounded,
      ruleId: String(rule._id),
      name: rule.name || "",
      priority: Number(rule.priority || 0),
      percent: Number(rule.percent || 0),
      markupPercent: Number(rule.markupPercent || 0),
      deltaAbs: Number(rule.deltaAbs || 0),
      overrideRate: rule.overrideRate ?? null,
      txType: rule.txType || "",
      method: rule.method || "",
      provider: rule.provider || "",
      country: rule.country || "",
      fromCountry: rule.fromCountry || "",
      toCountry: rule.toCountry || "",
      fromCurrency: rule.fromCurrency || "",
      toCurrency: rule.toCurrency || "",
    },
  };
}

async function getAdjustedRate({ baseRate, context }) {
  const ctx = context || {};
  const rule = await pickFxRule(ctx);
  const applied = applyFxRule(baseRate, rule);

  if (rule?._id) {
    modeleFxRule().updateOne(
      { _id: rule._id },
      { $set: { lastUsedAt: new Date() } }
    ).catch(() => {});
  }

  return { rule: rule || null, ...applied };
}

/**
 * Invalide le cache des règles de change.
 *
 * **À appeler APRÈS le commit d'une écriture sur `FxRule`, jamais avant** :
 * invalider avant laisserait une fenêtre où un lecteur recharge l'ancienne
 * valeur depuis la base et la remet en cache, réintroduisant précisément la
 * donnée qu'on voulait chasser.
 *
 * Sans argument, purge toute la ressource — c'est le bon choix après une
 * modification en masse ou quand la paire touchée n'est pas connue de
 * l'appelant. Une purge trop large coûte quelques lectures ; une purge trop
 * étroite sert un tarif périmé.
 */
async function invalidateFxRulesCache({ fromCurrency, toCurrency } = {}) {
  if (fromCurrency && toCurrency) {
    return cache().invalider("pricing-rules", clePaire(fromCurrency, toCurrency));
  }
  return cache().invaliderRessource("pricing-rules");
}

module.exports = {
  getAdjustedRate,
  invalidateFxRulesCache,
  /** Exposé pour les tests et pour `/metrics`. */
  __cacheStats: () => cache().stats(),
};