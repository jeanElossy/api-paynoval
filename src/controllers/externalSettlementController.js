





// "use strict";

// /**
//  * Webhook settlement TX Core
//  * - SUCCESS inbound  => crédit wallet receiver local
//  * - SUCCESS outbound => confirmation finale sans crédit local receiver
//  * - FAILED outbound  => release reserve OU refund sender si déjà capturé
//  *
//  * NOTE:
//  * - Suppression de toute dépendance à admin@paynoval.com
//  * - Le crédit revenu/frais passe désormais par un treasury user id résolu par config
//  */

// const createError = require("http-errors");
// const runtime = require("../services/transactions/shared/runtime");

// const { notifyParties } = require("../services/transactions/shared/notifications");
// const { round2, toFloat } = require("../services/transactions/shared/helpers");
// const {
//   isOutboundExternalFlow,
//   isInboundExternalFlow,
// } = require("../services/transactions/handlers/flowHelpers");

// function low(v) {
//   return String(v || "").trim().toLowerCase();
// }

// function mapProviderState(payload = {}) {
//   const raw =
//     payload.status ||
//     payload.providerStatus ||
//     payload.event ||
//     payload.state ||
//     "";
//   const s = low(raw);

//   if (
//     [
//       "success",
//       "successful",
//       "completed",
//       "confirmed",
//       "paid",
//       "settled",
//       "captured",
//       "succeeded",
//       "approved",
//       "ok",
//     ].includes(s)
//   ) {
//     return "SUCCESS";
//   }

//   if (
//     [
//       "failed",
//       "failure",
//       "error",
//       "cancelled",
//       "canceled",
//       "expired",
//       "rejected",
//       "reversed",
//       "declined",
//       "voided",
//     ].includes(s)
//   ) {
//     return "FAILED";
//   }

//   return "PROCESSING";
// }

// function hasWebhookEventBeenSeen(tx, payload = {}) {
//   const eventId = String(payload.eventId || "").trim();
//   if (!eventId) return false;

//   const list = Array.isArray(tx.webhookHistory) ? tx.webhookHistory : [];
//   return list.some((entry) => String(entry?.eventId || "").trim() === eventId);
// }

// function appendWebhookHistory(tx, payload = {}) {
//   const list = Array.isArray(tx.webhookHistory) ? [...tx.webhookHistory] : [];

//   list.push({
//     at: new Date(),
//     eventId: payload.eventId || null,
//     eventType: payload.eventType || null,
//     status:
//       payload.status ||
//       payload.providerStatus ||
//       payload.event ||
//       payload.state ||
//       null,
//     providerReference:
//       payload.providerReference ||
//       payload.reference ||
//       payload.externalReference ||
//       null,
//     verified: Boolean(payload.verified),
//     payload: payload.raw || payload,
//   });

//   tx.webhookHistory = list.slice(-50);
// }

// function resolveRevenueTreasuryUserId(payload = {}) {
//   const fromPayload =
//     payload.treasuryUserId ||
//     payload.revenueTreasuryUserId ||
//     payload.raw?.treasuryUserId ||
//     payload.raw?.metadata?.treasuryUserId ||
//     payload.raw?.metadata?.revenueTreasuryUserId ||
//     null;

//   if (fromPayload) return String(fromPayload).trim();

//   const fromEnv =
//     process.env.REVENUE_TREASURY_USER_ID ||
//     process.env.ADMIN_REVENUE_TREASURY_USER_ID ||
//     process.env.ADMIN_TREASURY_USER_ID ||
//     process.env.TREASURY_USER_ID ||
//     "";

//   return String(fromEnv).trim();
// }

// function buildRevenueTreasuryMeta(payload = {}) {
//   const treasurySystemType =
//     payload.treasurySystemType ||
//     payload.raw?.treasurySystemType ||
//     payload.raw?.metadata?.treasurySystemType ||
//     "REVENUE_TREASURY";

//   const treasuryLabel =
//     payload.treasuryLabel ||
//     payload.raw?.treasuryLabel ||
//     payload.raw?.metadata?.treasuryLabel ||
//     "Revenue Treasury";

//   return {
//     treasurySystemType: String(treasurySystemType).trim(),
//     treasuryLabel: String(treasuryLabel).trim(),
//   };
// }

// async function findTransactionFromWebhook(Transaction, payload = {}, session = null) {
//   const providerReference =
//     payload.providerReference ||
//     payload.reference ||
//     payload.externalReference ||
//     null;

//   const transactionId =
//     payload.transactionId ||
//     payload.txCoreTransactionId ||
//     payload.raw?.transactionId ||
//     payload.raw?.metadata?.txCoreTransactionId ||
//     null;

//   const reference =
//     payload.reference ||
//     payload.txReference ||
//     payload.raw?.reference ||
//     payload.raw?.txReference ||
//     payload.raw?.merchantReference ||
//     payload.raw?.clientReference ||
//     payload.raw?.metadata?.txReference ||
//     payload.raw?.metadata?.txCoreReference ||
//     null;

//   if (transactionId) {
//     const byId = await Transaction.findById(transactionId).session(session || null);
//     if (byId) return byId;
//   }

//   if (providerReference) {
//     const byProviderRef = await Transaction.findOne({ providerReference }).session(
//       session || null
//     );
//     if (byProviderRef) return byProviderRef;
//   }

//   if (reference) {
//     const byReference = await Transaction.findOne({ reference }).session(session || null);
//     if (byReference) return byReference;
//   }

//   return null;
// }

// async function settleExternalTransactionWebhook(req, res, next) {
//   let session = null;

//   try {
//     const {
//       Transaction,
//       captureSenderReserve,
//       releaseSenderReserve,
//       refundSenderFunds,
//       creditReceiverFunds,
//       creditAdminRevenue,
//       startTxSession,
//       maybeSessionOpts,
//       canUseSharedSession,
//       safeCommit,
//       safeAbort,
//       safeEndSession,
//     } = runtime.getRuntime();

//     const useSharedSession = Boolean(canUseSharedSession());

//     session = await startTxSession();

//     if (useSharedSession && typeof session?.startTransaction === "function") {
//       session.startTransaction();
//     }

//     const sessOpts = maybeSessionOpts(session);
//     const payload = req.body || {};
//     const mapped = mapProviderState(payload);

//     const tx = await findTransactionFromWebhook(
//       Transaction,
//       payload,
//       sessOpts.session || null
//     );

//     if (!tx) {
//       throw createError(404, "Transaction webhook introuvable");
//     }

//     if (hasWebhookEventBeenSeen(tx, payload)) {
//       await safeCommit(session);
//       safeEndSession(session);

//       return res.status(200).json({
//         success: true,
//         duplicate: true,
//         transactionId: tx._id.toString(),
//         status: tx.status,
//         providerStatus: tx.providerStatus,
//         eventId: payload.eventId || null,
//       });
//     }

//     appendWebhookHistory(tx, payload);

//     const sourceCurrency = String(tx.senderCurrencySymbol || "").trim().toUpperCase();
//     const targetCurrency = String(tx.localCurrencySymbol || "").trim().toUpperCase();
//     const grossSource = round2(toFloat(tx.amount));
//     const targetAmount = round2(toFloat(tx.localAmount));

//     if (mapped === "PROCESSING") {
//       tx.status = "processing";
//       tx.providerStatus =
//         payload.status || payload.providerStatus || "PROVIDER_PROCESSING";

//       if (payload.providerReference || payload.reference) {
//         tx.providerReference = payload.providerReference || payload.reference;
//       }

//       await tx.save(sessOpts);

//       await safeCommit(session);
//       safeEndSession(session);

//       return res.status(202).json({
//         success: true,
//         transactionId: tx._id.toString(),
//         status: tx.status,
//         providerStatus: tx.providerStatus,
//       });
//     }

//     if (mapped === "SUCCESS") {
//       if (payload.providerReference || payload.reference) {
//         tx.providerReference = payload.providerReference || payload.reference;
//       }

//       if (isOutboundExternalFlow(tx.flow)) {
//         if (tx.fundsReserved && !tx.fundsCaptured) {
//           await captureSenderReserve({
//             transaction: tx,
//             senderId: tx.sender,
//             amount: grossSource,
//             currency: sourceCurrency,
//             session,
//           });

//           tx.fundsCaptured = true;
//           tx.fundsCapturedAt = new Date();
//         }

//         if (!tx.adminRevenueCredited) {
//           const treasuryUserId = resolveRevenueTreasuryUserId(payload);
//           const treasuryMeta = buildRevenueTreasuryMeta(payload);

//           if (!treasuryUserId) {
//             throw createError(
//               500,
//               "REVENUE_TREASURY_USER_ID introuvable pour créditer les revenus."
//             );
//           }

//           await creditAdminRevenue({
//             transaction: tx,
//             pricingSnapshot: tx.pricingSnapshot || {},
//             treasuryUserId,
//             treasurySystemType: treasuryMeta.treasurySystemType,
//             treasuryLabel: treasuryMeta.treasuryLabel,
//             session,
//           });

//           tx.adminRevenueCredited = true;
//           tx.adminRevenueCreditedAt = new Date();
//           tx.revenueTreasury = {
//             treasuryUserId,
//             treasurySystemType: treasuryMeta.treasurySystemType,
//             treasuryLabel: treasuryMeta.treasuryLabel,
//             creditedAt: new Date(),
//           };
//         }

//         tx.status = "confirmed";
//         tx.confirmedAt = new Date();
//         tx.executedAt = new Date();
//         tx.providerStatus = payload.status || payload.providerStatus || "SUCCESS";
//         tx.settlement = {
//           ...(tx.settlement || {}),
//           settledAt: new Date(),
//           providerResult: "SUCCESS",
//           eventId: payload.eventId || null,
//         };

//         await tx.save(sessOpts);
//         await notifyParties(tx, "confirmed", session, sourceCurrency);

//         await safeCommit(session);
//         safeEndSession(session);

//         return res.json({
//           success: true,
//           transactionId: tx._id.toString(),
//           flow: tx.flow,
//           status: tx.status,
//           providerStatus: tx.providerStatus,
//         });
//       }

//       if (isInboundExternalFlow(tx.flow)) {
//         if (!tx.beneficiaryCredited) {
//           await creditReceiverFunds({
//             transaction: tx,
//             receiverId: tx.receiver,
//             amount: targetAmount,
//             currency: targetCurrency,
//             session,
//           });

//           tx.beneficiaryCredited = true;
//           tx.beneficiaryCreditedAt = new Date();
//         }

//         if (!tx.adminRevenueCredited) {
//           const treasuryUserId = resolveRevenueTreasuryUserId(payload);
//           const treasuryMeta = buildRevenueTreasuryMeta(payload);

//           if (!treasuryUserId) {
//             throw createError(
//               500,
//               "REVENUE_TREASURY_USER_ID introuvable pour créditer les revenus."
//             );
//           }

//           await creditAdminRevenue({
//             transaction: tx,
//             pricingSnapshot: tx.pricingSnapshot || {},
//             treasuryUserId,
//             treasurySystemType: treasuryMeta.treasurySystemType,
//             treasuryLabel: treasuryMeta.treasuryLabel,
//             session,
//           });

//           tx.adminRevenueCredited = true;
//           tx.adminRevenueCreditedAt = new Date();
//           tx.revenueTreasury = {
//             treasuryUserId,
//             treasurySystemType: treasuryMeta.treasurySystemType,
//             treasuryLabel: treasuryMeta.treasuryLabel,
//             creditedAt: new Date(),
//           };
//         }

//         tx.status = "confirmed";
//         tx.confirmedAt = new Date();
//         tx.executedAt = new Date();
//         tx.providerStatus = payload.status || payload.providerStatus || "SUCCESS";
//         tx.settlement = {
//           ...(tx.settlement || {}),
//           settledAt: new Date(),
//           providerResult: "SUCCESS",
//           eventId: payload.eventId || null,
//         };

//         await tx.save(sessOpts);
//         await notifyParties(tx, "confirmed", session, targetCurrency);

//         await safeCommit(session);
//         safeEndSession(session);

//         return res.json({
//           success: true,
//           transactionId: tx._id.toString(),
//           flow: tx.flow,
//           status: tx.status,
//           providerStatus: tx.providerStatus,
//         });
//       }

//       throw createError(400, `Flow externe non supporté en SUCCESS: ${tx.flow}`);
//     }

//     if (payload.providerReference || payload.reference) {
//       tx.providerReference = payload.providerReference || payload.reference;
//     }

//     if (isOutboundExternalFlow(tx.flow)) {
//       if (tx.fundsCaptured) {
//         await refundSenderFunds({
//           transaction: tx,
//           senderId: tx.sender,
//           amount: grossSource,
//           currency: sourceCurrency,
//           session,
//         });
//         tx.reversedAt = new Date();
//       } else if (tx.fundsReserved && !tx.reserveReleased) {
//         await releaseSenderReserve({
//           transaction: tx,
//           senderId: tx.sender,
//           amount: grossSource,
//           currency: sourceCurrency,
//           session,
//         });
//         tx.reserveReleased = true;
//         tx.reserveReleasedAt = new Date();
//       }
//     }

//     tx.status = "failed";
//     tx.providerStatus = payload.status || payload.providerStatus || "FAILED";
//     tx.failure = {
//       ...(tx.failure || {}),
//       failedAt: new Date(),
//       providerResult: "FAILED",
//       eventId: payload.eventId || null,
//       reason: payload.reason || payload.error || payload.message || "Provider failure",
//     };

//     await tx.save(sessOpts);
//     await notifyParties(tx, "failed", session, sourceCurrency || targetCurrency);

//     await safeCommit(session);
//     safeEndSession(session);

//     return res.json({
//       success: true,
//       transactionId: tx._id.toString(),
//       flow: tx.flow,
//       status: tx.status,
//       providerStatus: tx.providerStatus,
//     });
//   } catch (err) {
//     try {
//       if (session) {
//         const { safeAbort, safeEndSession } = runtime;
//         await safeAbort(session);
//         safeEndSession(session);
//       }
//     } catch (_) {
//       // no-op
//     }
//     return next(err);
//   }
// }

// module.exports = {
//   settleExternalTransactionWebhook,
// };







// File: src/controllers/externalSettlementController.js
"use strict";

/**
 * Webhook settlement TX Core.
 *
 * Rôle :
 * - SUCCESS inbound  => crédit wallet receiver local
 * - SUCCESS outbound => confirmation finale sans crédit local receiver
 * - FAILED outbound  => release reserve OU refund sender si déjà capturé
 *
 * Sécurité :
 * - ignore les webhooks tardifs sur une transaction auto-annulée / finale
 * - bloque une confirmation provider si autoCancelAt est déjà dépassé
 * - rend les webhooks idempotents via eventId dans webhookHistory
 */

const createError = require("http-errors");

const {
  Transaction,
  captureSenderReserve,
  releaseSenderReserve,
  refundSenderFunds,
  creditReceiverFunds,
  creditTreasuryRevenue,
  resolveTreasuryFromSystemType,
  normalizeTreasurySystemType,
  startTxSession,
  maybeSessionOpts,
  canUseSharedSession,
} = require("../services/transactions/shared/runtime");

const {
  notifyParties,
} = require("../services/transactions/shared/notifications");

const {
  round2,
  toFloat,
} = require("../services/transactions/shared/helpers");

const {
  isOutboundExternalFlow,
  isInboundExternalFlow,
} = require("../services/transactions/handlers/flowHelpers");

const {
  syncReferralAfterConfirmedTx,
} = require("../services/referralSyncService");

const DEFAULT_FEES_TREASURY_SYSTEM_TYPE = "FEES_TREASURY";
const DEFAULT_FEES_TREASURY_LABEL = "PayNoval Fees Treasury";

const FINAL_STATUSES = new Set([
  "confirmed",
  "completed",
  "success",
  "successful",
  "validated",
  "cancelled",
  "canceled",
  "failed",
  "refunded",
  "reversed",
]);

function low(value) {
  return String(value || "").trim().toLowerCase();
}

function mapProviderState(payload = {}) {
  const raw =
    payload.status ||
    payload.providerStatus ||
    payload.event ||
    payload.state ||
    "";

  const status = low(raw);

  if (
    [
      "success",
      "successful",
      "completed",
      "confirmed",
      "paid",
      "settled",
      "captured",
      "succeeded",
      "approved",
      "ok",
    ].includes(status)
  ) {
    return "SUCCESS";
  }

  if (
    [
      "failed",
      "failure",
      "error",
      "cancelled",
      "canceled",
      "expired",
      "rejected",
      "reversed",
      "declined",
      "voided",
    ].includes(status)
  ) {
    return "FAILED";
  }

  return "PROCESSING";
}

function normalizeProviderReference(payload = {}) {
  return (
    payload.providerReference ||
    payload.externalReference ||
    payload.reference ||
    payload.raw?.providerReference ||
    payload.raw?.externalReference ||
    payload.raw?.reference ||
    null
  );
}

function normalizeReference(payload = {}) {
  return (
    payload.reference ||
    payload.txReference ||
    payload.raw?.reference ||
    payload.raw?.txReference ||
    null
  );
}

function hasWebhookEventBeenSeen(tx, payload = {}) {
  const eventId = String(payload.eventId || "").trim();

  if (!eventId) return false;

  const list = Array.isArray(tx.webhookHistory) ? tx.webhookHistory : [];

  return list.some(
    (entry) => String(entry?.eventId || "").trim() === eventId
  );
}

function appendWebhookHistory(tx, payload = {}) {
  const list = Array.isArray(tx.webhookHistory) ? [...tx.webhookHistory] : [];

  list.push({
    at: new Date(),
    eventId: payload.eventId || null,
    eventType: payload.eventType || null,
    status:
      payload.status ||
      payload.providerStatus ||
      payload.event ||
      payload.state ||
      null,
    providerReference: normalizeProviderReference(payload),
    reference: normalizeReference(payload),
    verified: payload.verified !== false,
    payload: payload.raw || payload,
  });

  tx.webhookHistory = list.slice(-50);
}

async function findTransactionFromWebhook(payload = {}, session = null) {
  const providerReference = normalizeProviderReference(payload);
  const transactionId = payload.transactionId || null;
  const reference = normalizeReference(payload);

  if (transactionId) {
    const byId = await Transaction.findById(transactionId).session(
      session || null
    );

    if (byId) return byId;
  }

  if (providerReference) {
    const byProviderRef = await Transaction.findOne({
      providerReference,
    }).session(session || null);

    if (byProviderRef) return byProviderRef;
  }

  if (reference) {
    const byReference = await Transaction.findOne({
      reference,
    }).session(session || null);

    if (byReference) return byReference;
  }

  return null;
}

function buildReferralSyncError(err) {
  return {
    ok: false,
    skipped: true,
    reason: "REFERRAL_SYNC_EXCEPTION",
    error: err?.message || "Referral sync failed",
  };
}

function resolveFeesTreasuryMeta(tx) {
  const treasurySystemType = normalizeTreasurySystemType(
    tx?.treasurySystemType || DEFAULT_FEES_TREASURY_SYSTEM_TYPE
  );

  const treasuryUserId = String(
    tx?.treasuryUserId ||
      resolveTreasuryFromSystemType(treasurySystemType) ||
      ""
  ).trim();

  const treasuryLabel = String(
    tx?.treasuryLabel || DEFAULT_FEES_TREASURY_LABEL
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

function isFinalOrAutoCancelled(tx) {
  const status = low(tx?.status);

  return (
    !!tx?.autoCancelledAt ||
    tx?.providerStatus === "AUTO_CANCELLED_EXPIRED" ||
    FINAL_STATUSES.has(status)
  );
}

function isExpiredBeforeSettlement(tx) {
  if (!tx?.autoCancelAt) return false;

  const autoCancelDate = new Date(tx.autoCancelAt);

  if (!Number.isFinite(autoCancelDate.getTime())) return false;
  if (autoCancelDate > new Date()) return false;

  return (
    !tx.confirmedAt &&
    !tx.executedAt &&
    tx.fundsCaptured !== true &&
    tx.beneficiaryCredited !== true
  );
}

function resolveSourceCurrency(tx) {
  return String(
    tx?.senderCurrencySymbol ||
      tx?.currencySource ||
      tx?.money?.source?.currency ||
      ""
  )
    .trim()
    .toUpperCase();
}

function resolveTargetCurrency(tx) {
  return String(
    tx?.localCurrencySymbol ||
      tx?.currencyTarget ||
      tx?.money?.target?.currency ||
      ""
  )
    .trim()
    .toUpperCase();
}

function resolveGrossSource(tx) {
  return round2(
    toFloat(
      tx?.money?.source?.amount ??
        tx?.amountSource ??
        tx?.amount ??
        0
    )
  );
}

function resolveTargetAmount(tx) {
  return round2(
    toFloat(
      tx?.money?.target?.amount ??
        tx?.amountTarget ??
        tx?.localAmount ??
        0
    )
  );
}

async function commitAndEnd(session) {
  try {
    if (canUseSharedSession() && session) {
      await session.commitTransaction();
    }
  } finally {
    try {
      session?.endSession?.();
    } catch {}
  }
}

async function abortAndEnd(session) {
  try {
    if (canUseSharedSession() && session) {
      await session.abortTransaction();
    }
  } catch {}

  try {
    session?.endSession?.();
  } catch {}
}

async function runReferralSync(tx) {
  try {
    return await syncReferralAfterConfirmedTx(tx);
  } catch (err) {
    return buildReferralSyncError(err);
  }
}

async function settleProcessingWebhook({
  tx,
  payload,
  sessOpts,
  session,
}) {
  tx.status = "processing";
  tx.providerStatus =
    payload.status || payload.providerStatus || "PROVIDER_PROCESSING";

  await tx.save(sessOpts);
  await commitAndEnd(session);

  return {
    statusCode: 202,
    body: {
      success: true,
      transactionId: tx._id.toString(),
      status: tx.status,
      providerStatus: tx.providerStatus,
      eventId: payload.eventId || null,
    },
  };
}

async function settleOutboundSuccess({
  tx,
  payload,
  sessOpts,
  session,
  sourceCurrency,
  grossSource,
  notifyCurrency,
}) {
  if (!sourceCurrency) {
    throw createError(409, "Devise source introuvable sur la transaction");
  }

  if (!Number.isFinite(grossSource) || grossSource <= 0) {
    throw createError(409, "Montant source invalide");
  }

  if (tx.fundsReserved && !tx.fundsCaptured) {
    await captureSenderReserve({
      transaction: tx,
      senderId: tx.sender,
      amount: grossSource,
      currency: sourceCurrency,
      session,
    });

    tx.fundsCaptured = true;
    tx.fundsCapturedAt = new Date();
  }

  if (!tx.treasuryRevenueCredited) {
    const treasuryMeta = resolveFeesTreasuryMeta(tx);

    const creditResult = await creditTreasuryRevenue({
      transaction: tx,
      pricingSnapshot: tx.pricingSnapshot || {},
      treasurySystemType: treasuryMeta.treasurySystemType,
      treasuryLabel: treasuryMeta.treasuryLabel,
      session,
    });

    tx.treasuryRevenue = creditResult?.treasuryRevenue || null;
    tx.treasuryRevenueCredited = true;
    tx.treasuryRevenueCreditedAt = new Date();
    tx.treasuryUserId = treasuryMeta.treasuryUserId;
    tx.treasurySystemType = treasuryMeta.treasurySystemType;
    tx.treasuryLabel = treasuryMeta.treasuryLabel;
  }

  tx.status = "confirmed";
  tx.confirmedAt = new Date();
  tx.executedAt = new Date();
  tx.providerStatus = payload.status || payload.providerStatus || "SUCCESS";
  tx.settlement = {
    ...(tx.settlement || {}),
    settledAt: new Date(),
    providerResult: "SUCCESS",
    eventId: payload.eventId || null,
    eventType: payload.eventType || null,
  };

  await tx.save(sessOpts);
  await notifyParties(tx, "confirmed", session, notifyCurrency);
  await commitAndEnd(session);

  const referralSync = await runReferralSync(tx);

  return {
    statusCode: 200,
    body: {
      success: true,
      transactionId: tx._id.toString(),
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      treasuryRevenue: tx.treasuryRevenue || null,
      treasuryRevenueCredited: !!tx.treasuryRevenueCredited,
      treasuryUserId: tx.treasuryUserId || null,
      treasurySystemType: tx.treasurySystemType || null,
      treasuryLabel: tx.treasuryLabel || null,
      referralSync,
    },
  };
}

async function settleInboundSuccess({
  tx,
  payload,
  sessOpts,
  session,
  targetCurrency,
  targetAmount,
  notifyCurrency,
}) {
  if (!targetCurrency) {
    throw createError(409, "Devise destination introuvable sur la transaction");
  }

  if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
    throw createError(409, "Montant destination invalide");
  }

  if (!tx.beneficiaryCredited) {
    await creditReceiverFunds({
      transaction: tx,
      receiverId: tx.receiver,
      amount: targetAmount,
      currency: targetCurrency,
      session,
    });

    tx.beneficiaryCredited = true;
    tx.beneficiaryCreditedAt = new Date();
  }

  if (!tx.treasuryRevenueCredited) {
    const treasuryMeta = resolveFeesTreasuryMeta(tx);

    const creditResult = await creditTreasuryRevenue({
      transaction: tx,
      pricingSnapshot: tx.pricingSnapshot || {},
      treasurySystemType: treasuryMeta.treasurySystemType,
      treasuryLabel: treasuryMeta.treasuryLabel,
      session,
    });

    tx.treasuryRevenue = creditResult?.treasuryRevenue || null;
    tx.treasuryRevenueCredited = true;
    tx.treasuryRevenueCreditedAt = new Date();
    tx.treasuryUserId = treasuryMeta.treasuryUserId;
    tx.treasurySystemType = treasuryMeta.treasurySystemType;
    tx.treasuryLabel = treasuryMeta.treasuryLabel;
  }

  tx.status = "confirmed";
  tx.confirmedAt = new Date();
  tx.executedAt = new Date();
  tx.providerStatus = payload.status || payload.providerStatus || "SUCCESS";
  tx.settlement = {
    ...(tx.settlement || {}),
    settledAt: new Date(),
    providerResult: "SUCCESS",
    eventId: payload.eventId || null,
    eventType: payload.eventType || null,
  };

  await tx.save(sessOpts);
  await notifyParties(tx, "confirmed", session, notifyCurrency);
  await commitAndEnd(session);

  const referralSync = await runReferralSync(tx);

  return {
    statusCode: 200,
    body: {
      success: true,
      transactionId: tx._id.toString(),
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      treasuryRevenue: tx.treasuryRevenue || null,
      treasuryRevenueCredited: !!tx.treasuryRevenueCredited,
      treasuryUserId: tx.treasuryUserId || null,
      treasurySystemType: tx.treasurySystemType || null,
      treasuryLabel: tx.treasuryLabel || null,
      referralSync,
    },
  };
}

async function settleFailureWebhook({
  tx,
  payload,
  sessOpts,
  session,
  sourceCurrency,
  grossSource,
  notifyCurrency,
}) {
  if (isOutboundExternalFlow(tx.flow)) {
    if (!sourceCurrency) {
      throw createError(409, "Devise source introuvable sur la transaction");
    }

    if (!Number.isFinite(grossSource) || grossSource <= 0) {
      throw createError(409, "Montant source invalide");
    }

    if (tx.fundsCaptured) {
      await refundSenderFunds({
        transaction: tx,
        senderId: tx.sender,
        amount: grossSource,
        currency: sourceCurrency,
        session,
      });

      tx.reversedAt = new Date();
    } else if (tx.fundsReserved && !tx.reserveReleased) {
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
  }

  tx.status = "failed";
  tx.providerStatus = payload.status || payload.providerStatus || "FAILED";
  tx.failure = {
    ...(tx.failure || {}),
    failedAt: new Date(),
    providerResult: "FAILED",
    eventId: payload.eventId || null,
    eventType: payload.eventType || null,
    reason:
      payload.reason ||
      payload.error ||
      payload.message ||
      "Provider failure",
  };

  await tx.save(sessOpts);
  await notifyParties(tx, "failed", session, notifyCurrency);
  await commitAndEnd(session);

  return {
    statusCode: 200,
    body: {
      success: true,
      transactionId: tx._id.toString(),
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      eventId: payload.eventId || null,
    },
  };
}

async function settleExternalTransactionWebhook(req, res, next) {
  const session = await startTxSession();

  try {
    if (canUseSharedSession() && session) {
      session.startTransaction();
    }

    const sessOpts = maybeSessionOpts(session);
    const payload = req.body || {};
    const mapped = mapProviderState(payload);

    const tx = await findTransactionFromWebhook(
      payload,
      sessOpts.session || null
    );

    if (!tx) {
      throw createError(404, "Transaction webhook introuvable");
    }

    if (hasWebhookEventBeenSeen(tx, payload)) {
      await commitAndEnd(session);

      return res.status(200).json({
        success: true,
        duplicate: true,
        ignored: true,
        transactionId: tx._id.toString(),
        status: tx.status,
        providerStatus: tx.providerStatus,
        eventId: payload.eventId || null,
      });
    }

    appendWebhookHistory(tx, payload);

    const providerReference = normalizeProviderReference(payload);

    if (providerReference) {
      tx.providerReference = providerReference;
    }

    if (isFinalOrAutoCancelled(tx)) {
      await tx.save(sessOpts);
      await commitAndEnd(session);

      return res.status(200).json({
        success: true,
        ignored: true,
        reason: tx.autoCancelledAt
          ? "TRANSACTION_ALREADY_AUTO_CANCELLED"
          : "TRANSACTION_ALREADY_FINAL",
        transactionId: tx._id.toString(),
        status: tx.status,
        providerStatus: tx.providerStatus,
        eventId: payload.eventId || null,
      });
    }

    if (isExpiredBeforeSettlement(tx)) {
      tx.providerStatus = tx.providerStatus || "EXPIRED_PENDING_AUTO_CANCEL";
      tx.lastAutoCancelError = "Webhook reçu après expiration autoCancelAt";

      await tx.save(sessOpts);
      await commitAndEnd(session);

      return res.status(200).json({
        success: true,
        ignored: true,
        reason: "TRANSACTION_EXPIRED_PENDING_AUTO_CANCEL",
        transactionId: tx._id.toString(),
        status: tx.status,
        providerStatus: tx.providerStatus,
        autoCancelAt: tx.autoCancelAt || null,
        eventId: payload.eventId || null,
      });
    }

    const sourceCurrency = resolveSourceCurrency(tx);
    const targetCurrency = resolveTargetCurrency(tx);
    const notifyCurrency = sourceCurrency || targetCurrency || "XOF";
    const grossSource = resolveGrossSource(tx);
    const targetAmount = resolveTargetAmount(tx);

    let result;

    if (mapped === "PROCESSING") {
      result = await settleProcessingWebhook({
        tx,
        payload,
        sessOpts,
        session,
      });

      return res.status(result.statusCode).json(result.body);
    }

    if (mapped === "SUCCESS") {
      if (isOutboundExternalFlow(tx.flow)) {
        result = await settleOutboundSuccess({
          tx,
          payload,
          sessOpts,
          session,
          sourceCurrency,
          grossSource,
          notifyCurrency,
        });

        return res.status(result.statusCode).json(result.body);
      }

      if (isInboundExternalFlow(tx.flow)) {
        result = await settleInboundSuccess({
          tx,
          payload,
          sessOpts,
          session,
          targetCurrency,
          targetAmount,
          notifyCurrency,
        });

        return res.status(result.statusCode).json(result.body);
      }

      throw createError(400, `Flow externe non supporté en SUCCESS: ${tx.flow}`);
    }

    result = await settleFailureWebhook({
      tx,
      payload,
      sessOpts,
      session,
      sourceCurrency,
      grossSource,
      notifyCurrency,
    });

    return res.status(result.statusCode).json(result.body);
  } catch (err) {
    await abortAndEnd(session);
    return next(err);
  }
}

module.exports = {
  settleExternalTransactionWebhook,
};