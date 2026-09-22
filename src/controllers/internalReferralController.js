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
      excludeCounterpartyUserIds: req.body?.excludeCounterpartyUserIds,
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

/**
 * Reprise d'un bonus (clawback). Le corps ne porte QUE l'identifiant de la
 * récompense et le contexte : montants et bénéficiaires sont relus dans le
 * registre `ReferralPayout` (voir `internalReferralClawbackService`).
 */
exports.clawbackBonus = async (req, res) => {
  const correlationId = getCorrelationId(req) || String(req.body?.correlationId || "");

  try {
    const { reverseReferralBonus } = require("../services/internalReferralClawbackService");

    const rewardId = String(req.body?.rewardId || "").trim();

    if (!/^[0-9a-f]{24}$/i.test(rewardId)) {
      return res.status(400).json({
        success: false,
        ok: false,
        retryable: false,
        code: "REWARD_ID_INVALID",
        error: "rewardId invalide",
      });
    }

    const result = await reverseReferralBonus({
      rewardId,
      reversedTxId: String(req.body?.reversedTxId || "").slice(0, 64),
      reason: String(req.body?.reason || "").slice(0, 200),
      correlationId,
    });

    if (!result?.ok) {
      return res.status(409).json({ success: false, ...result });
    }

    return res.json({ success: true, ...result });
  } catch (e) {
    logger.error?.("[InternalReferral] clawbackBonus error", {
      correlationId,
      message: e?.message,
      code: e?.code,
    });

    return res.status(500).json({
      success: false,
      ok: false,
      retryable: true,
      code: "INTERNAL_REFERRAL_CLAWBACK_ERROR",
      error: "Erreur de reprise du bonus de parrainage",
    });
  }
};

/** Lecture des versements et reprises d'un lot de récompenses (réconciliation). */
exports.lookupPayouts = async (req, res) => {
  try {
    const { lookupReferralPayouts } = require("../services/internalReferralClawbackService");

    const data = await lookupReferralPayouts({ rewardIds: req.body?.rewardIds });
    return res.json({ success: true, data });
  } catch (e) {
    logger.error?.("[InternalReferral] lookupPayouts error", {
      correlationId: getCorrelationId(req),
      message: e?.message,
    });

    return res.status(500).json({
      success: false,
      code: "REFERRAL_PAYOUT_LOOKUP_FAILED",
      error: "Lecture des versements indisponible",
    });
  }
};

/**
 * État de la trésorerie qui finance les bonus (lecture seule).
 *
 * Le principal s'en sert pour DIRE LA VÉRITÉ au démarrage et dans le
 * back-office : une trésorerie non configurée, non provisionnée ou vide
 * n'empêche aucun versement de se réclamer correct — elle les empêche tous
 * de partir. Sans ce point de lecture, cela ne se voit qu'en creux, dans une
 * file d'attente qui grossit.
 *
 * ⚠️ L'identifiant de trésorerie est lu dans l'ENVIRONNEMENT de Tx-Core, pas
 * dans le corps de la requête : l'appelant ne choisit pas le compte dont on
 * lui rend le solde.
 */
exports.treasuryStatus = async (req, res) => {
  try {
    const { getReferralTreasuryStatus } = require("../services/internalReferralTransferService");

    const status = await getReferralTreasuryStatus({
      treasuryUserId: process.env.REFERRAL_TREASURY_USER_ID,
    });

    return res.json({ success: true, data: status });
  } catch (e) {
    logger.error?.("[InternalReferral] treasuryStatus error", {
      correlationId: getCorrelationId(req),
      message: e?.message,
    });

    return res.status(500).json({
      success: false,
      code: "REFERRAL_TREASURY_STATUS_FAILED",
      error: "Etat de tresorerie indisponible",
    });
  }
};

/** Réconciliation du registre Tx-Core (lecture seule), déclenchée par le principal. */
exports.reconcile = async (req, res) => {
  try {
    const {
      reconcileReferralPayouts,
    } = require("../services/referral/referralReconciliationService");

    const sinceHours = Math.min(Math.max(Number(req.body?.sinceHours) || 48, 1), 24 * 60);
    const result = await reconcileReferralPayouts({ sinceHours, limit: 1000 });

    return res.json({ success: true, data: result });
  } catch (e) {
    logger.error?.("[InternalReferral] reconcile error", {
      correlationId: getCorrelationId(req),
      message: e?.message,
    });

    return res.status(500).json({
      success: false,
      code: "REFERRAL_RECONCILE_FAILED",
      error: "Réconciliation indisponible",
    });
  }
};

/** Statut actuel des transactions ayant ouvert un bonus (filet de la reprise). */
exports.transactionStatuses = async (req, res) => {
  try {
    const {
      getTransactionStatuses,
    } = require("../services/referral/referralActivityService");

    const data = await getTransactionStatuses({ txIds: req.body?.txIds });
    return res.json({ success: true, data });
  } catch (e) {
    logger.error?.("[InternalReferral] transactionStatuses error", {
      correlationId: getCorrelationId(req),
      message: e?.message,
    });

    return res.status(500).json({
      success: false,
      code: "REFERRAL_TX_STATUS_FAILED",
      error: "Statuts de transaction indisponibles",
    });
  }
};
