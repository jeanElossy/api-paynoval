// "use strict";

// const createError = require("http-errors");

// const {
//   Transaction,
//   logTransaction,
//   releaseSenderReserve,
//   chargeCancellationFee,
//   convertAmount,
//   resolveTreasuryFromSystemType,
//   normalizeTreasurySystemType,
//   startTxSession,
//   maybeSessionOpts,
//   canUseSharedSession,
//   assertTransition,
// } = require("../shared/runtime");

// const { notifyTransactionEvent } = require("../transactionNotificationService");
// const { sanitize, toFloat, round2 } = require("../shared/helpers");

// const INTERNAL_FLOW = "PAYNOVAL_INTERNAL_TRANSFER";
// const OUTBOUND_EXTERNAL_FLOWS = new Set([
//   "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
//   "PAYNOVAL_TO_BANK_PAYOUT",
//   "PAYNOVAL_TO_CARD_PAYOUT",
// ]);

// const FEES_TREASURY_SYSTEM_TYPE = "FEES_TREASURY";
// const FEES_TREASURY_LABEL = "PayNoval Fees Treasury";
// const FEES_TREASURY_DEFAULT_CURRENCY = String(
//   process.env.FEES_TREASURY_DEFAULT_CURRENCY || "CAD"
// )
//   .trim()
//   .toUpperCase();

// function isInternalTransfer(tx) {
//   return tx?.flow === INTERNAL_FLOW;
// }

// function isOutboundExternalPayout(tx) {
//   return OUTBOUND_EXTERNAL_FLOWS.has(String(tx?.flow || ""));
// }

// function resolveFeesTreasuryMeta(tx) {
//   const treasurySystemType = normalizeTreasurySystemType(
//     tx?.treasurySystemType || FEES_TREASURY_SYSTEM_TYPE
//   );

//   const treasuryUserId = String(
//     tx?.treasuryUserId || resolveTreasuryFromSystemType(treasurySystemType) || ""
//   ).trim();

//   const treasuryLabel = String(
//     tx?.treasuryLabel || FEES_TREASURY_LABEL
//   ).trim();

//   if (!treasuryUserId) {
//     throw createError(
//       500,
//       `Treasury introuvable pour ${treasurySystemType}`
//     );
//   }

//   return {
//     treasuryUserId,
//     treasurySystemType,
//     treasuryLabel,
//   };
// }

// function getStaticCancellationFee(sourceCurrency) {
//   const c = String(sourceCurrency || "").trim().toUpperCase();

//   if (["XOF", "XAF"].includes(c)) {
//     return {
//       amount: 300,
//       type: "fixed",
//       percent: 0,
//       feeId: null,
//       source: "STATIC_CANCEL_300",
//     };
//   }

//   if (["CAD", "USD", "EUR"].includes(c)) {
//     return {
//       amount: 2.99,
//       type: "fixed",
//       percent: 0,
//       feeId: null,
//       source: "STATIC_CANCEL_2_99",
//     };
//   }

//   return {
//     amount: 0,
//     type: "fixed",
//     percent: 0,
//     feeId: null,
//     source: "STATIC_CANCEL_0",
//   };
// }

// async function resolveTreasuryCreditInCad({
//   cancellationFee,
//   sourceCurrency,
// }) {
//   let treasuryFeeAmount = cancellationFee;
//   let treasuryFeeCurrency = sourceCurrency;
//   let treasuryConversionRate = 1;

//   if (cancellationFee <= 0) {
//     return {
//       treasuryFeeAmount,
//       treasuryFeeCurrency,
//       treasuryConversionRate,
//     };
//   }

//   if (
//     FEES_TREASURY_DEFAULT_CURRENCY &&
//     FEES_TREASURY_DEFAULT_CURRENCY !== sourceCurrency
//   ) {
//     try {
//       const converted = await convertAmount(
//         sourceCurrency,
//         FEES_TREASURY_DEFAULT_CURRENCY,
//         cancellationFee
//       );

//       const convertedAmount = round2(toFloat(converted?.converted, 0));
//       const convertedRate = Number(converted?.rate || 0) || 0;

//       if (convertedAmount > 0) {
//         treasuryFeeAmount = convertedAmount;
//         treasuryFeeCurrency = FEES_TREASURY_DEFAULT_CURRENCY;
//         treasuryConversionRate = convertedRate || 1;
//       }
//     } catch {
//       treasuryFeeAmount = cancellationFee;
//       treasuryFeeCurrency = sourceCurrency;
//       treasuryConversionRate = 1;
//     }
//   }

//   return {
//     treasuryFeeAmount,
//     treasuryFeeCurrency,
//     treasuryConversionRate,
//   };
// }

// async function cancelController(req, res, next) {
//   const session = await startTxSession();

//   try {
//     if (canUseSharedSession()) session.startTransaction();

//     const { transactionId, reason = "Annulé" } = req.body || {};
//     if (!transactionId) {
//       throw createError(400, "transactionId requis pour annuler");
//     }

//     const sessOpts = maybeSessionOpts(session);

//     const tx = await Transaction.findById(transactionId)
//       .select([
//         "+reference",
//         "+flow",
//         "+provider",
//         "+providerStatus",
//         "+providerReference",
//         "+amount",
//         "+netAmount",
//         "+senderCurrencySymbol",
//         "+sender",
//         "+receiver",
//         "+status",
//         "+funds",
//         "+recipientEmail",
//         "+fundsReserved",
//         "+fundsCaptured",
//         "+reserveReleased",
//         "+reserveReleasedAt",
//         "+beneficiaryCredited",
//         "+cancellationFee",
//         "+cancellationFeeType",
//         "+cancellationFeePercent",
//         "+cancellationFeeId",
//         "+treasuryUserId",
//         "+treasurySystemType",
//         "+treasuryLabel",
//         "+meta",
//       ])
//       .session(sessOpts.session || null);

//     if (!tx) throw createError(404, "Transaction introuvable");

//     logTransaction({
//       userId: req.user?.id || req.user?._id || null,
//       type: "cancel",
//       provider: tx.provider || tx.funds || "paynoval",
//       amount: toFloat(tx.amount),
//       currency: tx.senderCurrencySymbol,
//       toEmail: tx.recipientEmail || "",
//       details: {
//         transactionId: tx._id.toString(),
//         reason,
//         flow: tx.flow,
//         treasurySystemType: FEES_TREASURY_SYSTEM_TYPE,
//       },
//       flagged: false,
//       flagReason: "",
//       transactionId: tx._id,
//       ip: req.ip,
//     }).catch(() => {});

//     assertTransition(tx.status, "cancelled");

//     const userId = String(req.user?.id || req.user?._id || "");
//     const senderId = String(tx.sender || "");
//     const receiverId = String(tx.receiver || "");

//     if (isInternalTransfer(tx)) {
//       if (userId !== senderId && userId !== receiverId) {
//         throw createError(403, "Vous n’êtes pas autorisé à annuler");
//       }
//     } else if (isOutboundExternalPayout(tx)) {
//       if (userId !== senderId) {
//         throw createError(403, "Seul l’expéditeur peut annuler cette transaction");
//       }
//     } else {
//       throw createError(400, `Flow non supporté pour cancel: ${tx.flow}`);
//     }

//     if (tx.fundsCaptured || tx.beneficiaryCredited) {
//       throw createError(409, "Transaction déjà exécutée, annulation impossible");
//     }

//     const grossSource = round2(toFloat(tx.amount));
//     const netStored = round2(toFloat(tx.netAmount));
//     const sourceCurrency = String(tx.senderCurrencySymbol || "")
//       .trim()
//       .toUpperCase();

//     if (!sourceCurrency) {
//       throw createError(500, "Devise source introuvable sur la transaction");
//     }

//     const staticFee = getStaticCancellationFee(sourceCurrency);

//     const cancellationFee = round2(staticFee.amount);
//     const cancellationFeeType = staticFee.type || "fixed";
//     const cancellationFeePercent = Number(staticFee.percent || 0) || 0;
//     const cancellationFeeId = null;
//     const cancellationFeeSource = staticFee.source || "static_rule";

//     if (cancellationFee > grossSource) {
//       throw createError(400, "Frais d’annulation supérieurs au montant réservé");
//     }

//     if (cancellationFee > netStored && netStored > 0) {
//       throw createError(400, "Frais d’annulation supérieurs au net à rembourser");
//     }

//     if (tx.fundsReserved && !tx.reserveReleased) {
//       await releaseSenderReserve({
//         transaction: tx,
//         senderId: tx.sender,
//         amount: grossSource,
//         currency: sourceCurrency,
//         session,
//       });

//       tx.reserveReleased = true;
//       tx.reserveReleasedAt = new Date();
//     }

//     const treasuryMeta =
//       cancellationFee > 0 ? resolveFeesTreasuryMeta(tx) : null;

//     const {
//       treasuryFeeAmount,
//       treasuryFeeCurrency,
//       treasuryConversionRate,
//     } = await resolveTreasuryCreditInCad({
//       cancellationFee,
//       sourceCurrency,
//     });

//     let feeChargeResult = null;

//     if (cancellationFee > 0 && treasuryMeta?.treasuryUserId) {
//       feeChargeResult = await chargeCancellationFee({
//         transaction: tx,
//         senderId: tx.sender,
//         senderCurrency: sourceCurrency,
//         feeSourceAmount: cancellationFee,
//         treasuryUserId: treasuryMeta.treasuryUserId,
//         treasurySystemType: treasuryMeta.treasurySystemType,
//         treasuryLabel: treasuryMeta.treasuryLabel,
//         treasuryFeeAmount,
//         treasuryFeeCurrency,
//         conversionRateToTreasury: treasuryConversionRate,
//         feeType: cancellationFeeType,
//         feePercent: cancellationFeePercent,
//         feeId: cancellationFeeId,
//         session,
//       });
//     }

//     tx.status = "cancelled";
//     tx.cancelledAt = new Date();

//     if (isInternalTransfer(tx) && userId === receiverId) {
//       tx.cancelReason = `Annulé par le destinataire : ${sanitize(reason)}`;
//       tx.providerStatus = "CANCELLED_BY_RECEIVER";
//     } else {
//       tx.cancelReason = `Annulé par l’expéditeur : ${sanitize(reason)}`;
//       tx.providerStatus = "CANCELLED_BY_SENDER";
//     }

//     tx.cancellationFee = cancellationFee;
//     tx.cancellationFeeType = cancellationFeeType;
//     tx.cancellationFeePercent = cancellationFeePercent;
//     tx.cancellationFeeId = cancellationFeeId;

//     if (treasuryMeta) {
//       tx.treasuryUserId = treasuryMeta.treasuryUserId;
//       tx.treasurySystemType = treasuryMeta.treasurySystemType;
//       tx.treasuryLabel = treasuryMeta.treasuryLabel;
//     } else {
//       tx.treasuryUserId = tx.treasuryUserId || null;
//       tx.treasurySystemType =
//         tx.treasurySystemType || FEES_TREASURY_SYSTEM_TYPE;
//       tx.treasuryLabel = tx.treasuryLabel || FEES_TREASURY_LABEL;
//     }

//     const prevMeta =
//       tx.meta && typeof tx.meta === "object" && !Array.isArray(tx.meta)
//         ? tx.meta
//         : {};

//     tx.meta = {
//       ...prevMeta,
//       cancellationFeeSource,
//       cancellationFeeResolvedAt: new Date().toISOString(),
//       treasuryFeeAmount,
//       treasuryFeeCurrency,
//       treasuryConversionRate,
//       feesTreasuryDefaultCurrency: FEES_TREASURY_DEFAULT_CURRENCY,
//     };

//     await tx.save(sessOpts);

//     await notifyTransactionEvent(tx, "cancelled", session, sourceCurrency);

//     if (canUseSharedSession()) await session.commitTransaction();
//     session.endSession();

//     return res.json({
//       success: true,
//       transactionId: tx._id.toString(),
//       reference: tx.reference,
//       flow: tx.flow,
//       status: tx.status,
//       providerStatus: tx.providerStatus,
//       reserveReleased: !!tx.reserveReleased,
//       releasedAmount: grossSource,
//       refundedToSenderAfterFee: round2(grossSource - cancellationFee),
//       currency: sourceCurrency,
//       cancellationFeeInSenderCurrency: cancellationFee,
//       cancellationFeeType,
//       cancellationFeePercent,
//       cancellationFeeId,
//       cancellationFeeSource,
//       treasuryFeeCredited: treasuryFeeAmount,
//       treasuryFeeCurrency,
//       treasuryConversionRate,
//       treasuryUserId: treasuryMeta?.treasuryUserId || tx.treasuryUserId || null,
//       treasurySystemType:
//         treasuryMeta?.treasurySystemType || tx.treasurySystemType || FEES_TREASURY_SYSTEM_TYPE,
//       treasuryLabel:
//         treasuryMeta?.treasuryLabel || tx.treasuryLabel || FEES_TREASURY_LABEL,
//       feeChargeResult: feeChargeResult || null,
//     });
//   } catch (err) {
//     try {
//       if (canUseSharedSession()) await session.abortTransaction();
//     } catch {}
//     session.endSession();
//     next(err);
//   }
// }

// module.exports = { cancelController };









// File: src/services/transactions/handlers/cancelController.js
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
  startTxSession,
  maybeSessionOpts,
  canUseSharedSession,
  assertTransition,
} = require("../shared/runtime");

const { notifyTransactionEvent } = require("../transactionNotificationService");
const { sanitize, toFloat, round2 } = require("../shared/helpers");

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

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function isInternalTransfer(tx) {
  return tx?.flow === INTERNAL_FLOW;
}

function isOutboundExternalPayout(tx) {
  return OUTBOUND_EXTERNAL_FLOWS.has(String(tx?.flow || ""));
}

function isSandboxTx(tx) {
  return Boolean(
    tx?.isSandbox === true ||
      String(tx?.provider || "").toLowerCase() === "sandbox" ||
      String(tx?.channel || "").toLowerCase() === "sandbox" ||
      tx?.metadata?.source === "apple_review_sandbox" ||
      tx?.meta?.source === "apple_review_sandbox" ||
      tx?.meta?.sandbox === true ||
      tx?.metadata?.sandbox === true
  );
}

function getAuthedUserId(req) {
  return String(req.user?.id || req.user?._id || req.user?.userId || "").trim();
}

function assertTxOwner({ req, tx }) {
  const userId = getAuthedUserId(req);

  const allowedIds = [
    tx?.sender,
    tx?.receiver,
    tx?.receiverUserId,
    tx?.createdBy,
    tx?.ownerUserId,
    tx?.userId,
    tx?.user,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  if (!userId || !allowedIds.includes(userId)) {
    throw createError(403, "Vous n’êtes pas autorisé à annuler cette transaction.");
  }
}

function isSandboxFinalStatus(status) {
  return ["completed", "confirmed", "success", "cancelled", "canceled"].includes(
    normalizeStatus(status)
  );
}

async function endQuietly(session) {
  try {
    if (session) session.endSession();
  } catch (_) {}
}

async function abortQuietly(session) {
  try {
    if (session && canUseSharedSession()) {
      await session.abortTransaction();
    }
  } catch (_) {}
}

async function handleSandboxCancel({ req, res, tx, reason, sessOpts, session }) {
  assertTxOwner({ req, tx });

  if (isSandboxFinalStatus(tx.status)) {
    throw createError(
      409,
      "Transaction sandbox déjà terminée, annulation impossible."
    );
  }

  const now = new Date();
  const safeReason = sanitize(reason || "Annulé");

  tx.status = "cancelled";
  tx.provider = "sandbox";
  tx.channel = "sandbox";
  tx.providerStatus = "sandbox_cancelled";
  tx.cancelledAt = now;
  tx.cancelReason = `Annulé en mode sandbox : ${safeReason}`;
  tx.isSandbox = true;

  tx.cancellationFee = 0;
  tx.cancellationFeeType = "fixed";
  tx.cancellationFeePercent = 0;
  tx.cancellationFeeId = null;

  tx.reserveReleased = tx.reserveReleased === true ? true : false;
  tx.fundsCaptured = tx.fundsCaptured === true ? true : false;
  tx.beneficiaryCredited = tx.beneficiaryCredited === true ? true : false;

  tx.metadata = {
    ...(tx.metadata || {}),
    sandbox: true,
    sandboxCancel: {
      skippedFinancialOperations: true,
      reason: "SANDBOX_NO_REAL_RESERVE_NO_REAL_TREASURY",
      at: now.toISOString(),
    },
  };

  tx.meta = {
    ...(tx.meta || {}),
    sandbox: true,
    cancellationFeeSource: "SANDBOX_NO_FEE",
    providerExecutionSkipped: true,
  };

  await tx.save(sessOpts);

  if (canUseSharedSession()) {
    await session.commitTransaction();
  }

  await endQuietly(session);

  return res.json({
    success: true,
    sandbox: true,
    transactionId: tx._id.toString(),
    reference: tx.reference,
    flow: tx.flow,
    status: tx.status,
    providerStatus: tx.providerStatus,
    reserveReleased: false,
    releasedAmount: 0,
    refundedToSenderAfterFee: 0,
    currency: tx.senderCurrencySymbol || tx.currencySource || null,
    cancellationFeeInSenderCurrency: 0,
    cancellationFeeType: "fixed",
    cancellationFeePercent: 0,
    cancellationFeeSource: "SANDBOX_NO_FEE",
    treasuryFeeCredited: 0,
    treasuryFeeCurrency: null,
    treasuryConversionRate: 1,
    treasuryUserId: null,
    treasurySystemType: null,
    treasuryLabel: null,
    feeChargeResult: null,
    message: "Transaction sandbox annulée sans frais.",
  });
}

function resolveFeesTreasuryMeta(tx) {
  const treasurySystemType = normalizeTreasurySystemType(
    tx?.treasurySystemType || FEES_TREASURY_SYSTEM_TYPE
  );

  const treasuryUserId = String(
    tx?.treasuryUserId || resolveTreasuryFromSystemType(treasurySystemType) || ""
  ).trim();

  const treasuryLabel = String(tx?.treasuryLabel || FEES_TREASURY_LABEL).trim();

  if (!treasuryUserId) {
    throw createError(500, `Treasury introuvable pour ${treasurySystemType}`);
  }

  return {
    treasuryUserId,
    treasurySystemType,
    treasuryLabel,
  };
}

function getStaticCancellationFee(sourceCurrency) {
  const c = String(sourceCurrency || "").trim().toUpperCase();

  if (["XOF", "XAF"].includes(c)) {
    return {
      amount: 300,
      type: "fixed",
      percent: 0,
      feeId: null,
      source: "STATIC_CANCEL_300",
    };
  }

  if (["CAD", "USD", "EUR"].includes(c)) {
    return {
      amount: 2.99,
      type: "fixed",
      percent: 0,
      feeId: null,
      source: "STATIC_CANCEL_2_99",
    };
  }

  return {
    amount: 0,
    type: "fixed",
    percent: 0,
    feeId: null,
    source: "STATIC_CANCEL_0",
  };
}

async function resolveTreasuryCreditInCad({ cancellationFee, sourceCurrency }) {
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
    try {
      const converted = await convertAmount(
        sourceCurrency,
        FEES_TREASURY_DEFAULT_CURRENCY,
        cancellationFee
      );

      const convertedAmount = round2(toFloat(converted?.converted, 0));
      const convertedRate = Number(converted?.rate || 0) || 0;

      if (convertedAmount > 0) {
        treasuryFeeAmount = convertedAmount;
        treasuryFeeCurrency = FEES_TREASURY_DEFAULT_CURRENCY;
        treasuryConversionRate = convertedRate || 1;
      }
    } catch {
      treasuryFeeAmount = cancellationFee;
      treasuryFeeCurrency = sourceCurrency;
      treasuryConversionRate = 1;
    }
  }

  return {
    treasuryFeeAmount,
    treasuryFeeCurrency,
    treasuryConversionRate,
  };
}

async function cancelController(req, res, next) {
  const session = await startTxSession();

  try {
    if (canUseSharedSession()) {
      session.startTransaction();
    }

    const { transactionId, reason = "Annulé" } = req.body || {};

    if (!transactionId) {
      throw createError(400, "transactionId requis pour annuler");
    }

    const sessOpts = maybeSessionOpts(session);

    const tx = await Transaction.findById(transactionId)
      .select([
        "+reference",
        "+flow",
        "+provider",
        "+channel",
        "+providerStatus",
        "+providerReference",
        "+isSandbox",

        "+amount",
        "+netAmount",
        "+senderCurrencySymbol",
        "+currencySource",

        "+sender",
        "+receiver",
        "+receiverUserId",
        "+createdBy",
        "+ownerUserId",
        "+userId",
        "+user",

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

        "+cancelledAt",
        "+cancelReason",

        "+metadata",
        "+meta",
      ])
      .session(sessOpts.session || null);

    if (!tx) {
      throw createError(404, "Transaction introuvable");
    }

    if (isSandboxTx(tx)) {
      return handleSandboxCancel({
        req,
        res,
        tx,
        reason,
        sessOpts,
        session,
      });
    }

    logTransaction({
      userId: getAuthedUserId(req) || null,
      type: "cancel",
      provider: tx.provider || tx.funds || "paynoval",
      amount: toFloat(tx.amount),
      currency: tx.senderCurrencySymbol,
      toEmail: tx.recipientEmail || "",
      details: {
        transactionId: tx._id.toString(),
        reason,
        flow: tx.flow,
        treasurySystemType: FEES_TREASURY_SYSTEM_TYPE,
      },
      flagged: false,
      flagReason: "",
      transactionId: tx._id,
      ip: req.ip,
    }).catch(() => {});

    assertTransition(tx.status, "cancelled");

    const userId = getAuthedUserId(req);
    const senderId = String(tx.sender || "");
    const receiverId = String(tx.receiver || "");

    if (isInternalTransfer(tx)) {
      if (userId !== senderId && userId !== receiverId) {
        throw createError(403, "Vous n’êtes pas autorisé à annuler");
      }
    } else if (isOutboundExternalPayout(tx)) {
      if (userId !== senderId) {
        throw createError(
          403,
          "Seul l’expéditeur peut annuler cette transaction"
        );
      }
    } else {
      throw createError(400, `Flow non supporté pour cancel: ${tx.flow}`);
    }

    if (tx.fundsCaptured || tx.beneficiaryCredited) {
      throw createError(409, "Transaction déjà exécutée, annulation impossible");
    }

    const grossSource = round2(toFloat(tx.amount));
    const netStored = round2(toFloat(tx.netAmount));
    const sourceCurrency = String(tx.senderCurrencySymbol || tx.currencySource || "")
      .trim()
      .toUpperCase();

    if (!sourceCurrency) {
      throw createError(500, "Devise source introuvable sur la transaction");
    }

    const staticFee = getStaticCancellationFee(sourceCurrency);

    const cancellationFee = round2(staticFee.amount);
    const cancellationFeeType = staticFee.type || "fixed";
    const cancellationFeePercent = Number(staticFee.percent || 0) || 0;
    const cancellationFeeId = null;
    const cancellationFeeSource = staticFee.source || "static_rule";

    if (cancellationFee > grossSource) {
      throw createError(400, "Frais d’annulation supérieurs au montant réservé");
    }

    if (cancellationFee > netStored && netStored > 0) {
      throw createError(
        400,
        "Frais d’annulation supérieurs au net à rembourser"
      );
    }

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

    const treasuryMeta =
      cancellationFee > 0 ? resolveFeesTreasuryMeta(tx) : null;

    const {
      treasuryFeeAmount,
      treasuryFeeCurrency,
      treasuryConversionRate,
    } = await resolveTreasuryCreditInCad({
      cancellationFee,
      sourceCurrency,
    });

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
        feeType: cancellationFeeType,
        feePercent: cancellationFeePercent,
        feeId: cancellationFeeId,
        session,
      });
    }

    tx.status = "cancelled";
    tx.cancelledAt = new Date();

    if (isInternalTransfer(tx) && userId === receiverId) {
      tx.cancelReason = `Annulé par le destinataire : ${sanitize(reason)}`;
      tx.providerStatus = "CANCELLED_BY_RECEIVER";
    } else {
      tx.cancelReason = `Annulé par l’expéditeur : ${sanitize(reason)}`;
      tx.providerStatus = "CANCELLED_BY_SENDER";
    }

    tx.cancellationFee = cancellationFee;
    tx.cancellationFeeType = cancellationFeeType;
    tx.cancellationFeePercent = cancellationFeePercent;
    tx.cancellationFeeId = cancellationFeeId;

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
      cancellationFeeSource,
      cancellationFeeResolvedAt: new Date().toISOString(),
      treasuryFeeAmount,
      treasuryFeeCurrency,
      treasuryConversionRate,
      feesTreasuryDefaultCurrency: FEES_TREASURY_DEFAULT_CURRENCY,
    };

    await tx.save(sessOpts);

    await notifyTransactionEvent(tx, "cancelled", session, sourceCurrency);

    if (canUseSharedSession()) {
      await session.commitTransaction();
    }

    await endQuietly(session);

    return res.json({
      success: true,
      transactionId: tx._id.toString(),
      reference: tx.reference,
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      reserveReleased: !!tx.reserveReleased,
      releasedAmount: grossSource,
      refundedToSenderAfterFee: round2(grossSource - cancellationFee),
      currency: sourceCurrency,
      cancellationFeeInSenderCurrency: cancellationFee,
      cancellationFeeType,
      cancellationFeePercent,
      cancellationFeeId,
      cancellationFeeSource,
      treasuryFeeCredited: treasuryFeeAmount,
      treasuryFeeCurrency,
      treasuryConversionRate,
      treasuryUserId: treasuryMeta?.treasuryUserId || tx.treasuryUserId || null,
      treasurySystemType:
        treasuryMeta?.treasurySystemType ||
        tx.treasurySystemType ||
        FEES_TREASURY_SYSTEM_TYPE,
      treasuryLabel:
        treasuryMeta?.treasuryLabel ||
        tx.treasuryLabel ||
        FEES_TREASURY_LABEL,
      feeChargeResult: feeChargeResult || null,
    });
  } catch (err) {
    await abortQuietly(session);
    await endQuietly(session);
    next(err);
  }
}

module.exports = { cancelController };