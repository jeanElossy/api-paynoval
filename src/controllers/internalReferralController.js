"use strict";

/**
 * ============================================================================
 * ENDPOINTS INTERNES DE PARRAINAGE — Tx-Core
 * ============================================================================
 *
 * Deux responsabilités, strictement séparées :
 *
 *   POST /internal/referral/activity       → TÉMOIGNER (faits transactionnels)
 *   POST /internal/referral/transfer-bonus → EXÉCUTER  (le versement décidé)
 *
 * Tx-Core ne décide jamais d'un bonus. Il rapporte ce qu'il a vu, et il exécute
 * ce que le backend principal a arrêté. Aucun montant n'est calculé ici ; aucune
 * condition d'éligibilité n'y est évaluée.
 *
 * AUTHENTIFICATION. Elle n'est plus faite dans ces fonctions : elle est portée
 * par `requireInternalAuth('principal')` au niveau du routeur. L'ancien contrôle
 * inline comparait les jetons avec `===` — vulnérable à une attaque temporelle —
 * et vivait au même endroit que la logique métier, ce qui rendait facile de
 * l'oublier en ajoutant une route.
 */

let logger = console;
try {
  logger = require("../utils/logger");
} catch {}

const {
  transferReferralBonus,
} = require("../services/internalReferralTransferService");

const {
  getQualifyingActivity,
} = require("../services/referral/referralActivityService");

function safeNumber(v) {
  const n =
    typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function normalizeCurrency(v, fallback = "CAD") {
  const code = String(v || fallback)
    .trim()
    .toUpperCase();
  return code || fallback;
}

/** Identifiant de corrélation transmis par l'appelant, ou vide. */
function getCorrelationId(req) {
  return String(req.headers["x-correlation-id"] || "").trim().slice(0, 128);
}

/**
 * POST /api/v1/internal/referral/activity
 *
 * Rapporte l'activité qualifiante d'un utilisateur. Les critères (flux, fenêtre,
 * exclusions) sont imposés par l'appelant, mais revalidés ici contre une liste
 * blanche : un service interne compromis ne doit pas pouvoir transformer cet
 * endpoint en extracteur de données arbitraire.
 */
exports.getActivity = async (req, res) => {
  const correlationId = getCorrelationId(req);

  try {
    const activity = await getQualifyingActivity({
      userId: req.body?.userId,
      flows: req.body?.flows,
      since: req.body?.since,
      until: req.body?.until,
      excludeTypes: req.body?.excludeTypes,
      excludeCounterpartyUserId: req.body?.excludeCounterpartyUserId,
    });

    return res.json({ success: true, data: activity });
  } catch (e) {
    const status = Number(e?.status) || 500;

    if (status >= 500) {
      logger.error?.("[InternalReferral] getActivity error", {
        correlationId,
        message: e?.message,
        code: e?.code,
      });
    }

    return res.status(status).json({
      success: false,
      code: e?.code || "REFERRAL_ACTIVITY_FAILED",
      error:
        status >= 500
          ? "Activité de parrainage indisponible"
          : e?.message || "Requête invalide",
    });
  }
};

/**
 * POST /api/v1/internal/referral/transfer-bonus
 *
 * Exécute un versement déjà décidé. Idempotent par construction : le même
 * `rewardId` et le même bénéficiaire ne peuvent donner lieu qu'à un seul
 * mouvement, quel que soit le nombre d'appels.
 *
 * ⚠️ LES MONTANTS ARRIVENT D'AILLEURS, ET C'EST NORMAL — mais uniquement parce
 * que cet endpoint est inaccessible depuis l'extérieur et que le seul appelant
 * autorisé est le moteur d'éligibilité, qui les calcule lui-même à partir du
 * barème. Si cet endpoint devenait un jour joignable autrement, ces montants
 * devraient être recalculés ici.
 */
exports.transferBonus = async (req, res) => {
  const correlationId = getCorrelationId(req) || String(req.body?.correlationId || "");

  try {
    const {
      rewardId,
      programVersion = "",
      triggerTxId = "",
      treasuryUserId,
      treasurySystemType = "REFERRAL_TREASURY",
      treasuryCurrency = "CAD",
      bonusInputCurrency = "CAD",
      beneficiaries,
      metadata = {},
    } = req.body || {};

    if (!rewardId) {
      return res.status(400).json({
        success: false,
        ok: false,
        code: "REWARD_ID_REQUIRED",
        error: "rewardId requis",
      });
    }

    if (!treasuryUserId) {
      return res.status(400).json({
        success: false,
        ok: false,
        code: "TREASURY_USER_ID_REQUIRED",
        error: "treasuryUserId requis",
      });
    }

    if (!Array.isArray(beneficiaries) || !beneficiaries.length) {
      return res.status(400).json({
        success: false,
        ok: false,
        code: "BENEFICIARIES_REQUIRED",
        error: "beneficiaries requis",
      });
    }

    const normalizedInputCurrency = normalizeCurrency(bonusInputCurrency, "CAD");

    const result = await transferReferralBonus({
      rewardId: String(rewardId),
      correlationId,
      programVersion: String(programVersion || ""),
      triggerTxId: String(triggerTxId || ""),
      treasuryUserId: String(treasuryUserId).trim(),
      treasurySystemType: String(treasurySystemType || "REFERRAL_TREASURY").trim(),
      treasuryCurrency: normalizeCurrency(treasuryCurrency, "CAD"),
      bonusInputCurrency: normalizedInputCurrency,
      beneficiaries: beneficiaries.map((b) => ({
        userId: String(b?.userId || ""),
        role: String(b?.role || ""),
        amount: safeNumber(b?.amount),
        payoutCurrency: normalizeCurrency(
          b?.payoutCurrency || normalizedInputCurrency,
          normalizedInputCurrency
        ),
        label: String(b?.label || ""),
      })),
      metadata:
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? metadata
          : {},
    });

    if (!result?.ok) {
      /**
       * 409 et non 400 : l'échec porte sur l'ÉTAT du système (fonds
       * insuffisants, portefeuille absent), pas sur la forme de la requête. La
       * distinction compte pour l'appelant, qui doit reprogrammer une tentative
       * dans le premier cas et corriger son appel dans le second.
       */
      return res.status(409).json({ success: false, ...result });
    }

    return res.json({ success: true, ...result });
  } catch (e) {
    logger.error?.("[InternalReferral] transferBonus error", {
      correlationId,
      message: e?.message,
      code: e?.code,
      stack: e?.stack,
    });

    return res.status(500).json({
      success: false,
      ok: false,
      code: e?.code || "INTERNAL_REFERRAL_TRANSFER_ERROR",
      error: "Erreur transfert bonus parrainage",
    });
  }
};
