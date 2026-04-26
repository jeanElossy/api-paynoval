// File: services/cancellation.service.js

"use strict";

const createError = require("http-errors");

const {
  Transaction,
  logTransaction,
  releaseSenderReserve,
  chargeCancellationFee,
  convertAmount,
  resolveTreasuryFromSystemType,
  normalizeTreasurySystemType,
  maybeSessionOpts,
  assertTransition,
} = require("../services/transactions/shared/runtime");

const { notifyTransactionEvent } = require("../services/transactions/transactionNotificationService");
const { sanitize, toFloat, round2 } = require("../services/transactions/shared/helpers");

const TxRefundRequestFactory = require("../models/TxRefundRequest");

const {
  normalizeCurrency,
  roundMoney,
  extractSenderCountryCode,
  resolveCancellationFeeRule,
} = require("../config/cancellationFees");

const INTERNAL_FLOW = "PAYNOVAL_INTERNAL_TRANSFER";

const OUTBOUND_EXTERNAL_FLOWS = new Set([
  "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  "PAYNOVAL_TO_BANK_PAYOUT",
  "PAYNOVAL_TO_CARD_PAYOUT",
]);

const FEES_TREASURY_SYSTEM_TYPE = "FEES_TREASURY";
const FEES_TREASURY_LABEL = "PayNoval Fees Treasury";

const FEES_TREASURY_DEFAULT_CURRENCY = String(
  process.env.FEES_TREASURY_DEFAULT_CURRENCY || "CAD"
)
  .trim()
  .toUpperCase();

const ADMIN_CANCEL_REFUND_STATUS = String(
  process.env.TX_CANCEL_REFUND_STATUS || "cancelled"
)
  .trim()
  .toLowerCase();

function getRefundRequestModel() {
  const conn = Transaction?.db || undefined;
  return TxRefundRequestFactory(conn);
}

function isInternalTransfer(tx) {
  return tx?.flow === INTERNAL_FLOW;
}

function isOutboundExternalPayout(tx) {
  return OUTBOUND_EXTERNAL_FLOWS.has(String(tx?.flow || ""));
}

function resolveFeesTreasuryMeta(tx) {
  const treasurySystemType = normalizeTreasurySystemType(
    tx?.treasurySystemType || FEES_TREASURY_SYSTEM_TYPE
  );

  const treasuryUserId = String(
    tx?.treasuryUserId ||
      resolveTreasuryFromSystemType(treasurySystemType) ||
      ""
  ).trim();

  const treasuryLabel = String(
    tx?.treasuryLabel || FEES_TREASURY_LABEL
  ).trim();

  if (!treasuryUserId) {
    throw createError(500, `Treasury introuvable pour ${treasurySystemType}`);
  }

  return {
    treasuryUserId,
    treasurySystemType,
    treasuryLabel,
  };
}

function buildIdempotencyKey(transactionId, idempotencyKey) {
  const provided = String(idempotencyKey || "").trim();
  if (provided) return provided;

  return `cancel-refund:${String(transactionId)}`;
}

function buildRequestedBy(requestedBy = {}) {
  return {
    id: requestedBy?.id ? String(requestedBy.id) : null,
    email: requestedBy?.email ? String(requestedBy.email) : null,
    role: requestedBy?.role ? String(requestedBy.role) : null,
    source: requestedBy?.source || requestedBy?.role || "support",
  };
}

function ensureSupportedFlowForAdmin(tx) {
  if (isInternalTransfer(tx)) return true;
  if (isOutboundExternalPayout(tx)) return true;

  throw createError(400, `Flow non supporté pour annulation/remboursement: ${tx.flow}`);
}

function ensureTransactionCanBeAutoCancelled(tx) {
  if (tx.fundsCaptured || tx.beneficiaryCredited) {
    return false;
  }

  return true;
}

function getSourceCurrency(tx) {
  const currency = normalizeCurrency(
    tx?.senderCurrencySymbol ||
      tx?.senderCurrency ||
      tx?.sourceCurrency ||
      tx?.currency
  );

  if (!currency) {
    throw createError(500, "Devise source introuvable sur la transaction");
  }

  return currency;
}

async function resolveCancellationFeeAmounts({
  tx,
  sourceCurrency,
  grossSource,
}) {
  const senderCountryCode = extractSenderCountryCode(tx);

  const rule = resolveCancellationFeeRule({
    countryCode: senderCountryCode,
    currency: sourceCurrency,
  });

  let cancellationFee = roundMoney(rule.amount, rule.currency);
  let feeSourceCurrency = normalizeCurrency(rule.currency || sourceCurrency);
  let feeConversionRateToSource = 1;

  if (
    cancellationFee > 0 &&
    feeSourceCurrency &&
    feeSourceCurrency !== sourceCurrency
  ) {
    const converted = await convertAmount(
      feeSourceCurrency,
      sourceCurrency,
      cancellationFee
    );

    const convertedAmount = Number(converted?.converted || 0);
    const convertedRate = Number(converted?.rate || 0);

    if (!Number.isFinite(convertedAmount) || convertedAmount <= 0) {
      throw createError(
        500,
        "Impossible de convertir les frais d’annulation dans la devise du client"
      );
    }

    cancellationFee = roundMoney(convertedAmount, sourceCurrency);
    feeConversionRateToSource = convertedRate || 1;
    feeSourceCurrency = sourceCurrency;
  } else {
    cancellationFee = roundMoney(cancellationFee, sourceCurrency);
  }

  if (cancellationFee > grossSource) {
    throw createError(400, "Frais d’annulation supérieurs au montant réservé");
  }

  return {
    senderCountryCode,
    cancellationFee,
    cancellationFeeType: rule.type || "fixed",
    cancellationFeePercent: Number(rule.percent || 0) || 0,
    cancellationFeeId: rule.feeId || null,
    cancellationFeeSource: rule.source || "static_rule",
    cancellationFeeLabel: rule.label || `${cancellationFee} ${sourceCurrency}`,
    cancellationFeeResolvedBy: rule.resolvedBy || "none",
    feeSourceCurrency,
    feeConversionRateToSource,
  };
}

async function resolveTreasuryCreditAmount({
  cancellationFee,
  sourceCurrency,
}) {
  let treasuryFeeAmount = cancellationFee;
  let treasuryFeeCurrency = sourceCurrency;
  let treasuryConversionRate = 1;

  if (cancellationFee <= 0) {
    return {
      treasuryFeeAmount,
      treasuryFeeCurrency,
      treasuryConversionRate,
    };
  }

  if (
    FEES_TREASURY_DEFAULT_CURRENCY &&
    FEES_TREASURY_DEFAULT_CURRENCY !== sourceCurrency
  ) {
    const converted = await convertAmount(
      sourceCurrency,
      FEES_TREASURY_DEFAULT_CURRENCY,
      cancellationFee
    );

    const convertedAmount = Number(converted?.converted || 0);
    const convertedRate = Number(converted?.rate || 0);

    if (Number.isFinite(convertedAmount) && convertedAmount > 0) {
      treasuryFeeAmount = roundMoney(
        convertedAmount,
        FEES_TREASURY_DEFAULT_CURRENCY
      );
      treasuryFeeCurrency = FEES_TREASURY_DEFAULT_CURRENCY;
      treasuryConversionRate = convertedRate || 1;
    }
  }

  return {
    treasuryFeeAmount,
    treasuryFeeCurrency,
    treasuryConversionRate,
  };
}

async function loadTransactionForCancellation(transactionId, session) {
  const sessOpts = maybeSessionOpts(session);

  return Transaction.findById(transactionId)
    .select([
      "+reference",
      "+flow",
      "+provider",
      "+providerStatus",
      "+providerReference",
      "+amount",
      "+netAmount",
      "+senderCurrencySymbol",
      "+senderCurrency",
      "+sourceCurrency",
      "+currency",
      "+sender",
      "+receiver",
      "+status",
      "+funds",
      "+recipientEmail",
      "+fundsReserved",
      "+fundsCaptured",
      "+reserveReleased",
      "+reserveReleasedAt",
      "+beneficiaryCredited",
      "+cancellationFee",
      "+cancellationFeeType",
      "+cancellationFeePercent",
      "+cancellationFeeId",
      "+treasuryUserId",
      "+treasurySystemType",
      "+treasuryLabel",
      "+senderCountryCode",
      "+senderCountry",
      "+sourceCountryCode",
      "+sourceCountry",
      "+fromCountryCode",
      "+fromCountry",
      "+senderSnapshot",
      "+meta",
    ])
    .session(sessOpts.session || null);
}

async function findExistingRefundRequest(transactionId, session) {
  const RefundRequest = getRefundRequestModel();
  const sessOpts = maybeSessionOpts(session);

  return RefundRequest.findOne({
    transactionId: String(transactionId),
    type: "cancellation_refund",
  }).session(sessOpts.session || null);
}

async function createRefundRequestProcessing({
  tx,
  sourceCurrency,
  senderCountryCode,
  grossSource,
  refundAmount,
  cancellationFee,
  feeSourceCurrency,
  treasuryMeta,
  treasuryFeeAmount,
  treasuryFeeCurrency,
  reason,
  requestedBy,
  idempotencyKey,
  metadata,
  session,
}) {
  const RefundRequest = getRefundRequestModel();
  const sessOpts = maybeSessionOpts(session);

  const doc = {
    transactionId: String(tx._id),
    reference: tx.reference || null,
    sender: tx.sender,
    type: "cancellation_refund",
    status: "processing",
    currency: sourceCurrency,
    countryCode: senderCountryCode || null,
    originalAmount: grossSource,
    refundAmount,
    cancellationFee,
    feeSourceCurrency,
    treasuryFeeAmount,
    treasuryFeeCurrency,
    treasurySystemType:
      treasuryMeta?.treasurySystemType || FEES_TREASURY_SYSTEM_TYPE,
    treasuryUserId: treasuryMeta?.treasuryUserId || null,
    treasuryLabel: treasuryMeta?.treasuryLabel || FEES_TREASURY_LABEL,
    reason: sanitize(reason),
    requestedBy,
    idempotencyKey,
    metadata,
  };

  try {
    const created = await RefundRequest.create([doc], sessOpts);
    return created[0];
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await findExistingRefundRequest(tx._id, session);

      if (existing?.status === "completed") {
        return existing;
      }

      throw createError(
        409,
        "Une demande d’annulation/remboursement existe déjà pour cette transaction"
      );
    }

    throw error;
  }
}

async function createManualReviewRefundRequest({
  tx,
  sourceCurrency,
  senderCountryCode,
  grossSource,
  reason,
  requestedBy,
  idempotencyKey,
  failureReason,
  session,
}) {
  const RefundRequest = getRefundRequestModel();
  const sessOpts = maybeSessionOpts(session);

  return RefundRequest.findOneAndUpdate(
    {
      transactionId: String(tx._id),
      type: "cancellation_refund",
    },
    {
      $setOnInsert: {
        transactionId: String(tx._id),
        reference: tx.reference || null,
        sender: tx.sender,
        type: "cancellation_refund",
        currency: sourceCurrency,
        countryCode: senderCountryCode || null,
        originalAmount: grossSource,
        refundAmount: 0,
        cancellationFee: 0,
        feeSourceCurrency: sourceCurrency,
        treasuryFeeAmount: 0,
        treasuryFeeCurrency: null,
        treasurySystemType: FEES_TREASURY_SYSTEM_TYPE,
        treasuryUserId: null,
        treasuryLabel: FEES_TREASURY_LABEL,
        reason: sanitize(reason),
        requestedBy,
        idempotencyKey,
        metadata: {
          flow: tx.flow,
          provider: tx.provider || null,
          providerStatus: tx.providerStatus || null,
        },
      },
      $set: {
        status: "manual_review_required",
        failureReason,
        failedAt: new Date(),
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      ...sessOpts,
    }
  );
}

async function markRefundRequestCompleted(refundRequest, session) {
  if (!refundRequest?._id) return null;

  const RefundRequest = getRefundRequestModel();
  const sessOpts = maybeSessionOpts(session);

  return RefundRequest.findByIdAndUpdate(
    refundRequest._id,
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        failureReason: null,
      },
    },
    {
      new: true,
      ...sessOpts,
    }
  );
}

async function markRefundRequestFailed(refundRequest, error, session) {
  if (!refundRequest?._id) return null;

  const RefundRequest = getRefundRequestModel();
  const sessOpts = maybeSessionOpts(session);

  return RefundRequest.findByIdAndUpdate(
    refundRequest._id,
    {
      $set: {
        status: "failed",
        failedAt: new Date(),
        failureReason:
          error?.message || "Échec de l’annulation/remboursement",
      },
    },
    {
      new: true,
      ...sessOpts,
    }
  );
}

async function processAdminCancelRefund({
  transactionId,
  reason,
  requestedBy,
  idempotencyKey,
  ip,
  session,
  finalStatus = ADMIN_CANCEL_REFUND_STATUS,
}) {
  if (!transactionId) {
    throw createError(400, "transactionId requis pour annuler/rembourser");
  }

  const cleanReason = sanitize(reason || "");

  if (!cleanReason || cleanReason.length < 5) {
    throw createError(400, "Le motif d’annulation est obligatoire");
  }

  const tx = await loadTransactionForCancellation(transactionId, session);

  if (!tx) {
    throw createError(404, "Transaction introuvable");
  }

  ensureSupportedFlowForAdmin(tx);

  const existingRefundRequest = await findExistingRefundRequest(tx._id, session);

  if (existingRefundRequest?.status === "completed") {
    return {
      alreadyProcessed: true,
      manualReviewRequired: false,
      transactionId: String(tx._id),
      reference: tx.reference || null,
      flow: tx.flow,
      status: tx.status,
      refundRequestStatus: existingRefundRequest.status,
      refundAmount: existingRefundRequest.refundAmount,
      cancellationFee: existingRefundRequest.cancellationFee,
      currency: existingRefundRequest.currency,
      treasuryFeeAmount: existingRefundRequest.treasuryFeeAmount,
      treasuryFeeCurrency: existingRefundRequest.treasuryFeeCurrency,
      treasurySystemType: existingRefundRequest.treasurySystemType,
      treasuryUserId: existingRefundRequest.treasuryUserId,
      message: "Cette transaction a déjà été annulée/remboursée.",
    };
  }

  if (
    existingRefundRequest &&
    ["processing", "manual_review_required"].includes(existingRefundRequest.status)
  ) {
    throw createError(
      409,
      "Une demande d’annulation/remboursement est déjà en cours pour cette transaction"
    );
  }

  if (["cancelled", "cancelled_refunded", "refunded"].includes(String(tx.status))) {
    throw createError(409, "Cette transaction est déjà annulée ou remboursée");
  }

  assertTransition(tx.status, "cancelled");

  const sourceCurrency = getSourceCurrency(tx);
  const senderCountryCode = extractSenderCountryCode(tx);
  const grossSource = roundMoney(toFloat(tx.amount), sourceCurrency);
  const netStored = roundMoney(toFloat(tx.netAmount), sourceCurrency);

  if (!grossSource || grossSource <= 0) {
    throw createError(400, "Montant de transaction invalide");
  }

  const requestedByPayload = buildRequestedBy(requestedBy);

  const safeIdempotencyKey = buildIdempotencyKey(
    tx._id,
    idempotencyKey
  );

  if (!ensureTransactionCanBeAutoCancelled(tx)) {
    const manualRequest = await createManualReviewRefundRequest({
      tx,
      sourceCurrency,
      senderCountryCode,
      grossSource,
      reason: cleanReason,
      requestedBy: requestedByPayload,
      idempotencyKey: safeIdempotencyKey,
      failureReason:
        "Transaction déjà exécutée : remboursement automatique impossible",
      session,
    });

    return {
      alreadyProcessed: false,
      manualReviewRequired: true,
      transactionId: String(tx._id),
      reference: tx.reference || null,
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      refundRequestStatus: manualRequest.status,
      currency: sourceCurrency,
      originalAmount: grossSource,
      refundAmount: 0,
      cancellationFee: 0,
      message:
        "Transaction déjà exécutée. Une revue manuelle est requise avant remboursement.",
    };
  }

  const feeInfo = await resolveCancellationFeeAmounts({
    tx,
    sourceCurrency,
    grossSource,
  });

  const cancellationFee = feeInfo.cancellationFee;

  if (cancellationFee > netStored && netStored > 0) {
    throw createError(400, "Frais d’annulation supérieurs au net à rembourser");
  }

  const refundAmount = roundMoney(grossSource - cancellationFee, sourceCurrency);

  const treasuryMeta =
    cancellationFee > 0 ? resolveFeesTreasuryMeta(tx) : null;

  const {
    treasuryFeeAmount,
    treasuryFeeCurrency,
    treasuryConversionRate,
  } = await resolveTreasuryCreditAmount({
    cancellationFee,
    sourceCurrency,
  });

  const refundRequest = await createRefundRequestProcessing({
    tx,
    sourceCurrency,
    senderCountryCode,
    grossSource,
    refundAmount,
    cancellationFee,
    feeSourceCurrency: feeInfo.feeSourceCurrency,
    treasuryMeta,
    treasuryFeeAmount,
    treasuryFeeCurrency,
    reason: cleanReason,
    requestedBy: requestedByPayload,
    idempotencyKey: safeIdempotencyKey,
    metadata: {
      flow: tx.flow,
      provider: tx.provider || null,
      providerStatus: tx.providerStatus || null,
      cancellationFeeSource: feeInfo.cancellationFeeSource,
      cancellationFeeResolvedBy: feeInfo.cancellationFeeResolvedBy,
      cancellationFeeLabel: feeInfo.cancellationFeeLabel,
      feeConversionRateToSource: feeInfo.feeConversionRateToSource,
      treasuryConversionRate,
    },
    session,
  });

  try {
    if (tx.fundsReserved && !tx.reserveReleased) {
      await releaseSenderReserve({
        transaction: tx,
        senderId: tx.sender,
        amount: grossSource,
        currency: sourceCurrency,
        session,
      });

      tx.reserveReleased = true;
      tx.reserveReleasedAt = new Date();
    }

    let feeChargeResult = null;

    if (cancellationFee > 0 && treasuryMeta?.treasuryUserId) {
      feeChargeResult = await chargeCancellationFee({
        transaction: tx,
        senderId: tx.sender,
        senderCurrency: sourceCurrency,
        feeSourceAmount: cancellationFee,
        treasuryUserId: treasuryMeta.treasuryUserId,
        treasurySystemType: treasuryMeta.treasurySystemType,
        treasuryLabel: treasuryMeta.treasuryLabel,
        treasuryFeeAmount,
        treasuryFeeCurrency,
        conversionRateToTreasury: treasuryConversionRate,
        feeType: feeInfo.cancellationFeeType,
        feePercent: feeInfo.cancellationFeePercent,
        feeId: feeInfo.cancellationFeeId,
        session,
      });
    }

    tx.status = finalStatus || "cancelled";
    tx.cancelledAt = new Date();
    tx.cancelReason = `Annulé par le support : ${cleanReason}`;
    tx.providerStatus = "CANCELLED_REFUNDED_BY_SUPPORT";

    tx.cancellationFee = cancellationFee;
    tx.cancellationFeeType = feeInfo.cancellationFeeType;
    tx.cancellationFeePercent = feeInfo.cancellationFeePercent;
    tx.cancellationFeeId = feeInfo.cancellationFeeId;

    if (treasuryMeta) {
      tx.treasuryUserId = treasuryMeta.treasuryUserId;
      tx.treasurySystemType = treasuryMeta.treasurySystemType;
      tx.treasuryLabel = treasuryMeta.treasuryLabel;
    } else {
      tx.treasuryUserId = tx.treasuryUserId || null;
      tx.treasurySystemType =
        tx.treasurySystemType || FEES_TREASURY_SYSTEM_TYPE;
      tx.treasuryLabel = tx.treasuryLabel || FEES_TREASURY_LABEL;
    }

    const prevMeta =
      tx.meta && typeof tx.meta === "object" && !Array.isArray(tx.meta)
        ? tx.meta
        : {};

    tx.meta = {
      ...prevMeta,
      cancellationFeeSource: feeInfo.cancellationFeeSource,
      cancellationFeeResolvedBy: feeInfo.cancellationFeeResolvedBy,
      cancellationFeeLabel: feeInfo.cancellationFeeLabel,
      cancellationFeeResolvedAt: new Date().toISOString(),
      feeConversionRateToSource: feeInfo.feeConversionRateToSource,
      treasuryFeeAmount,
      treasuryFeeCurrency,
      treasuryConversionRate,
      feesTreasuryDefaultCurrency: FEES_TREASURY_DEFAULT_CURRENCY,
      adminCancelRefund: {
        refundRequestId: String(refundRequest._id),
        status: "completed",
        refundAmount,
        cancellationFee,
        requestedBy: requestedByPayload,
        completedAt: new Date().toISOString(),
      },
    };

    const sessOpts = maybeSessionOpts(session);
    await tx.save(sessOpts);

    const completedRefundRequest = await markRefundRequestCompleted(
      refundRequest,
      session
    );

    logTransaction({
      userId: requestedByPayload.id || null,
      type: "admin_cancel_refund",
      provider: tx.provider || tx.funds || "paynoval",
      amount: grossSource,
      currency: sourceCurrency,
      toEmail: tx.recipientEmail || "",
      details: {
        transactionId: tx._id.toString(),
        reference: tx.reference || null,
        reason: cleanReason,
        flow: tx.flow,
        refundAmount,
        cancellationFee,
        treasurySystemType:
          treasuryMeta?.treasurySystemType || FEES_TREASURY_SYSTEM_TYPE,
        requestedBy: requestedByPayload,
      },
      flagged: false,
      flagReason: "",
      transactionId: tx._id,
      ip,
    }).catch(() => {});

    await notifyTransactionEvent(tx, "cancelled", session, sourceCurrency);

    return {
      alreadyProcessed: false,
      manualReviewRequired: false,
      transactionId: String(tx._id),
      reference: tx.reference || null,
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      reserveReleased: !!tx.reserveReleased,
      releasedAmount: grossSource,
      refundAmount,
      refundedToSenderAfterFee: refundAmount,
      currency: sourceCurrency,
      cancellationFeeInSenderCurrency: cancellationFee,
      cancellationFeeType: feeInfo.cancellationFeeType,
      cancellationFeePercent: feeInfo.cancellationFeePercent,
      cancellationFeeId: feeInfo.cancellationFeeId,
      cancellationFeeSource: feeInfo.cancellationFeeSource,
      cancellationFeeResolvedBy: feeInfo.cancellationFeeResolvedBy,
      cancellationFeeLabel: feeInfo.cancellationFeeLabel,
      treasuryFeeCredited: treasuryFeeAmount,
      treasuryFeeCurrency,
      treasuryConversionRate,
      treasuryUserId: treasuryMeta?.treasuryUserId || tx.treasuryUserId || null,
      treasurySystemType:
        treasuryMeta?.treasurySystemType ||
        tx.treasurySystemType ||
        FEES_TREASURY_SYSTEM_TYPE,
      treasuryLabel:
        treasuryMeta?.treasuryLabel || tx.treasuryLabel || FEES_TREASURY_LABEL,
      refundRequestId: completedRefundRequest?._id
        ? String(completedRefundRequest._id)
        : String(refundRequest._id),
      refundRequestStatus: completedRefundRequest?.status || "completed",
      feeChargeResult: feeChargeResult || null,
    };
  } catch (error) {
    await markRefundRequestFailed(refundRequest, error, session);
    throw error;
  }
}

module.exports = {
  INTERNAL_FLOW,
  OUTBOUND_EXTERNAL_FLOWS,
  FEES_TREASURY_SYSTEM_TYPE,
  FEES_TREASURY_LABEL,
  FEES_TREASURY_DEFAULT_CURRENCY,
  isInternalTransfer,
  isOutboundExternalPayout,
  resolveFeesTreasuryMeta,
  resolveCancellationFeeAmounts,
  resolveTreasuryCreditAmount,
  processAdminCancelRefund,
};