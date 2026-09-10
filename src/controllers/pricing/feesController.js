"use strict";

/**
 * Frais — administration et simulation — déplacé depuis l'API Gateway le 2026-09-10.
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

const modeleFee = () => getPricingModel("Fee");

const { getExchangeRate } = require("../../services/pricing/exchangeRateService");
const { normalizeCurrency } = require("../../utils/currency");

// Adaptateur : une seule vérité de prix, celle du moteur de tarification.
// `roundMoney` n'est pas importé : ce fichier a déjà le sien, identique.
const { computeQuote } = require("../../services/pricing/pricingEngine");
const { getActiveRules } = require("../../services/pricing/ruleCache");
const { recordCoverageGap } = require("../../services/pricing/coverage");

let logger = null;
try {
  logger = require("../../logger");
} catch (e) {
  logger = console;
}

function decimalsForCurrency(code) {
  const c = String(code || "").toUpperCase();
  if (c === "XOF" || c === "XAF" || c === "JPY") return 0;
  return 2;
}

function roundMoney(amount, currency) {
  const d = decimalsForCurrency(currency);
  const p = 10 ** d;
  return Math.round((Number(amount) + Number.EPSILON) * p) / p;
}

const normStr = (v) => String(v ?? "").trim();
const upper = (v) => normStr(v).toUpperCase();
const lower = (v) => normStr(v).toLowerCase();

function normalizeTxType(v) {
  const raw = upper(v);
  if (!raw || raw === "ALL") return "";

  if (["TRANSFER", "DEPOSIT", "WITHDRAW"].includes(raw)) return raw;

  const low = lower(v);
  if (["transfer", "transfert", "send"].includes(low)) return "TRANSFER";
  if (["deposit", "cashin", "topup"].includes(low)) return "DEPOSIT";
  if (["withdraw", "withdrawal", "cashout", "retrait"].includes(low)) return "WITHDRAW";

  return raw;
}

function normalizeMethod(v) {
  const raw = upper(v);
  if (!raw || raw === "ALL") return "";

  if (["MOBILEMONEY", "BANK", "CARD", "INTERNAL"].includes(raw)) return raw;

  const low = lower(v);
  if (["mobilemoney", "mobile_money", "mm"].includes(low)) return "MOBILEMONEY";
  if (["bank", "wire", "virement"].includes(low)) return "BANK";
  if (["card", "visa", "mastercard"].includes(low)) return "CARD";
  if (["internal", "wallet", "paynoval"].includes(low)) return "INTERNAL";

  return raw;
}

function normalizeFeeType(v) {
  const t = lower(v || "");
  if (!t || t === "all") return "";
  if (["fixed", "forfait", "fixe"].includes(t)) return "fixed";
  if (["percent", "percentage", "pourcentage"].includes(t)) return "percent";
  if (["mixed", "mixte", "hybrid", "hybride"].includes(t)) return "mixed";
  return t;
}

function normalizeScopeLower(v) {
  const s = lower(v || "");
  if (!s || s === "all" || s === "*") return "";
  return s;
}

function toBool(v, defaultValue = undefined) {
  if (v === undefined || v === null || v === "") return defaultValue;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(s)) return true;
  if (["false", "0", "no", "n", "off"].includes(s)) return false;
  return defaultValue;
}

function toNumber(v, defaultValue = undefined) {
  if (v === undefined || v === null || v === "") return defaultValue;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : defaultValue;
}

function safeDateMs(v) {
  const ts = new Date(v).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function computeFeeFromBareme(feeDoc, amountNum, feeCurrency) {
  if (!feeDoc) return { fee: 0, feePercent: 0, breakdown: null };

  const feeType = normalizeFeeType(feeDoc.type);
  const baseAmount = Number(feeDoc.amount || 0);
  const extraPercent = Number(feeDoc.extraPercent || 0);
  const extraFixed = Number(feeDoc.extraFixed || 0);

  let feeValue = 0;
  let feePercent = 0;

  if (feeType === "fixed") {
    feeValue = baseAmount + extraFixed;
    feePercent = 0;
  } else if (feeType === "percent") {
    feePercent = baseAmount + extraPercent;

    let rawFee = (amountNum * baseAmount) / 100;
    rawFee += (amountNum * extraPercent) / 100;
    rawFee += extraFixed;

    if (typeof feeDoc.minFee === "number") rawFee = Math.max(rawFee, feeDoc.minFee);
    if (typeof feeDoc.maxFee === "number") rawFee = Math.min(rawFee, feeDoc.maxFee);

    feeValue = rawFee;
  } else if (feeType === "mixed") {
    const fixedPart = Number(feeDoc.fixedAmount ?? 0);

    feePercent = baseAmount + extraPercent;

    let rawFee = (amountNum * baseAmount) / 100;
    rawFee += (amountNum * extraPercent) / 100;
    rawFee += fixedPart + extraFixed;

    if (typeof feeDoc.minFee === "number") rawFee = Math.max(rawFee, feeDoc.minFee);
    if (typeof feeDoc.maxFee === "number") rawFee = Math.min(rawFee, feeDoc.maxFee);

    feeValue = rawFee;
  }

  if (!Number.isFinite(feeValue) || feeValue < 0) feeValue = 0;
  feeValue = roundMoney(feeValue, feeCurrency);

  return {
    fee: feeValue,
    feePercent,
    breakdown: {
      feeId: feeDoc._id,
      name: feeDoc.name || "",
      slug: feeDoc.slug || "",
      txType: feeDoc.txType || "",
      method: feeDoc.method || "",
      provider: feeDoc.provider || "",
      country: feeDoc.country || "",
      toCountry: feeDoc.toCountry || "",
      currency: feeDoc.currency || "",
      toCurrency: feeDoc.toCurrency || "",
      type: feeType,
      baseAmount,
      fixedAmount: Number(feeDoc.fixedAmount ?? 0),
      extraPercent,
      extraFixed,
      minFee: feeDoc.minFee ?? null,
      maxFee: feeDoc.maxFee ?? null,
      minAmount: feeDoc.minAmount ?? 0,
      maxAmount: feeDoc.maxAmount ?? null,
      priority: feeDoc.priority ?? 0,
      formula:
        feeType === "fixed"
          ? `fixed(${baseAmount}) + extraFixed(${extraFixed})`
          : feeType === "percent"
          ? `(${amountNum} * (${baseAmount}% + ${extraPercent}%)) + ${extraFixed}`
          : `(${amountNum} * (${baseAmount}% + ${extraPercent}%)) + fixed(${Number(
              feeDoc.fixedAmount ?? 0
            )}) + extraFixed(${extraFixed})`,
    },
  };
}

function buildFeeMatchQuery({
  txType = "",
  method = "",
  provider = "",
  country = "",
  toCountry = "",
  currency = "",
  toCurrency = "",
  amountNum = 0,
}) {
  const query = {
    active: true,
    currency,
    minAmount: { $lte: amountNum },
    $and: [
      {
        $or: [
          { maxAmount: { $gte: amountNum } },
          { maxAmount: null },
          { maxAmount: { $exists: false } },
        ],
      },
    ],
  };

  query.$and.push({ $or: [{ txType }, { txType: "" }] });
  query.$and.push({ $or: [{ method }, { method: "" }] });
  query.$and.push({ $or: [{ provider }, { provider: "" }] });
  query.$and.push({ $or: [{ country }, { country: "" }] });
  query.$and.push({ $or: [{ toCountry }, { toCountry: "" }] });
  query.$and.push({ $or: [{ toCurrency }, { toCurrency: "" }] });

  return query;
}

function computeSpecificityScore(feeDoc, ctx) {
  let score = 0;

  if (feeDoc.txType && feeDoc.txType === ctx.txType) score += 50;
  if (feeDoc.method && feeDoc.method === ctx.method) score += 40;
  if (feeDoc.provider && feeDoc.provider === ctx.provider) score += 35;
  if (feeDoc.country && feeDoc.country === ctx.country) score += 30;
  if (feeDoc.toCountry && feeDoc.toCountry === ctx.toCountry) score += 30;
  if (feeDoc.currency && feeDoc.currency === ctx.currency) score += 25;
  if (feeDoc.toCurrency && feeDoc.toCurrency === ctx.toCurrency) score += 25;

  if (feeDoc.minAmount != null) score += 5;
  if (feeDoc.maxAmount != null) score += 5;

  return score;
}

async function pickBestFeeRule(ctx) {
  const query = buildFeeMatchQuery(ctx);
  const candidates = await modeleFee().find(query).lean();
  if (!candidates.length) return null;

  const ranked = candidates
    .map((doc) => ({
      doc,
      specificity: computeSpecificityScore(doc, ctx),
      priority: Number(doc.priority || 0),
      minAmount: Number(doc.minAmount || 0),
      updatedAt: safeDateMs(doc.updatedAt),
    }))
    .sort((a, b) => {
      if (b.specificity !== a.specificity) return b.specificity - a.specificity;
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (b.minAmount !== a.minAmount) return b.minAmount - a.minAmount;
      return b.updatedAt - a.updatedAt;
    });

  return ranked[0]?.doc || null;
}

exports.getFees = async (req, res) => {
  try {
    const query = {};

    if (req.query.q && String(req.query.q).trim()) {
      const regex = new RegExp(String(req.query.q).trim(), "i");
      query.$or = [
        { name: regex },
        { description: regex },
        { provider: regex },
        { country: regex },
        { toCountry: regex },
        { currency: regex },
        { toCurrency: regex },
      ];
    }

    if (req.query.txType) query.txType = normalizeTxType(req.query.txType);
    if (req.query.method) query.method = normalizeMethod(req.query.method);
    if (req.query.provider !== undefined) query.provider = normalizeScopeLower(req.query.provider);
    if (req.query.country !== undefined) query.country = normalizeScopeLower(req.query.country);
    if (req.query.toCountry !== undefined) query.toCountry = normalizeScopeLower(req.query.toCountry);
    if (req.query.currency !== undefined) query.currency = upper(req.query.currency);
    if (req.query.toCurrency !== undefined) query.toCurrency = upper(req.query.toCurrency);
    if (req.query.type !== undefined) query.type = normalizeFeeType(req.query.type);

    const activeParsed = toBool(req.query.active, undefined);
    if (activeParsed !== undefined) query.active = activeParsed;

    if (req.query.minAmount !== undefined && req.query.minAmount !== "") {
      query.minAmount = { $gte: Number(req.query.minAmount) };
    }

    if (req.query.maxAmount !== undefined && req.query.maxAmount !== "") {
      query.maxAmount = {
        ...(query.maxAmount || {}),
        $lte: Number(req.query.maxAmount),
      };
    }

    const limit = parseInt(req.query.limit, 10) || 100;
    const skip = parseInt(req.query.skip, 10) || 0;

    const [fees, total] = await Promise.all([
      modeleFee().find(query).sort({ priority: -1, updatedAt: -1 }).skip(skip).limit(limit),
      modeleFee().countDocuments(query),
    ]);

    res.json({ success: true, data: fees, total });
  } catch (e) {
    logger.error?.("[Fees] getFees error", e);
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.getFeeById = async (req, res) => {
  try {
    const fee = await modeleFee().findById(req.params.id);
    if (!fee) {
      return res.status(404).json({ success: false, message: "Fee introuvable" });
    }
    res.json({ success: true, data: fee });
  } catch (e) {
    logger.error?.("[Fees] getFeeById error", e);
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.createFee = async (req, res) => {
  try {
    const payload = {
      ...req.body,
      txType: normalizeTxType(req.body.txType || ""),
      method: normalizeMethod(req.body.method || ""),
      provider: normalizeScopeLower(req.body.provider || ""),
      country: normalizeScopeLower(req.body.country || ""),
      toCountry: normalizeScopeLower(req.body.toCountry || ""),
      currency: upper(req.body.currency || "XOF"),
      toCurrency: upper(req.body.toCurrency || ""),
      type: normalizeFeeType(req.body.type || ""),
      fixedAmount: toNumber(req.body.fixedAmount, 0),
    };

    const fee = new Fee(payload);
    await fee.save();

    res.status(201).json({ success: true, data: fee });
  } catch (e) {
    logger.error?.("[Fees] createFee error", e);
    res.status(400).json({ success: false, message: e.message });
  }
};

exports.updateFee = async (req, res) => {
  try {
    const payload = {
      ...req.body,
    };

    if (payload.txType !== undefined) payload.txType = normalizeTxType(payload.txType || "");
    if (payload.method !== undefined) payload.method = normalizeMethod(payload.method || "");
    if (payload.provider !== undefined) payload.provider = normalizeScopeLower(payload.provider || "");
    if (payload.country !== undefined) payload.country = normalizeScopeLower(payload.country || "");
    if (payload.toCountry !== undefined) payload.toCountry = normalizeScopeLower(payload.toCountry || "");
    if (payload.currency !== undefined) payload.currency = upper(payload.currency || "XOF");
    if (payload.toCurrency !== undefined) payload.toCurrency = upper(payload.toCurrency || "");
    if (payload.type !== undefined) payload.type = normalizeFeeType(payload.type || "");
    if (payload.fixedAmount !== undefined) payload.fixedAmount = toNumber(payload.fixedAmount, 0);

    const fee = await modeleFee().findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });

    if (!fee) {
      return res.status(404).json({ success: false, message: "Fee introuvable" });
    }

    res.json({ success: true, data: fee });
  } catch (e) {
    logger.error?.("[Fees] updateFee error", e);
    res.status(400).json({ success: false, message: e.message });
  }
};

exports.deleteFee = async (req, res) => {
  try {
    const fee = await modeleFee().findByIdAndDelete(req.params.id);
    if (!fee) {
      return res.status(404).json({ success: false, message: "Fee introuvable" });
    }
    res.json({ success: true, message: "Fee supprimée" });
  } catch (e) {
    logger.error?.("[Fees] deleteFee error", e);
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.simulateFee = async (req, res) => {
  try {
    let {
      type = "",
      txType = "",
      method = "",
      provider = "",
      amount,
      fromCurrency,
      toCurrency,
      currency,
      country = "",
      toCountry = "",
    } = req.query;

    const normalizedTxType = normalizeTxType(txType || type || "");
    const normalizedMethod = normalizeMethod(method || "");
    const normalizedProvider = normalizeScopeLower(provider || "");
    const normalizedCountry = normalizeScopeLower(country || "");
    const normalizedToCountry = normalizeScopeLower(toCountry || "");

    const fromCur = normalizeCurrency(fromCurrency || currency || "");
    const toCur = normalizeCurrency(toCurrency || fromCur || "");

    if (!amount || !fromCur) {
      return res.status(400).json({
        success: false,
        message: "Paramètres requis : amount, currency/fromCurrency",
      });
    }

    const amountNum = toNumber(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({
        success: false,
        message: "Montant invalide",
      });
    }

    const ctx = {
      txType: normalizedTxType,
      method: normalizedMethod,
      provider: normalizedProvider,
      country: normalizedCountry,
      toCountry: normalizedToCountry,
      currency: fromCur,
      toCurrency: toCur,
      amountNum,
    };

    if (lower(type) === "cancellation") {
      const match = await pickBestFeeRule({
        ...ctx,
        txType: "",
        method: "",
      });

      let feeValue = 0;
      let feeType = "fixed";
      let feeId = null;
      let usedBareme = null;
      let feeBreakdown = null;

      if (match) {
        const resFee = computeFeeFromBareme(match, amountNum, fromCur);
        feeValue = resFee.fee;
        feeType = normalizeFeeType(match.type);
        feeId = match._id;
        usedBareme = match;
        feeBreakdown = resFee.breakdown;

        await modeleFee().updateOne({ _id: match._id }, { $set: { lastUsedAt: new Date() } });
      } else {
        if (["USD", "CAD", "EUR"].includes(fromCur)) feeValue = 2.99;
        else if (["XOF", "XAF"].includes(fromCur)) feeValue = 300;
        else feeValue = 2;
      }

      return res.json({
        success: true,
        data: {
          fee: feeValue,
          feeSource: feeValue,
          feeType,
          feeId,
          amount: amountNum,
          currency: fromCur,
          provider: normalizedProvider,
          country: normalizedCountry,
          toCountry: normalizedToCountry,
          snapshot: usedBareme || null,
          debug: {
            requestNormalized: {
              type: lower(type) || null,
              txType: null,
              method: null,
              provider: normalizedProvider || null,
              country: normalizedCountry || null,
              toCountry: normalizedToCountry || null,
              amount: amountNum,
              currency: fromCur,
            },
            feeRuleApplied: usedBareme || null,
            feeBreakdown: feeBreakdown || null,
            feeSource: feeValue,
          },
        },
      });
    }

    /**
     * ADAPTATEUR AU-DESSUS DU MOTEUR DE TARIFICATION
     * -------------------------------------------------------------------------
     * Cet endpoint lisait `Fee` + `FxRule` tandis que `/pricing/quote` — celui
     * qui facture réellement — lit `PricingRule`. Le client pouvait donc voir un
     * frais et en payer un autre. Il n'existe désormais qu'une seule vérité.
     *
     * La forme de la réponse est conservée à l'identique : l'app mobile et le
     * site public la consomment telle quelle.
     */
    const quoteRequest = {
      txType: normalizedTxType || "TRANSFER",
      method: normalizedMethod || null,
      provider: normalizedProvider || null,
      amount: amountNum,
      fromCurrency: fromCur,
      toCurrency: toCur,
      country: normalizedCountry ? upper(normalizedCountry) : null,
      fromCountry: normalizedCountry ? upper(normalizedCountry) : null,
      toCountry: normalizedToCountry ? upper(normalizedToCountry) : null,
    };

    const rules = await getActiveRules();

    let quote;
    try {
      quote = await computeQuote({
        req: quoteRequest,
        rules,
        getMarketRate: async (from, to) => {
          if (upper(from) === upper(to)) return 1;
          const out = await getExchangeRate(from, to);
          const rate = Number(out?.rate ?? out);
          return Number.isFinite(rate) ? rate : null;
        },
      });
    } catch (err) {
      if (err?.status === 404) {
        // Plus de repli inventé : afficher 1 % que la transaction ne prélèvera
        // pas est exactement le défaut corrigé ici. Le corridor est consigné
        // pour que l'admin puisse créer la règle manquante.
        recordCoverageGap(err?.details?.normalizedRequest || quoteRequest);

        return res.status(404).json({
          success: false,
          code: "NO_PRICING_RULE",
          message:
            "Aucun tarif n'est défini pour ce corridor. Nos équipes en ont été informées.",
        });
      }

      if (err?.status === 503) {
        return res.status(503).json({
          success: false,
          code: "FX_UNAVAILABLE",
          message: "Taux de change indisponible",
        });
      }

      throw err;
    }

    const result = quote.result || {};

    const fees = Number(result.fee || 0);
    const appliedRate = Number(result.appliedRate || 0);
    const marketRate = result.marketRate == null ? null : Number(result.marketRate);
    const netAfterFees = Number(result.netFrom || 0);
    const convertedNet = Number(result.netTo || 0);
    const convertedAmount = roundMoney(amountNum * appliedRate, toCur);

    // Les deux moteurs expriment déjà le pourcentage en pourcentage :
    // aucune conversion, sous peine d'un facteur 100.
    const feePercent = Number(result.feeBreakdown?.percent ?? 0);

    return res.json({
      success: true,
      data: {
        txType: quote.request?.txType || null,
        method: quote.request?.method || null,
        provider: quote.request?.provider || null,
        country: quote.request?.country || null,
        toCountry: quote.request?.toCountry || null,

        amount: amountNum,
        fromCurrency: fromCur,
        toCurrency: toCur,

        fxBaseRate: marketRate,
        exchangeRate: appliedRate,
        fxRuleApplied: quote.ruleApplied || null,
        fxSource: "pricing-engine",
        fxStale: false,
        fxWarning: null,

        feeSource: fees,
        feePercent,
        fees,
        feeBreakdown: result.feeBreakdown || null,
        netAfterFees,

        convertedAmount,
        convertedNetAfterFees: convertedNet,

        // Champs conservés pour compatibilité, désormais alimentés par la règle
        // de tarification. Obsolètes : ils disparaîtront quand plus aucun client
        // ne les lira.
        baremeId: quote.ruleApplied?.ruleId || null,
        baremeSnapshot: null,

        debug: {
          engine: "pricing-engine",
          requestNormalized: quote.request || null,
          ruleApplied: quote.ruleApplied || null,
          feeBreakdown: result.feeBreakdown || null,
          fxRevenue: result.fxRevenue || null,
        },
      },
    });
  } catch (e) {
    logger.error?.("[Fees] simulateFee error", e);

    const msg = String(e?.message || "");
    const status =
      e?.status ||
      (msg.toLowerCase().includes("taux") || msg.toLowerCase().includes("fx") ? 503 : 500);

    if (e?.debug?.blocked?.retryAfterSec) {
      res.setHeader("Retry-After", String(e.debug.blocked.retryAfterSec));
    }

    return res.status(status).json({
      success: false,
      message: e.message,
    });
  }
};