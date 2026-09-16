"use strict";

/**
 * Demandes de changement de barème — déplacé depuis l'API Gateway le 2026-09-10.
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
/**
 * WORKFLOW DE CHANGEMENT TARIFAIRE
 * -----------------------------------------------------------------------------
 * Dépôt, lecture, retrait, refus, approbation, rejeu et aperçu chiffré.
 *
 * Contrôleur mince : la logique vit dans `src/services/pricing/`.
 */

const { getPricingModel } = require("../../config/db");

const modelePricingRule = () => getPricingModel("PricingRule");
const modelePricingChangeRequest = () => getPricingModel("PricingChangeRequest");

const mongoose = require("mongoose");


const { validateProposedRule } = require("../../services/pricing/ruleValidation");
const { computeRuleDiff } = require("../../services/pricing/diff");
const { fusionnerProposed } = require("../../services/pricing/proposedMerge");
const {
  applyChangeRequest,
  retryApply: retryApplyRequest,
  toActor,
  buildSnapshot,
} = require("../../services/pricing/governanceService");
const { isSameActor } = require("../../services/pricing/governanceRules");

const { computeQuote } = require("../../services/pricing/pricingEngine");
const { getExchangeRate } = require("../../services/pricing/exchangeRateService");

const MIN_REASON_LENGTH = 10;
const MIN_REJECTION_REASON_LENGTH = 5;

function fail(res, status, message) {
  return res.status(status).json({ success: false, error: message, message });
}

function sendError(res, err, fallback) {
  const status = Number(err?.status) || 500;

  if (status >= 500) {
    console.error("[pricingChangeRequests]", err);
  }

  return fail(res, status, status >= 500 ? fallback : err?.message || fallback);
}

const upper = (v) => String(v ?? "").trim().toUpperCase();
const lower = (v) => String(v ?? "").trim().toLowerCase();

function num(value, fallbackValue = null) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return fallbackValue;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallbackValue;
}

function toDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Normalise le brouillon reçu du back-office.
 *
 * ⚠️ `amountRange` est lu À LA RACINE. L'ancien formulaire plaçait
 * `minAmount`/`maxAmount` dans l'objet `fee`, où le schéma Mongoose ne les
 * connaît pas : ils étaient silencieusement jetés et aucune grille par tranche
 * de montant ne pouvait être enregistrée. Les deux formes sont acceptées ici
 * pour tolérer un client non encore mis à jour, mais la forme canonique est
 * `amountRange`.
 */
function normalizeProposed(body = {}) {
  const scope = body.scope || {};
  const fee = body.fee || {};
  const fx = body.fx || {};
  const amountRange = body.amountRange || {};

  return {
    name: String(body.name ?? "").trim(),
    code: body.code ? upper(body.code) : null,
    description: String(body.description ?? "").trim(),
    notes: String(body.notes ?? "").trim(),
    active: body.active === undefined ? true : !!body.active,
    priority: num(body.priority, 0) ?? 0,
    category: lower(body.category) || "pricing",
    service: lower(body.service) || "all",

    scope: {
      txType: upper(scope.txType) || "ALL",
      method: upper(scope.method) || "ALL",
      provider: lower(scope.provider) || "all",
      country: upper(scope.country) || "ALL",
      fromCountry: upper(scope.fromCountry) || "ALL",
      toCountry: upper(scope.toCountry) || "ALL",
      fromCurrency: upper(scope.fromCurrency),
      toCurrency: upper(scope.toCurrency),
    },

    countries: Array.isArray(body.countries)
      ? body.countries.map(upper).filter(Boolean)
      : [],
    operators: Array.isArray(body.operators)
      ? body.operators.map(lower).filter(Boolean)
      : [],

    amountRange: {
      min: num(amountRange.min ?? fee.minAmount, 0) ?? 0,
      max: num(amountRange.max ?? fee.maxAmount, null),
    },

    fee: {
      mode: upper(fee.mode) || "NONE",
      fixed: num(fee.fixed, 0) ?? 0,
      percent: num(fee.percent, 0) ?? 0,
      minFee: num(fee.minFee, null),
      maxFee: num(fee.maxFee, null),
    },

    fx: {
      mode: upper(fx.mode) || "PASS_THROUGH",
      overrideRate: num(fx.overrideRate, null),
      markupPercent: num(fx.markupPercent, 0) ?? 0,
      percent: num(fx.percent, 0) ?? 0,
      deltaAbs: num(fx.deltaAbs, 0) ?? 0,
      notes: String(fx.notes ?? "").trim(),
    },

    startsAt: toDateOrNull(body.startsAt),
    endsAt: toDateOrNull(body.endsAt),
  };
}

/** POST /pricing-change-requests */
exports.create = async (req, res) => {
  try {
    const action = lower(req.body?.action);

    if (!["create", "update", "archive"].includes(action)) {
      return fail(res, 400, "Action inconnue : attendu create, update ou archive.");
    }

    const reason = String(req.body?.reason ?? "").trim();
    if (reason.length < MIN_REASON_LENGTH) {
      return fail(
        res,
        400,
        `Le motif est obligatoire et doit faire au moins ${MIN_REASON_LENGTH} caractères : il est lu par le valideur et par un contrôle.`
      );
    }

    let ruleId = null;
    let existing = null;
    let baseVersion = null;

    if (action !== "create") {
      ruleId = req.body?.ruleId;

      if (!mongoose.Types.ObjectId.isValid(ruleId)) {
        return fail(res, 400, "Identifiant de règle invalide.");
      }

      existing = await modelePricingRule().findById(ruleId);
      if (!existing) {
        return fail(res, 404, "Règle introuvable.");
      }

      baseVersion = Number(existing.currentVersion ?? 1);
    }

    let proposed = null;

    if (action !== "archive") {
      /**
       * Sémantique de FUSION sur une mise à jour : un champ non transmis reste
       * inchangé. Mesuré le 2026-09-16 — une modification de marge avait effacé
       * le code et la description d'un barème, et rétréci son périmètre
       * fournisseur, parce que `normalizeProposed` fabrique un document COMPLET
       * là où le client n'envoyait qu'un champ.
       *
       * La fusion intervient AVANT la validation et AVANT le différentiel : la
       * demande enregistrée doit annoncer ce qu'elle fera réellement, et le
       * contrôle doit porter sur l'état final, pas sur un fragment.
       */
      const brut = req.body?.proposed || req.body;
      const normalise = normalizeProposed(brut);

      proposed =
        action === "update"
          ? fusionnerProposed({ base: buildSnapshot(existing), brut, normalise })
          : normalise;

      const validation = validateProposedRule(proposed);
      if (!validation.ok) {
        return fail(res, 400, validation.message);
      }
    }

    const before = existing ? buildSnapshot(existing) : null;
    const after =
      action === "archive" ? { ...(before || {}), active: false } : proposed;

    const diff = computeRuleDiff(before, after);

    if (action !== "create" && diff.length === 0) {
      return fail(res, 400, "Cette demande ne modifierait rien.");
    }

    const doc = await modelePricingChangeRequest().create({
      action,
      ruleId,
      proposed,
      baseVersion,
      diff,
      status: "pending_approval",
      reason,
      requestedBy: toActor(req.user),
    });

    return res.status(201).json({
      success: true,
      message: "Demande déposée. Elle attend la validation d'un autre administrateur.",
      data: doc,
    });
  } catch (err) {
    return sendError(res, err, "Erreur lors du dépôt de la demande.");
  }
};

/** GET /pricing-change-requests?status=&ruleId=&page=&limit= */
exports.list = async (req, res) => {
  try {
    const { status, ruleId, page = 1, limit = 50 } = req.query;

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));

    const filter = {};

    if (status) {
      const wanted = String(status)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      filter.status = wanted.length > 1 ? { $in: wanted } : wanted[0];
    }

    if (ruleId && mongoose.Types.ObjectId.isValid(ruleId)) {
      filter.ruleId = ruleId;
    }

    const [items, total, pendingCount] = await Promise.all([
      modelePricingChangeRequest().find(filter)
        .sort({ createdAt: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .lean(),
      modelePricingChangeRequest().countDocuments(filter),
      modelePricingChangeRequest().countDocuments({ status: "pending_approval" }),
    ]);

    return res.status(200).json({
      success: true,
      data: items,
      total,
      pendingCount,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        pages: Math.ceil(total / safeLimit),
      },
    });
  } catch (err) {
    return sendError(res, err, "Erreur lors de la lecture des demandes.");
  }
};

/** GET /pricing-change-requests/:id */
exports.getById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, "Identifiant invalide.");
    }

    const doc = await modelePricingChangeRequest().findById(id).lean();
    if (!doc) {
      return fail(res, 404, "Demande introuvable.");
    }

    // État courant de la règle, pour que l'écran puisse signaler un diff périmé.
    let currentVersion = null;
    if (doc.ruleId) {
      const rule = await modelePricingRule().findById(doc.ruleId).select("currentVersion").lean();
      currentVersion = rule ? Number(rule.currentVersion) : null;
    }

    return res.status(200).json({
      success: true,
      data: {
        ...doc,
        currentVersion,
        stale:
          doc.baseVersion != null &&
          currentVersion != null &&
          Number(doc.baseVersion) !== currentVersion,
      },
    });
  } catch (err) {
    return sendError(res, err, "Erreur lors de la lecture de la demande.");
  }
};

/** POST /pricing-change-requests/:id/cancel — par l'auteur uniquement. */
exports.cancel = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, "Identifiant invalide.");
    }

    const doc = await modelePricingChangeRequest().findById(id);
    if (!doc) {
      return fail(res, 404, "Demande introuvable.");
    }

    if (!isSameActor(doc.requestedBy, req.user)) {
      return fail(res, 403, "Seul l'auteur d'une demande peut la retirer.");
    }

    const cancelled = await modelePricingChangeRequest().findOneAndUpdate(
      { _id: id, status: "pending_approval" },
      { $set: { status: "cancelled" } },
      { new: true }
    );

    if (!cancelled) {
      return fail(
        res,
        409,
        "Cette demande n'est plus en attente : elle ne peut plus être retirée."
      );
    }

    return res.status(200).json({
      success: true,
      message: "Demande retirée.",
      data: cancelled,
    });
  } catch (err) {
    return sendError(res, err, "Erreur lors du retrait de la demande.");
  }
};

/** POST /pricing-change-requests/:id/reject */
exports.reject = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, "Identifiant invalide.");
    }

    const rejectionReason = String(req.body?.rejectionReason ?? "").trim();
    if (rejectionReason.length < MIN_REJECTION_REASON_LENGTH) {
      return fail(
        res,
        400,
        `Le motif de refus est obligatoire (au moins ${MIN_REJECTION_REASON_LENGTH} caractères) : il est lu par le demandeur.`
      );
    }

    const doc = await modelePricingChangeRequest().findById(id);
    if (!doc) {
      return fail(res, 404, "Demande introuvable.");
    }

    if (isSameActor(doc.requestedBy, req.user)) {
      return fail(
        res,
        403,
        "Vous êtes le demandeur : pour abandonner cette demande, retirez-la plutôt que de la refuser."
      );
    }

    const rejected = await modelePricingChangeRequest().findOneAndUpdate(
      { _id: id, status: "pending_approval" },
      {
        $set: {
          status: "rejected",
          rejectedBy: toActor(req.user),
          rejectionReason,
        },
      },
      { new: true }
    );

    if (!rejected) {
      return fail(res, 409, "Cette demande vient d'être traitée par un autre administrateur.");
    }

    return res.status(200).json({
      success: true,
      message: "Demande refusée.",
      data: rejected,
    });
  } catch (err) {
    return sendError(res, err, "Erreur lors du refus de la demande.");
  }
};

/** POST /pricing-change-requests/:id/approve */
exports.approve = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, "Identifiant invalide.");
    }

    const wantsBreakGlass = !!req.body?.breakGlass?.used;

    const { request, rule, version } = await applyChangeRequest({
      requestId: id,
      actor: req.user,
      breakGlass: wantsBreakGlass
        ? {
            used: true,
            reason: String(req.body?.breakGlass?.reason ?? "").trim(),
          }
        : null,
    });

    return res.status(200).json({
      success: true,
      message: wantsBreakGlass
        ? "Règle publiée sans second valideur. La dérogation est consignée au journal."
        : "Demande validée et règle publiée.",
      data: {
        request,
        rule,
        versionNumber: version?.versionNumber ?? null,
      },
    });
  } catch (err) {
    return sendError(res, err, "Erreur lors de la validation de la demande.");
  }
};

/**
 * POST /pricing-change-requests/:id/retry-apply — superadmin uniquement.
 * Répare le mode dégradé : règle publiée dont le snapshot ou la clôture manque.
 */
exports.retryApply = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, "Identifiant invalide.");
    }

    const { request, rule, version } = await retryApplyRequest({
      requestId: id,
      actor: req.user,
    });

    return res.status(200).json({
      success: true,
      message: "Application rejouée.",
      data: { request, rule, versionNumber: version?.versionNumber ?? null },
    });
  } catch (err) {
    return sendError(res, err, "Erreur lors du rejeu de l'application.");
  }
};

/**
 * GET /pricing-change-requests/:id/preview?amount=…
 *
 * Exécute le VRAI moteur avec la règle proposée, sans rien publier, et renvoie
 * les deux colonnes comparées. Approuver un diff JSON n'est pas une validation :
 * c'est ce chiffrage qui transforme l'approbation en décision.
 */
exports.preview = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, "Identifiant invalide.");
    }

    const request = await modelePricingChangeRequest().findById(id).lean();
    if (!request) {
      return fail(res, 404, "Demande introuvable.");
    }

    const amount = Number(req.query?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return fail(res, 400, "Indiquez un montant strictement positif à simuler.");
    }

    const currentRule = request.ruleId
      ? await modelePricingRule().findById(request.ruleId).lean()
      : null;

    const proposedRule =
      request.action === "archive"
        ? null
        : {
            ...(request.proposed || {}),
            _id: request.ruleId || "proposed",
            active: true,
          };

    // Le périmètre simulé est celui de la règle concernée : proposé en priorité,
    // courant à défaut (cas d'un archivage).
    const scope = (proposedRule || currentRule || {}).scope || {};

    const quoteRequest = {
      txType: scope.txType && scope.txType !== "ALL" ? scope.txType : "TRANSFER",
      method: scope.method && scope.method !== "ALL" ? scope.method : "INTERNAL",
      provider: scope.provider && scope.provider !== "all" ? scope.provider : null,
      amount,
      fromCurrency: scope.fromCurrency,
      toCurrency: scope.toCurrency,
      fromCountry: scope.fromCountry === "ALL" ? null : scope.fromCountry,
      toCountry: scope.toCountry === "ALL" ? null : scope.toCountry,
      country: scope.country === "ALL" ? null : scope.country,
    };

    const getMarketRate = async (from, to) => {
      if (String(from).toUpperCase() === String(to).toUpperCase()) return 1;
      const out = await getExchangeRate(from, to, { mode: "live" });
      const rate = Number(out?.rate ?? out);
      return Number.isFinite(rate) ? rate : null;
    };

    /** Un corridor sans règle applicable renvoie `null`, jamais un zéro trompeur. */
    async function runWith(rules) {
      if (!rules.length) return null;

      try {
        const quote = await computeQuote({ req: quoteRequest, rules, getMarketRate });

        return {
          fee: quote.result.fee,
          appliedRate: quote.result.appliedRate,
          marketRate: quote.result.marketRate,
          netFrom: quote.result.netFrom,
          netTo: quote.result.netTo,
          ruleName: rules[0]?.name ?? null,
        };
      } catch (err) {
        if (err?.status === 404) return null; // aucune règle applicable
        throw err;
      }
    }

    const [before, after] = await Promise.all([
      runWith(currentRule ? [currentRule] : []),
      runWith(proposedRule ? [proposedRule] : []),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        amount,
        fromCurrency: scope.fromCurrency ?? null,
        toCurrency: scope.toCurrency ?? null,
        before,
        after,
      },
    });
  } catch (err) {
    return sendError(res, err, "Erreur lors de la simulation de la demande.");
  }
};

exports.MIN_REASON_LENGTH = MIN_REASON_LENGTH;
exports.MIN_REJECTION_REASON_LENGTH = MIN_REJECTION_REASON_LENGTH;
exports.normalizeProposed = normalizeProposed;
