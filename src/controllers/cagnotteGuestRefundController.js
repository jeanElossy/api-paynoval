"use strict";

/**
 * Remboursement d'un invité (versement mobile money) — traducteur HTTP fin.
 * Logique : `services/cagnotte/guestRefund.js`. Appelé par le backend principal
 * (jeton interne), jamais par un client.
 *
 * ⚠️ Le numéro de versement n'apparaît dans AUCUN journal ni aucune réponse.
 */

const asyncHandler = require("express-async-handler");

const { initiateGuestRefund, refundToJSON } = require("../services/cagnotte/guestRefund");
const { guestRefundDeps, makeGuestRefundRepo } = require("../services/cagnotte/guestRefundRepo");
const logger = require("../utils/logger");

function sendError(res, err, reference) {
  const status = Number(err?.status || err?.statusCode) || 500;
  const named = Boolean(err?.code);

  if (status >= 500) {
    logger.error("[cagnotte][remboursement-invité] échec", {
      reference: reference || null,
      code: err?.code || null,
      message: err?.message,
    });
  }

  return res.status(status).json({
    success: false,
    code: err?.code || "INTERNAL_ERROR",
    error: named ? err.message : "Erreur interne lors du remboursement.",
    ...(err?.details ? { details: err.details } : {}),
  });
}

const refundGuestParticipation = asyncHandler(async (req, res) => {
  const b = req.body || {};

  try {
    const out = await initiateGuestRefund(
      {
        reference: b.reference,
        idempotencyKey: b.idempotencyKey,
        participationReference: b.participationReference,
        initiatedByUserId: b.initiatedByUserId,
        payoutPhone: b.payoutPhone,
        reason: b.reason,
        amount: b.amount,
      },
      guestRefundDeps()
    );

    const status = out.outcome === "UNCERTAIN" ? 202 : out.alreadyProcessed ? 200 : 201;

    return res.status(status).json({
      success: true,
      alreadyProcessed: Boolean(out.alreadyProcessed),
      outcome: out.outcome || null,
      data: refundToJSON(out.refund),
    });
  } catch (err) {
    return sendError(res, err, b.reference);
  }
});

const getCagnotteRefund = asyncHandler(async (req, res) => {
  const reference = String(req.params.reference || "").trim();

  try {
    const refund = await makeGuestRefundRepo().findRefundByReference(reference);

    if (!refund) {
      return res.status(404).json({ success: false, code: "REFUND_NOT_FOUND", error: "Remboursement introuvable." });
    }

    return res.json({ success: true, data: refundToJSON(refund) });
  } catch (err) {
    return sendError(res, err, reference);
  }
});

module.exports = { refundGuestParticipation, getCagnotteRefund };
