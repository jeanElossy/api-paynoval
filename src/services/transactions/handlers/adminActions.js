"use strict";

const createError = require("http-errors");

const {
  Transaction,
  User,
  debitReceiverFunds,
  refundSenderFunds,
  startTxSession,
  maybeSessionOpts,
  CAN_USE_SHARED_SESSION,
  assertTransition,
} = require("../shared/runtime");

const { sanitize, toFloat, round2, isEmailLike } = require("../shared/helpers");

const INTERNAL_FLOW = "PAYNOVAL_INTERNAL_TRANSFER";
const EXTERNAL_FLOWS = new Set([
  "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
  "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  "BANK_TRANSFER_TO_PAYNOVAL",
  "PAYNOVAL_TO_BANK_PAYOUT",
  "CARD_TOPUP_TO_PAYNOVAL",
  "PAYNOVAL_TO_CARD_PAYOUT",
]);

function isInternalTransfer(tx) {
  return tx?.flow === INTERNAL_FLOW;
}

function isExternalFlow(tx) {
  return EXTERNAL_FLOWS.has(String(tx?.flow || ""));
}

async function refundController(req, res, next) {
  const session = await startTxSession();

  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

    const { transactionId, reason = "Remboursement demandé" } = req.body;
    const sessOpts = maybeSessionOpts(session);

    const tx = await Transaction.findById(transactionId)
      .select([
        "+flow",
        "+status",
        "+sender",
        "+receiver",
        "+localAmount",
        "+localCurrencySymbol",
        "+amount",
        "+senderCurrencySymbol",
        "+beneficiaryCredited",
        "+fundsCaptured",
      ])
      .session(sessOpts.session || null);

    if (!tx) throw createError(404, "Transaction introuvable");

    if (!isInternalTransfer(tx)) {
      throw createError(
        409,
        "Le remboursement automatique n’est supporté ici que pour les transactions internes."
      );
    }

    assertTransition(tx.status, "refunded");

    if (!tx.beneficiaryCredited || !tx.fundsCaptured) {
      throw createError(409, "Transaction non exécutable en remboursement");
    }

    const targetAmount = round2(toFloat(tx.localAmount));
    const targetCurrency = String(tx.localCurrencySymbol || "").trim().toUpperCase();

    await debitReceiverFunds({
      transaction: tx,
      receiverId: tx.receiver,
      amount: targetAmount,
      currency: targetCurrency,
      session,
    });

    await refundSenderFunds({
      transaction: tx,
      senderId: tx.sender,
      amount: round2(toFloat(tx.amount)),
      currency: String(tx.senderCurrencySymbol || "").trim().toUpperCase(),
      session,
    });

    tx.status = "refunded";
    tx.refundedAt = new Date();
    tx.refundReason = sanitize(reason);
    tx.providerStatus = "REFUNDED";
    tx.reversedAt = new Date();
    await tx.save(sessOpts);

    if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
    session.endSession();

    return res.json({
      success: true,
      transactionId: tx._id.toString(),
      reference: tx.reference,
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      refunded: targetAmount,
      currency: targetCurrency,
    });
  } catch (err) {
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    next(err);
  }
}

async function validateController(req, res, next) {
  try {
    const { transactionId, status, adminNote } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx) throw createError(404, "Transaction introuvable");

    if (tx.status !== "pending" && tx.status !== "pending_review") {
      throw createError(400, "Transaction non validable");
    }

    const normalizedInput = String(status || "").toLowerCase();
    if (!["confirmed", "rejected", "pending_review"].includes(normalizedInput)) {
      throw createError(400, "Statut de validation invalide");
    }

    const normalized = normalizedInput === "rejected" ? "failed" : normalizedInput;

    if (isExternalFlow(tx) && normalized === "confirmed") {
      throw createError(
        409,
        "Un flow externe ne doit pas être confirmé manuellement sans exécution provider."
      );
    }

    tx.status = normalized;
    tx.validatedAt = new Date();
    tx.adminNote = adminNote || null;
    tx.providerStatus = `ADMIN_${normalized.toUpperCase()}`;
    await tx.save();

    return res.json({
      success: true,
      transactionId: tx._id.toString(),
      status: tx.status,
      providerStatus: tx.providerStatus,
    });
  } catch (err) {
    next(err);
  }
}

async function reassignController(req, res, next) {
  const session = await startTxSession();

  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

    const { transactionId, newReceiverEmail } = req.body;
    const sessOpts = maybeSessionOpts(session);

    const tx = await Transaction.findById(transactionId).session(sessOpts.session || null);

    if (!tx) throw createError(404, "Transaction introuvable");

    if (!isInternalTransfer(tx)) {
      throw createError(409, "La réassignation n’est supportée que pour le flow interne.");
    }

    if (!["pending", "confirmed"].includes(tx.status)) {
      throw createError(400, "Transaction non réassignable");
    }

    const cleanNewEmail = String(newReceiverEmail || "").trim().toLowerCase();
    if (!isEmailLike(cleanNewEmail)) {
      throw createError(400, "Email destinataire invalide");
    }

    const newReceiver = await User.findOne({ email: cleanNewEmail })
      .select("_id fullName email")
      .session(sessOpts.session || null);

    if (!newReceiver) throw createError(404, "Nouveau destinataire introuvable");
    if (String(newReceiver._id) === String(tx.receiver)) {
      throw createError(400, "Déjà affectée à ce destinataire");
    }

    tx.receiver = newReceiver._id;
    tx.nameDestinataire = newReceiver.fullName;
    tx.recipientEmail = newReceiver.email;
    tx.reassignedAt = new Date();
    tx.providerStatus = "REASSIGNED";
    await tx.save(sessOpts);

    if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
    session.endSession();

    return res.json({
      success: true,
      transactionId: tx._id.toString(),
      newReceiver: {
        id: newReceiver._id,
        email: newReceiver.email,
      },
    });
  } catch (err) {
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    next(err);
  }
}

async function archiveController(req, res, next) {
  try {
    const { transactionId } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx) throw createError(404, "Transaction non trouvée");
    if (tx.archived) throw createError(400, "Déjà archivée");

    tx.archived = true;
    tx.archivedAt = new Date();
    tx.archivedBy = req.user?.email || req.user?.id || null;
    tx.providerStatus = tx.providerStatus || "ARCHIVED";
    await tx.save();

    return res.json({
      success: true,
      transactionId: tx._id.toString(),
      archived: true,
    });
  } catch (err) {
    next(err);
  }
}

async function relaunchController(req, res, next) {
  try {
    const { transactionId } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx) throw createError(404, "Transaction non trouvée");

    if (!["pending", "cancelled", "locked", "failed"].includes(tx.status)) {
      throw createError(
        400,
        "Seules les transactions pending/cancelled/locked/failed peuvent être relancées"
      );
    }

    tx.status = "relaunch";
    tx.relaunchedAt = new Date();
    tx.relaunchedBy = req.user?.email || req.user?.id || null;
    tx.relaunchCount = (tx.relaunchCount || 0) + 1;
    tx.providerStatus = "RELAUNCH_REQUESTED";
    await tx.save();

    return res.json({
      success: true,
      transactionId: tx._id.toString(),
      relaunched: true,
      status: tx.status,
      providerStatus: tx.providerStatus,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  refundController,
  validateController,
  reassignController,
  archiveController,
  relaunchController,
};