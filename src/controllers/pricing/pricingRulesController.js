"use strict";

/**
 * Barèmes — administration — déplacé depuis l'API Gateway le 2026-09-10.
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

const modelePricingRule = () => getPricingModel("PricingRule");
const modelePricingRuleVersion = () => getPricingModel("PricingRuleVersion");
const modeleCoverageGap = () => getPricingModel("PricingCoverageGap");

const mongoose = require("mongoose");
const { getExchangeRate } = require("../../services/pricing/exchangeRateService");

function toBool(v, defaultValue = undefined) {
  if (v === undefined || v === null || v === "") return defaultValue;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(s)) return true;
  if (["false", "0", "no", "n", "off"].includes(s)) return false;
  return defaultValue;
}

/**
 * ✅ Preview basé sur le vrai marché réel
 */
async function buildFxPreview(item) {
  try {
    const from = item?.scope?.fromCurrency;
    const to = item?.scope?.toCurrency;

    if (!from || !to) {
      return {
        marketRate: null,
        clientRate: null,
        inverseMarketRate: null,
        inverseClientRate: null,
        source: null,
        provider: null,
        fxMode: String(item?.fx?.mode || "PASS_THROUGH").toUpperCase(),
      };
    }

    const live = await getExchangeRate(from, to, { mode: "live" });
    const marketRate = Number(live?.rate);
    const source = live?.source || null;
    const provider = live?.provider || null;

    if (!Number.isFinite(marketRate) || marketRate <= 0) {
      return {
        marketRate: null,
        clientRate: null,
        inverseMarketRate: null,
        inverseClientRate: null,
        source,
        provider,
        fxMode: String(item?.fx?.mode || "PASS_THROUGH").toUpperCase(),
      };
    }

    const mode = String(item?.fx?.mode || "PASS_THROUGH").toUpperCase();
    let clientRate = marketRate;

    if (mode === "OVERRIDE") {
      const out = Number(item?.fx?.overrideRate);
      if (Number.isFinite(out) && out > 0) clientRate = out;
    } else if (mode === "MARKUP_PERCENT") {
      const pct = Number(item?.fx?.markupPercent || 0);
      clientRate = marketRate * (1 - pct / 100);
    } else if (mode === "DELTA_PERCENT") {
      const pct = Number(item?.fx?.percent || 0);
      clientRate = marketRate * (1 + pct / 100);
    } else if (mode === "DELTA_ABS") {
      clientRate = marketRate + Number(item?.fx?.deltaAbs || 0);
    }

    if (!Number.isFinite(clientRate) || clientRate <= 0) {
      clientRate = null;
    }

    return {
      marketRate,
      clientRate,
      inverseMarketRate: Number.isFinite(marketRate) && marketRate > 0 ? 1 / marketRate : null,
      inverseClientRate: Number.isFinite(clientRate) && clientRate > 0 ? 1 / clientRate : null,
      source,
      provider,
      stale: !!live?.stale,
      asOfDate: live?.asOfDate || null,
      fxMode: mode,
      markupPercent: Number(item?.fx?.markupPercent || 0),
      percent: Number(item?.fx?.percent || 0),
      deltaAbs: Number(item?.fx?.deltaAbs || 0),
      overrideRate: item?.fx?.overrideRate ?? null,
    };
  } catch {
    return {
      marketRate: null,
      clientRate: null,
      inverseMarketRate: null,
      inverseClientRate: null,
      source: null,
      provider: null,
      fxMode: String(item?.fx?.mode || "PASS_THROUGH").toUpperCase(),
    };
  }
}

exports.listPricingRules = async (req, res) => {
  try {
    const {
      q,
      active,
      txType,
      method,
      provider,
      country,
      fromCountry,
      toCountry,
      fromCurrency,
      toCurrency,
      feeMode,
      fxMode,
      page = 1,
      limit = 50,
      sortBy = "priority",
      sortOrder = "desc",
    } = req.query;

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const skip = (safePage - 1) * safeLimit;

    const filter = {};

    // Une règle archivée reste en base — elle ne disparaît plus jamais — mais
    // n'encombre pas la liste de travail.
    if (String(req.query.includeArchived ?? "") !== "true") {
      filter.archivedAt = null;
    }

    if (q && String(q).trim()) {
      const regex = new RegExp(String(q).trim(), "i");
      filter.$or = [
        { name: regex },
        { code: regex },
        { description: regex },
        { notes: regex },
        { "scope.provider": regex },
        { "fx.notes": regex },
      ];
    }

    const parsedActive = toBool(active, undefined);
    if (parsedActive !== undefined) filter.active = parsedActive;

    if (txType) filter["scope.txType"] = String(txType).trim().toUpperCase();
    if (method) filter["scope.method"] = String(method).trim().toUpperCase();
    if (provider) filter["scope.provider"] = String(provider).trim().toLowerCase();
    if (country) filter["scope.country"] = String(country).trim().toUpperCase();
    if (fromCountry) filter["scope.fromCountry"] = String(fromCountry).trim().toUpperCase();
    if (toCountry) filter["scope.toCountry"] = String(toCountry).trim().toUpperCase();
    if (fromCurrency) filter["scope.fromCurrency"] = String(fromCurrency).trim().toUpperCase();
    if (toCurrency) filter["scope.toCurrency"] = String(toCurrency).trim().toUpperCase();
    if (feeMode) filter["fee.mode"] = String(feeMode).trim().toUpperCase();
    if (fxMode) filter["fx.mode"] = String(fxMode).trim().toUpperCase();

    const allowedSortFields = new Set(["createdAt", "updatedAt", "name", "priority", "active"]);
    const sortField = allowedSortFields.has(String(sortBy)) ? String(sortBy) : "priority";
    const sortDir = String(sortOrder).toLowerCase() === "asc" ? 1 : -1;

    const [itemsRaw, total] = await Promise.all([
      modelePricingRule().find(filter)
        .sort({ [sortField]: sortDir, updatedAt: -1, _id: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      modelePricingRule().countDocuments(filter),
    ]);

    const items = await Promise.all(
      itemsRaw.map(async (item) => ({
        ...item,
        fxPreview: await buildFxPreview(item),
      }))
    );

    return res.status(200).json({
      success: true,
      data: items,
      total,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        pages: Math.ceil(total / safeLimit),
      },
    });
  } catch (error) {
    console.error("[pricingRules.list] error:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération des règles de pricing",
      error: error.message,
    });
  }
};

exports.getPricingRuleById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID invalide",
      });
    }

    const item = await modelePricingRule().findById(id).lean();

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Règle introuvable",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        ...item,
        fxPreview: await buildFxPreview(item),
      },
    });
  } catch (error) {
    console.error("[pricingRules.getById] error:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération de la règle",
      error: error.message,
    });
  }
};

/**
 * GET /pricing-rules/:id/versions
 *
 * Le journal d'un prix. Ces documents sont immuables : ils constituent la seule
 * source de vérité sur qui a changé quoi, et quand.
 */
exports.listPricingRuleVersions = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "ID invalide" });
    }

    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const items = await modelePricingRuleVersion().find({ ruleId: id })
      .sort({ versionNumber: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({ success: true, data: items, total: items.length });
  } catch (error) {
    console.error("[pricingRules.versions] error:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la lecture du journal de la règle",
    });
  }
};

/**
 * GET /pricing-rules/coverage-gaps?days=30&includeResolved=false
 *
 * Les corridors demandés sans règle applicable. Faits constatés, pas matrice
 * supposée : chaque ligne correspond à un échec réel du moteur.
 */
exports.listCoverageGaps = async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const filter = { lastSeenAt: { $gte: since } };
    if (String(req.query.includeResolved ?? "") !== "true") {
      filter.resolvedAt = null;
    }

    const items = await modeleCoverageGap().find(filter)
      .sort({ occurrences: -1, lastSeenAt: -1 })
      .limit(200)
      .lean();

    const totalOccurrences = items.reduce(
      (sum, item) => sum + Number(item.occurrences || 0),
      0
    );

    return res.status(200).json({
      success: true,
      data: items,
      total: items.length,
      totalOccurrences,
      days,
    });
  } catch (error) {
    console.error("[pricingRules.coverageGaps] error:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la lecture des corridors non couverts",
    });
  }
};
