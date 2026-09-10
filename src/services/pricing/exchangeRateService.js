"use strict";

/**
 * ============================================================================
 * TAUX DE CHANGE — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
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
const axios = require("axios");
const { LRUCache } = require("lru-cache");

const { getPricingModel } = require("../../config/db");

/** Résolu à l'appel : la connexion n'existe pas au chargement du module. */
const modeleExchangeRate = () => getPricingModel("ExchangeRate");
const { normalizeCurrency } = require("../../utils/currency");

/* =========================================================
 * Config
 * ========================================================= */

function normalizeBase(raw) {
  const base = String(raw || "").trim().replace(/\/+$/, "");
  return base || "";
}

const FX_API_BASE_URL = normalizeBase(
  process.env.FX_API_BASE_URL || "https://open.er-api.com/v6"
);

const FX_API_BASE_WITH_KEY = normalizeBase(
  process.env.FX_API_BASE_WITH_KEY || "https://v6.exchangerate-api.com/v6"
);

const FX_API_KEY = String(
  process.env.FX_API_KEY || process.env.EXCHANGE_RATE_API_KEY || ""
).trim();

const FX_CROSS = String(process.env.FX_CROSS || "USD").trim().toUpperCase();

const FX_CACHE_TTL_MS = Number(process.env.FX_CACHE_TTL_MS || 10 * 60 * 1000);
const FX_FAIL_COOLDOWN_MS = Number(
  process.env.FX_FAIL_COOLDOWN_MS || 10 * 60 * 1000
);
const FX_DB_SNAPSHOT_MAX_AGE_MS = Number(
  process.env.FX_DB_SNAPSHOT_MAX_AGE_MS || 24 * 60 * 60 * 1000
);

const PEG_XOF_PER_EUR = Number(process.env.PEG_XOF_PER_EUR || 655.957);

const pairCache = new LRUCache({ max: 2000, ttl: FX_CACHE_TTL_MS });
const failCache = new LRUCache({ max: 2000, ttl: FX_FAIL_COOLDOWN_MS });

/* =========================================================
 * Helpers
 * ========================================================= */

function normCcy(input) {
  const n = normalizeCurrency ? normalizeCurrency(input) : input;
  if (!n) return "";
  return String(n).trim().toUpperCase();
}

function safeNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildCacheKey(prefix, from, to) {
  return `${prefix}:${from}_${to}`;
}

function setCooldown(key, err, provider) {
  const status = err?.response?.status || null;
  const retryAfter = Number(err?.response?.headers?.["retry-after"]);
  const cdMs =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : FX_FAIL_COOLDOWN_MS;

  const payload = {
    provider: provider || "unknown",
    status,
    message: err?.message || "fx_provider_error",
    retryAfterSec: Math.ceil(cdMs / 1000),
    nextTryAt: Date.now() + cdMs,
  };

  failCache.set(key, payload);
  return payload;
}

function getCooldown(key) {
  const v = failCache.get(key);
  if (!v) return null;
  if (Date.now() < v.nextTryAt) return v;
  failCache.delete(key);
  return null;
}

function pegRate(fromCur, toCur) {
  if (!Number.isFinite(PEG_XOF_PER_EUR) || PEG_XOF_PER_EUR <= 0) return null;

  if (fromCur === "XOF" && toCur === "EUR") return 1 / PEG_XOF_PER_EUR;
  if (fromCur === "EUR" && toCur === "XOF") return PEG_XOF_PER_EUR;

  return null;
}

/* =========================================================
 * DB custom / snapshots
 * ========================================================= */

async function getCustomActiveRate(fromCur, toCur) {
  const doc = await modeleExchangeRate().findOne({
    from: fromCur,
    to: toCur,
    active: true,
  }).lean();

  if (!doc || !Number.isFinite(Number(doc.rate)) || Number(doc.rate) <= 0) {
    return null;
  }

  return {
    rate: Number(doc.rate),
    source: "db-custom",
    stale: false,
    provider: doc.provider || null,
    asOfDate: doc.asOfDate || null,
    id: String(doc._id),
  };
}

async function getSnapshotFromDb(fromCur, toCur) {
  const doc = await modeleExchangeRate().findOne({
    from: fromCur,
    to: toCur,
    active: false,
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  if (!doc || !Number.isFinite(Number(doc.rate)) || Number(doc.rate) <= 0) {
    return null;
  }

  return doc;
}

function isSnapshotFreshEnough(doc) {
  const ts = doc?.updatedAt || doc?.createdAt;
  if (!ts) return false;
  const age = Date.now() - new Date(ts).getTime();
  return Number.isFinite(age) && age >= 0 && age <= FX_DB_SNAPSHOT_MAX_AGE_MS;
}

async function saveSnapshotToDb(fromCur, toCur, payload) {
  try {
    const rate = Number(payload?.rate);
    if (!Number.isFinite(rate) || rate <= 0) return;

    await modeleExchangeRate().updateOne(
      { from: fromCur, to: toCur, active: false },
      {
        $set: {
          rate,
          active: false,
          updatedBy: "snapshot",
          source: payload?.source || "live-market",
          provider: payload?.provider || null,
          asOfDate: payload?.asOfDate ? new Date(payload.asOfDate) : null,
          stale: !!payload?.stale,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch {
    // no-op
  }
}

/* =========================================================
 * External live market
 * ========================================================= */

async function fetchLiveCrossRates() {
  // 1) Provider avec clé
  if (FX_API_KEY && FX_API_KEY !== "REPLACE_ME") {
    const url = `${FX_API_BASE_WITH_KEY}/${encodeURIComponent(
      FX_API_KEY
    )}/latest/${encodeURIComponent(FX_CROSS)}`;

    try {
      const { data } = await axios.get(url, { timeout: 15000 });
      const rates = data?.conversion_rates || null;

      if (
        data &&
        data.result === "success" &&
        rates &&
        typeof rates === "object"
      ) {
        return {
          base: String(data.base_code || FX_CROSS).toUpperCase(),
          rates,
          provider: "exchangerate-api",
          source: "live-market",
          asOfDate:
            data.time_last_update_utc ||
            data.time_next_update_utc ||
            new Date().toISOString(),
        };
      }
    } catch (err) {
      const status = err?.response?.status;
      const errType = err?.response?.data?.["error-type"];
      if (!(status === 429 || errType === "quota-reached")) {
        // continue fallback
      }
    }
  }

  // 2) Provider sans clé
  const url2 = `${FX_API_BASE_URL}/latest/${encodeURIComponent(FX_CROSS)}`;
  const { data: data2 } = await axios.get(url2, { timeout: 15000 });

  const rates2 = data2?.rates || data2?.conversion_rates || null;
  if (!rates2 || typeof rates2 !== "object") {
    const e = new Error("Aucune table de taux live disponible");
    e.response = { status: 502, data: data2 };
    throw e;
  }

  return {
    base: String(data2.base_code || data2.base || FX_CROSS).toUpperCase(),
    rates: rates2,
    provider: "open.er-api",
    source: "live-market",
    asOfDate:
      data2.time_last_update_utc ||
      data2.time_last_update_unix ||
      new Date().toISOString(),
  };
}

function computeCrossRateFromTable(fromCur, toCur, crossTable) {
  const rates = crossTable?.rates || null;
  if (!rates) return null;

  const rFrom = safeNum(rates[fromCur], null);
  const rTo = safeNum(rates[toCur], null);

  if (!Number.isFinite(rFrom) || rFrom <= 0) return null;
  if (!Number.isFinite(rTo) || rTo <= 0) return null;

  return rTo / rFrom;
}

async function fetchLiveRate(fromCur, toCur) {
  if (fromCur === toCur) {
    return {
      rate: 1,
      source: "same",
      provider: "same",
      stale: false,
      asOfDate: new Date().toISOString(),
    };
  }

  const pairKey = buildCacheKey("live", fromCur, toCur);
  const cached = pairCache.get(pairKey);
  if (cached) return cached;

  const blocked = getCooldown(pairKey);
  if (blocked) {
    const snap = await getSnapshotFromDb(fromCur, toCur);
    if (snap && isSnapshotFreshEnough(snap)) {
      const out = {
        rate: Number(snap.rate),
        source: snap.source || "db-snapshot",
        provider: snap.provider || "snapshot",
        stale: true,
        asOfDate: snap.asOfDate || snap.updatedAt || null,
        warning: "provider_cooldown_snapshot_fallback",
        retryAfterSec: blocked.retryAfterSec,
      };
      pairCache.set(pairKey, out);
      return out;
    }

    const peg = pegRate(fromCur, toCur);
    if (Number.isFinite(peg) && peg > 0) {
      const out = {
        rate: peg,
        source: "peg-xof-eur",
        provider: "peg",
        stale: true,
        asOfDate: new Date().toISOString(),
      };
      pairCache.set(pairKey, out);
      return out;
    }

    const e = new Error(`FX cooldown (${blocked.retryAfterSec}s)`);
    e.status = 503;
    e.cooldown = blocked;
    throw e;
  }

  try {
    const crossTable = await fetchLiveCrossRates();
    const rate = computeCrossRateFromTable(fromCur, toCur, crossTable);

    if (!Number.isFinite(rate) || rate <= 0) {
      const e = new Error(`Paire non supportée: ${fromCur}/${toCur}`);
      e.status = 404;
      throw e;
    }

    const out = {
      rate,
      source: crossTable.source || "live-market",
      provider: crossTable.provider || "market",
      stale: false,
      asOfDate: crossTable.asOfDate || new Date().toISOString(),
    };

    pairCache.set(pairKey, out);
    await saveSnapshotToDb(fromCur, toCur, out);
    return out;
  } catch (err) {
    const status = err?.response?.status || err?.status || null;
    if (status === 429 || status >= 500) {
      setCooldown(pairKey, err, "live-provider");
    }

    /**
     * ⚠️ `isSnapshotFreshEnough` — LE CONTRÔLE QUI MANQUAIT ICI.
     *
     * La branche de refroidissement, plus haut, vérifie bien la fraîcheur de
     * l'instantané avant de l'appliquer. Celle-ci — le repli sur ERREUR du
     * fournisseur — ne la vérifiait pas : `if (snap)` suffisait.
     *
     * Conséquence : quand le fournisseur tombe, un taux d'âge NON BORNÉ était
     * appliqué à une tarification. Un taux vieux de trois semaines s'applique
     * exactement comme un taux frais — `stale: true` le signale, mais rien ne
     * refuse. C'est la forme que la règle B.2 interdit sur une frontière de
     * change : une donnée financière périmée doit ARRÊTER l'opération, pas la
     * teinter d'un drapeau que personne ne lit.
     *
     * Et c'est le pire moment pour être laxiste : le fournisseur est en panne,
     * donc l'instantané est déjà, par construction, le plus vieux qu'il puisse
     * être.
     *
     * Un instantané périmé n'est plus retenu : on retombe sur l'ancrage
     * (`pegRate`) juste en dessous, puis sur l'échec — dans cet ordre.
     */
    const snap = await getSnapshotFromDb(fromCur, toCur);
    if (snap && isSnapshotFreshEnough(snap)) {
      const out = {
        rate: Number(snap.rate),
        source: snap.source || "db-snapshot",
        provider: snap.provider || "snapshot",
        stale: true,
        asOfDate: snap.asOfDate || snap.updatedAt || null,
        warning: "snapshot_fallback_used",
      };
      pairCache.set(pairKey, out);
      return out;
    }

    const peg = pegRate(fromCur, toCur);
    if (Number.isFinite(peg) && peg > 0) {
      const out = {
        rate: peg,
        source: "peg-xof-eur",
        provider: "peg",
        stale: true,
        asOfDate: new Date().toISOString(),
      };
      pairCache.set(pairKey, out);
      return out;
    }

    const e = new Error("Taux de change live indisponible");
    e.status = err?.status || 503;
    e.debug = {
      fromCur,
      toCur,
      providerStatus: err?.response?.status || null,
      providerMessage: err?.message || String(err),
    };
    throw e;
  }
}

/* =========================================================
 * Public service API
 * ========================================================= */

/**
 * ✅ Par défaut = marché réel
 * Donc ton pricing et ton admin peuvent utiliser ça
 */
async function getExchangeRate(from, to, opts = {}) {
  const fromCur = normCcy(from);
  const toCur = normCcy(to);

  /**
   * ⚠️ ÉCHEC EN FERMETURE — CE BLOC RENDAIT `rate: 1`.
   *
   * Une devise illisible produisait un taux de change de **1 pour 1**. Sur une
   * frontière de change, c'est la pire valeur de repli imaginable : elle est
   * plausible (beaucoup de paires valent à peu près 1), elle ne lève aucune
   * alerte, et elle convertit un montant en le laissant tel quel. Une
   * tarification en sortait avec un prix faux et l'air parfaitement normal.
   *
   * `source: "invalid"` était censé le dire — mais aucun appelant ne lit ce
   * champ : `pricingController.getMarketRateDirect` ne regarde que `out.rate`,
   * et 1 est un nombre fini parfaitement acceptable.
   *
   * La règle B.2 est explicite : une donnée financière illisible ARRÊTE
   * l'opération avec une erreur explicite ; elle ne prend jamais de valeur par
   * défaut. On lève donc, avec un code nommé pour que l'appelant sache quoi
   * répondre.
   */
  /**
   * ⚠️ ON VALIDE LA FORME, ON NE FAIT PAS CONFIANCE AU NORMALISATEUR.
   *
   * Ce contrôle testait seulement « la normalisation a-t-elle rendu quelque
   * chose ». Il tenait parce que le normalisateur de l'API Gateway retirait les
   * caractères non alphabétiques : `"??"` en ressortait vide, donc refusé.
   *
   * Celui de Tx-Core rend `"??"` tel quel. Au déplacement du service
   * (2026-09-10), le garde a donc cessé de mordre sur les codes illisibles —
   * une régression silencieuse d'un contrôle de fermeture, attrapée par
   * `test/fx/failClosed.test.js`, qui a suivi le service.
   *
   * Le correctif ne consiste PAS à emmener une quatrième normalisation de
   * devise dans ce dépôt — il en compte déjà trois qui ont divergé par le
   * passé, et c'est documenté en tête de `utils/currency.js`. Il consiste à
   * vérifier ici ce que le service exige réellement : un code ISO, trois ou
   * quatre LETTRES. C'est plus strict que les deux normalisateurs, et cela ne
   * dépend plus de celui qui est branché.
   */
  const CODE_ISO = /^[A-Z]{3,4}$/;

  if (!CODE_ISO.test(String(fromCur)) || !CODE_ISO.test(String(toCur))) {
    const err = new Error(
      `Devise illisible pour la conversion : from="${from}" to="${to}". ` +
        "Aucun taux n'est appliqué — un repli à 1 pour 1 produirait un prix faux " +
        "sans que rien ne le signale."
    );
    err.code = "FX_INVALID_CURRENCY";
    err.status = 400;
    throw err;
  }

  const mode = String(opts.mode || "live").trim().toLowerCase();

  if (mode === "effective") {
    const custom = await getCustomActiveRate(fromCur, toCur);
    if (custom) return custom;
  }

  return fetchLiveRate(fromCur, toCur);
}

/**
 * ✅ Variante explicite si un autre module veut vraiment le custom actif d’abord
 */
async function getEffectiveExchangeRate(from, to, opts = {}) {
  return getExchangeRate(from, to, { ...opts, mode: "effective" });
}

/**
 * ✅ Liste des devises supportées par le marché réel
 */
async function getSupportedCurrencies() {
  const cacheKey = "supported-currencies";
  const cached = pairCache.get(cacheKey);
  if (cached) return cached;

  const crossTable = await fetchLiveCrossRates();
  const codes = Object.keys(crossTable?.rates || {})
    .map((x) => normCcy(x))
    .filter(Boolean);

  const all = Array.from(new Set([crossTable.base, ...codes])).sort();

  const out = {
    base: crossTable.base,
    currencies: all,
    source: crossTable.source || "live-market",
    provider: crossTable.provider || "market",
    asOfDate: crossTable.asOfDate || new Date().toISOString(),
  };

  pairCache.set(cacheKey, out, { ttl: FX_CACHE_TTL_MS });
  return out;
}

module.exports = {
  getExchangeRate,
  getEffectiveExchangeRate,
  getSupportedCurrencies,
};