"use strict";

/**
 * Taux de change — administration — déplacé depuis l'API Gateway le 2026-09-10.
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────────
 *
 * La passerelle possédait le domaine des prix : huit modèles Mongoose, sa
 * propre base, et le moteur de devis que Tx-Core venait interroger EN HTTP. La
 * dépendance remontait donc du moteur d'argent vers le bord — une panne de la
 * passerelle arrêtait les virements de l'intérieur, et la base des barèmes
 * vivait sur la surface la plus exposée d'Internet.
 *
 * Stripe, PayPal et Adyen tiennent tous la même règle : les dépendances
 * DESCENDENT, et le bord ne possède aucun domaine. La passerelle relaie
 * désormais ces routes ; le domaine vit ici.
 *
 * ── Modèles résolus à l'appel ───────────────────────────────────────────────
 *
 * Les `require` de modèle en tête de fichier fonctionnaient parce que la
 * passerelle liait ses modèles à la connexion Mongoose GLOBALE. Tx-Core ouvre
 * des connexions NOMMÉES, dont aucune n'existe au chargement du module : un
 * modèle résolu trop tôt s'attacherait à la mauvaise base en silence, et lirait
 * une collection vide au lieu d'échouer.
 */
const { getPricingModel } = require("../../config/db");

const modeleExchangeRate = () => getPricingModel("ExchangeRate");

const {
  getExchangeRate,
  getSupportedCurrencies,
} = require("../../services/pricing/exchangeRateService");
const logger = require("../../logger");

/* =========================================================
 * Admin CRUD custom rates
 * ========================================================= */

/**
 * GET /api/v1/exchange-rates
 * Liste admin des taux enregistrés en DB
 */
exports.list = async (req, res) => {
  try {
    const query = {};
    if (req.query.from) query.from = String(req.query.from).toUpperCase();
    if (req.query.to) query.to = String(req.query.to).toUpperCase();
    if (req.query.active !== undefined) query.active = req.query.active === "true";

    const rates = await modeleExchangeRate().find(query)
      .sort({ updatedAt: -1 })
      .limit(300)
      .lean();

    return res.json({ success: true, data: rates });
  } catch (e) {
    logger.error("[FX] list error", { error: e.message });
    return res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * POST /api/v1/exchange-rates
 * Crée un taux custom admin (active:true)
 */
exports.create = async (req, res) => {
  try {
    const { from, to, rate } = req.body;

    if (!from || !to || rate === undefined) {
      return res.status(400).json({
        success: false,
        message: "Champs from, to, rate requis",
      });
    }

    const fromCur = String(from).trim().toUpperCase();
    const toCur = String(to).trim().toUpperCase();
    const nRate = Number(rate);

    if (!Number.isFinite(nRate) || nRate <= 0) {
      return res.status(400).json({
        success: false,
        message: "rate invalide",
      });
    }

    await modeleExchangeRate().updateMany(
      { from: fromCur, to: toCur, active: true },
      { $set: { active: false, updatedAt: new Date() } }
    );

    const newRate = new ExchangeRate({
      from: fromCur,
      to: toCur,
      rate: nRate,
      updatedBy: req.user?.email || null,
      active: true,
      source: "db-custom",
      provider: "admin",
      asOfDate: new Date(),
      stale: false,
    });

    await newRate.save();

    logger.info("[FX] custom rate created", {
      from: fromCur,
      to: toCur,
      rate: nRate,
      id: newRate._id,
    });

    return res.status(201).json({ success: true, data: newRate });
  } catch (e) {
    logger.error("[FX] create error", { error: e.message });
    return res.status(400).json({ success: false, message: e.message });
  }
};

/**
 * PUT /api/v1/exchange-rates/:id
 */
exports.update = async (req, res) => {
  try {
    const { rate, active } = req.body;
    const update = {
      updatedAt: new Date(),
      updatedBy: req.user?.email || null,
    };

    if (rate !== undefined) {
      const nRate = Number(rate);
      if (!Number.isFinite(nRate) || nRate <= 0) {
        return res.status(400).json({
          success: false,
          message: "rate invalide",
        });
      }
      update.rate = nRate;
    }

    if (active !== undefined) update.active = !!active;

    const doc = await modeleExchangeRate().findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Taux introuvable",
      });
    }

    logger.info("[FX] custom rate updated", {
      id: doc._id,
      rate: doc.rate,
      active: doc.active,
    });

    return res.json({ success: true, data: doc });
  } catch (e) {
    logger.error("[FX] update error", { error: e.message });
    return res.status(400).json({ success: false, message: e.message });
  }
};

/**
 * DELETE /api/v1/exchange-rates/:id
 */
exports.remove = async (req, res) => {
  try {
    const doc = await modeleExchangeRate().findByIdAndDelete(req.params.id);

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Taux introuvable",
      });
    }

    logger.info("[FX] custom rate removed", {
      id: doc._id,
      from: doc.from,
      to: doc.to,
    });

    return res.json({ success: true, message: "Taux supprimé" });
  } catch (e) {
    logger.error("[FX] remove error", { error: e.message });
    return res.status(500).json({ success: false, message: e.message });
  }
};

/* =========================================================
 * Public / admin market endpoints
 * ========================================================= */

/**
 * GET /api/v1/exchange-rates/rate?from=XOF&to=EUR&mode=live
 *
 * mode:
 * - live (default)     => vrai marché
 * - effective          => custom actif si dispo, sinon live
 */
exports.getRatePublic = async (req, res) => {
  const { from, to } = req.query;
  const mode = String(req.query.mode || "live").trim().toLowerCase();

  /**
   * ⚠️ ROUTE PUBLIQUE : LE TAUX DU MARCHÉ, ET RIEN D'AUTRE (2026-09-16).
   *
   * `mode=effective` servait le « taux personnalisé » hérité de la collection
   * `ExchangeRate` — un taux qu'aucun devis n'applique (écriture en 410 depuis
   * ce matin) — sous l'étiquette `marketRate`. Un visiteur pouvait donc lire,
   * présenté comme taux du marché, un chiffre qui n'est ni le marché ni le prix
   * PayNoval. Aucun client ne l'utilisait. Refusé nommément plutôt qu'ignoré :
   * rendre silencieusement le mode `live` à qui demande `effective` serait un
   * repli qui ment sur ce qu'il sert.
   */
  if (mode !== "live") {
    return res.status(400).json({
      success: false,
      code: "FX_MODE_UNSUPPORTED",
      message: "Seul le taux du marché (mode=live) est publié.",
    });
  }

  if (!from || !to) {
    return res.status(400).json({
      success: false,
      message: "from et to obligatoires",
    });
  }

  try {
    logger.info("[FX] /exchange-rates/rate called", {
      from,
      to,
      mode,
    });

    const fx = await getExchangeRate(from, to, { mode: "live" });

    const rate = Number(fx?.rate);

    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(503).json({
        success: false,
        message: "Taux de change indisponible",
      });
    }

    const fromUp = String(from).toUpperCase();
    const toUp = String(to).toUpperCase();
    const inverseRate = 1 / rate;

    return res.json({
      success: true,

      // root fields
      fromCurrency: fromUp,
      toCurrency: toUp,
      marketRate: rate,
      inverseMarketRate: inverseRate,
      rate,
      inverseRate,

      source: fx?.source || "live-market",
      provider: fx?.provider || null,
      stale: !!fx?.stale,
      asOfDate: fx?.asOfDate || null,
      mode,

      data: {
        from: fromUp,
        to: toUp,
        fromCurrency: fromUp,
        toCurrency: toUp,
        rate,
        marketRate: rate,
        inverseRate,
        inverseMarketRate: inverseRate,
        source: fx?.source || "live-market",
        provider: fx?.provider || null,
        stale: !!fx?.stale,
        asOfDate: fx?.asOfDate || null,
        mode,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    logger.error("[FX] /exchange-rates/rate error", {
      from,
      to,
      mode,
      error: e?.message,
      debug: e?.debug,
    });

    if (e?.cooldown?.retryAfterSec) {
      res.setHeader("Retry-After", String(e.cooldown.retryAfterSec));
    }

    const status = e?.status || 500;

    // Route publique : un 5xx ne renvoie ni le message interne ni `debug`
    // (statut et message du fournisseur de change).
    return res.status(status).json({
      success: false,
      code: e?.code || null,
      message: status >= 500 ? "Taux de change indisponible" : e?.message,
    });
  }
};

/**
 * GET /api/v1/exchange-rates/supported-currencies
 * Liste toutes les devises dispo côté marché réel
 */
exports.getSupportedCurrenciesPublic = async (_req, res) => {
  try {
    const out = await getSupportedCurrencies();

    return res.json({
      success: true,
      base: out.base,
      currencies: out.currencies,
      source: out.source,
      provider: out.provider,
      asOfDate: out.asOfDate,
      data: out,
    });
  } catch (e) {
    logger.error("[FX] /exchange-rates/supported-currencies error", {
      error: e?.message,
    });

    return res.status(e?.status || 500).json({
      success: false,
      message: e?.message || "Impossible de charger les devises supportées",
    });
  }
};

/* ==========================================================================
 * ADMINISTRATION DES TAUX
 * ==========================================================================
 *
 * Ces quatre handlers vivaient EN LIGNE dans `routes/admin/exchangeRates.routes.js`
 * côté passerelle — un fichier de route qui appelait directement le modèle.
 * En les déplaçant, on les sort de la route : une route déclare des chemins et
 * des gardes, elle ne parle pas à la base. C'est la convention annoncée du
 * dépôt (`routes → controllers → services → models`), que ce fichier-ci
 * enfreignait.
 */

async function listRates(req, res) {
  try {
    const filter = {};
    if (req.query.from) filter.from = String(req.query.from).toUpperCase();
    if (req.query.to) filter.to = String(req.query.to).toUpperCase();
    if (req.query.active !== undefined) filter.active = req.query.active === "true";

    const rates = await modeleExchangeRate().find(filter).sort({ updatedAt: -1 });
    return res.json({ success: true, data: rates });
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, message: e.message || "Erreur serveur." });
  }
}

async function createRate(req, res) {
  try {
    const rate = await modeleExchangeRate().create(req.body);
    return res.json({ success: true, data: rate });
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message });
  }
}

async function updateRate(req, res) {
  try {
    const rate = await modeleExchangeRate().findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    if (!rate) {
      return res.status(404).json({ success: false, message: "Taux introuvable" });
    }

    return res.json({ success: true, data: rate });
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message });
  }
}

async function deleteRate(req, res) {
  try {
    const deleted = await modeleExchangeRate().findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ success: false, message: "Taux introuvable" });
    }

    return res.json({ success: true });
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message });
  }
}

module.exports.listRates = listRates;
module.exports.createRate = createRate;
module.exports.updateRate = updateRate;
module.exports.deleteRate = deleteRate;
