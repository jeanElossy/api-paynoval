// File: controllers/adminCancelRefund.controller.js

"use strict";

const createError = require("http-errors");

const {
  startTxSession,
  canUseSharedSession,
} = require("../services/transactions/shared/runtime");

const {
  processAdminCancelRefund,
} = require("../services/cancellation.service");

function getActorFromRequest(req) {
  const bodyActor = req.body?.requestedBy || {};

  return {
    id:
      bodyActor.id ||
      req.user?.id ||
      req.user?._id ||
      req.admin?.id ||
      req.admin?._id ||
      null,

    email:
      bodyActor.email ||
      req.user?.email ||
      req.admin?.email ||
      null,

    role:
      bodyActor.role ||
      req.user?.role ||
      req.admin?.role ||
      "support",

    source:
      bodyActor.source ||
      bodyActor.role ||
      req.user?.role ||
      req.admin?.role ||
      "support",
  };
}

function getIdempotencyKey(req, transactionId) {
  return String(
    req.headers["idempotency-key"] ||
      req.headers["x-idempotency-key"] ||
      req.body?.idempotencyKey ||
      `admin-cancel-refund:${transactionId}`
  ).trim();
}

/**
 * POST /api/v1/internal/transactions/:transactionId/cancel-refund
 *
 * Endpoint interne appelé par le backend principal.
 * Il ne doit jamais être exposé directement au mobile ou au back-office.
 */
async function adminCancelRefundController(req, res, next) {
  const session = await startTxSession();

  try {
    if (canUseSharedSession()) {
      session.startTransaction();
    }

    const transactionId =
      req.params?.transactionId ||
      req.body?.transactionId ||
      null;

    const reason = String(req.body?.reason || "").trim();

    if (!transactionId) {
      throw createError(400, "transactionId requis");
    }

    if (!reason || reason.length < 5) {
      throw createError(
        400,
        "Le motif d’annulation/remboursement est obligatoire"
      );
    }

    const requestedBy = getActorFromRequest(req);
    const idempotencyKey = getIdempotencyKey(req, transactionId);

    const result = await processAdminCancelRefund({
      transactionId,
      reason,
      requestedBy,
      idempotencyKey,
      ip: req.ip,
      session,
    });

    if (canUseSharedSession()) {
      await session.commitTransaction();
    }

    session.endSession();

    const manualReviewRequired = !!result?.manualReviewRequired;
    const alreadyProcessed = !!result?.alreadyProcessed;

    return res.status(manualReviewRequired ? 202 : 200).json({
      success: !manualReviewRequired,
      message: manualReviewRequired
        ? "Transaction déjà exécutée. Une revue manuelle est requise."
        : alreadyProcessed
          ? "Cette transaction a déjà été annulée/remboursée."
          : "Transaction annulée et remboursement effectué.",
      data: result,
    });
  } catch (error) {
    try {
      if (canUseSharedSession()) {
        await session.abortTransaction();
      }
    } catch {}

    session.endSession();
    next(error);
  }
}

module.exports = {
  adminCancelRefundController,
};