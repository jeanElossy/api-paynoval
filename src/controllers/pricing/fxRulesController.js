"use strict";

/**
 * Règles de marge de change — administration — déplacé depuis l'API Gateway le 2026-09-10.
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

const modeleFxRule = () => getPricingModel("FxRule");

const { invalidateFxRulesCache } = require("../../services/pricing/fxRulesService");

/**
 * Purge le cache des règles de change APRÈS une écriture.
 *
 * ⚠️ APRÈS LE COMMIT, ET JAMAIS AVANT. Invalider avant l'écriture laisserait
 * une fenêtre où un lecteur concurrent recharge l'ANCIENNE valeur depuis la
 * base et la remet en cache — on aurait purgé pour rien, et le tarif périmé
 * repartirait pour un tour de TTL.
 *
 * Ne lève jamais : une purge ratée ne doit pas transformer une écriture
 * réussie en erreur pour l'administrateur. Le pire cas est un tarif périmé
 * pendant la durée du TTL (5 minutes), pas une donnée fausse en base.
 */
async function purgerCache(doc) {
  try {
    await invalidateFxRulesCache({
      fromCurrency: doc?.fromCurrency,
      toCurrency: doc?.toCurrency,
    });
  } catch {
    /* déjà journalisé par le service de cache */
  }
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

function buildPayload(body = {}) {
  return {
    name: String(body.name || "").trim(),
    active: body.active === undefined ? true : !!body.active,
    priority: Number(body.priority ?? 0),

    txType: normalizeTxType(body.txType || ""),
    method: normalizeMethod(body.method || ""),

    provider: normalizeScopeLower(body.provider || ""),
    country: normalizeScopeLower(body.country || ""),
    fromCountry: normalizeScopeLower(body.fromCountry || ""),
    toCountry: normalizeScopeLower(body.toCountry || ""),

    fromCurrency: upper(body.fromCurrency || ""),
    toCurrency: upper(body.toCurrency || ""),

    minAmount: body.minAmount == null || body.minAmount === "" ? 0 : Number(body.minAmount),
    maxAmount:
      body.maxAmount == null || body.maxAmount === "" ? null : Number(body.maxAmount),

    mode: upper(body.mode || "PASS_THROUGH"),

    overrideRate:
      body.overrideRate == null || body.overrideRate === "" ? null : Number(body.overrideRate),

    markupPercent:
      body.markupPercent == null || body.markupPercent === ""
        ? 0
        : Number(body.markupPercent),

    percent:
      body.percent == null || body.percent === ""
        ? 0
        : Number(body.percent),

    deltaAbs:
      body.deltaAbs == null || body.deltaAbs === ""
        ? 0
        : Number(body.deltaAbs),

    notes: String(body.notes || "").trim(),
  };
}

exports.list = async (req, res) => {
  try {
    const q = {};

    if (req.query.q && String(req.query.q).trim()) {
      const regex = new RegExp(String(req.query.q).trim(), "i");
      q.$or = [
        { name: regex },
        { provider: regex },
        { country: regex },
        { fromCountry: regex },
        { toCountry: regex },
        { fromCurrency: regex },
        { toCurrency: regex },
        { mode: regex },
        { notes: regex },
      ];
    }

    const activeParsed = toBool(req.query.active, undefined);
    if (activeParsed !== undefined) q.active = activeParsed;

    if (req.query.provider !== undefined && req.query.provider !== "") {
      q.provider = normalizeScopeLower(req.query.provider);
    }

    if (req.query.country !== undefined && req.query.country !== "") {
      q.country = normalizeScopeLower(req.query.country);
    }

    if (req.query.fromCountry !== undefined && req.query.fromCountry !== "") {
      q.fromCountry = normalizeScopeLower(req.query.fromCountry);
    }

    if (req.query.toCountry !== undefined && req.query.toCountry !== "") {
      q.toCountry = normalizeScopeLower(req.query.toCountry);
    }

    if (req.query.fromCurrency !== undefined && req.query.fromCurrency !== "") {
      q.fromCurrency = upper(req.query.fromCurrency);
    }

    if (req.query.toCurrency !== undefined && req.query.toCurrency !== "") {
      q.toCurrency = upper(req.query.toCurrency);
    }

    if (req.query.mode !== undefined && req.query.mode !== "") {
      q.mode = upper(req.query.mode);
    }

    if (req.query.txType !== undefined && req.query.txType !== "") {
      q.txType = normalizeTxType(req.query.txType);
    }

    if (req.query.method !== undefined && req.query.method !== "") {
      q.method = normalizeMethod(req.query.method);
    }

    const limit = parseInt(req.query.limit, 10) || 100;
    const skip = parseInt(req.query.skip, 10) || 0;

    const [data, total] = await Promise.all([
      modeleFxRule().find(q).sort({ priority: -1, updatedAt: -1 }).skip(skip).limit(limit),
      modeleFxRule().countDocuments(q),
    ]);

    res.json({ success: true, data, total });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const doc = await modeleFxRule().findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ success: false, message: "FxRule introuvable" });
    }
    res.json({ success: true, data: doc });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.create = async (req, res) => {
  try {
    const payload = buildPayload(req.body);

    if (!payload.name) {
      return res.status(400).json({ success: false, message: "name est requis" });
    }

    if (!payload.fromCurrency || !payload.toCurrency) {
      return res.status(400).json({
        success: false,
        message: "fromCurrency et toCurrency sont requis",
      });
    }

    const doc = new FxRule(payload);
    await doc.save();
    await purgerCache(doc);

    res.status(201).json({ success: true, data: doc });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

exports.update = async (req, res) => {
  try {
    const payload = buildPayload(req.body);

    const doc = await modeleFxRule().findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });

    if (!doc) {
      return res.status(404).json({ success: false, message: "FxRule introuvable" });
    }

    // Purge la paire d'ARRIVÉE. Si la modification a changé la paire elle-même,
    // l'ancienne reste en cache jusqu'à son TTL : on purge donc aussi celle
    // envoyée dans la requête quand elle diffère.
    await purgerCache(doc);
    if (payload.fromCurrency && payload.toCurrency) {
      await purgerCache(payload);
    }

    res.json({ success: true, data: doc });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const doc = await modeleFxRule().findByIdAndDelete(req.params.id);
    if (!doc) {
      return res.status(404).json({ success: false, message: "FxRule introuvable" });
    }
    await purgerCache(doc);
    res.json({ success: true, message: "FxRule supprimée" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};