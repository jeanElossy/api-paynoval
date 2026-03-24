// "use strict";

// /**
//  * Webhook settlement TX Core
//  * - SUCCESS inbound  => crédit wallet receiver local
//  * - SUCCESS outbound => confirmation finale sans crédit local receiver
//  * - FAILED outbound  => release reserve OU refund sender si déjà capturé
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
//       payload.status || payload.providerStatus || payload.event || payload.state || null,
//     providerReference:
//       payload.providerReference || payload.reference || payload.externalReference || null,
//     verified: Boolean(payload.verified),
//     payload: payload.raw || payload,
//   });

//   tx.webhookHistory = list.slice(-50);
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
//       User,
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
//       tx.providerStatus = payload.status || payload.providerStatus || "PROVIDER_PROCESSING";

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
//           const adminUser = await User.findOne({ email: "admin@paynoval.com" })
//             .select("_id")
//             .session(sessOpts.session || null);

//           if (!adminUser) {
//             throw createError(500, "Compte administrateur introuvable");
//           }

//           await creditAdminRevenue({
//             transaction: tx,
//             pricingSnapshot: tx.pricingSnapshot || {},
//             adminUserId: adminUser._id,
//             session,
//           });

//           tx.adminRevenueCredited = true;
//           tx.adminRevenueCreditedAt = new Date();
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
//           const adminUser = await User.findOne({ email: "admin@paynoval.com" })
//             .select("_id")
//             .session(sessOpts.session || null);

//           if (!adminUser) {
//             throw createError(500, "Compte administrateur introuvable");
//           }

//           await creditAdminRevenue({
//             transaction: tx,
//             pricingSnapshot: tx.pricingSnapshot || {},
//             adminUserId: adminUser._id,
//             session,
//           });

//           tx.adminRevenueCredited = true;
//           tx.adminRevenueCreditedAt = new Date();
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









"use strict";

/**
 * Webhook settlement TX Core
 * - SUCCESS inbound  => crédit wallet receiver local
 * - SUCCESS outbound => confirmation finale sans crédit local receiver
 * - FAILED outbound  => release reserve OU refund sender si déjà capturé
 *
 * NOTE:
 * - Suppression de toute dépendance à admin@paynoval.com
 * - Le crédit revenu/frais passe désormais par un treasury user id résolu par config
 */

const createError = require("http-errors");
const runtime = require("../services/transactions/shared/runtime");

const { notifyParties } = require("../services/transactions/shared/notifications");
const { round2, toFloat } = require("../services/transactions/shared/helpers");
const {
  isOutboundExternalFlow,
  isInboundExternalFlow,
} = require("../services/transactions/handlers/flowHelpers");

function low(v) {
  return String(v || "").trim().toLowerCase();
}

function mapProviderState(payload = {}) {
  const raw =
    payload.status ||
    payload.providerStatus ||
    payload.event ||
    payload.state ||
    "";
  const s = low(raw);

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
    ].includes(s)
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
    ].includes(s)
  ) {
    return "FAILED";
  }

  return "PROCESSING";
}

function hasWebhookEventBeenSeen(tx, payload = {}) {
  const eventId = String(payload.eventId || "").trim();
  if (!eventId) return false;

  const list = Array.isArray(tx.webhookHistory) ? tx.webhookHistory : [];
  return list.some((entry) => String(entry?.eventId || "").trim() === eventId);
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
    providerReference:
      payload.providerReference ||
      payload.reference ||
      payload.externalReference ||
      null,
    verified: Boolean(payload.verified),
    payload: payload.raw || payload,
  });

  tx.webhookHistory = list.slice(-50);
}

function resolveRevenueTreasuryUserId(payload = {}) {
  const fromPayload =
    payload.treasuryUserId ||
    payload.revenueTreasuryUserId ||
    payload.raw?.treasuryUserId ||
    payload.raw?.metadata?.treasuryUserId ||
    payload.raw?.metadata?.revenueTreasuryUserId ||
    null;

  if (fromPayload) return String(fromPayload).trim();

  const fromEnv =
    process.env.REVENUE_TREASURY_USER_ID ||
    process.env.ADMIN_REVENUE_TREASURY_USER_ID ||
    process.env.ADMIN_TREASURY_USER_ID ||
    process.env.TREASURY_USER_ID ||
    "";

  return String(fromEnv).trim();
}

function buildRevenueTreasuryMeta(payload = {}) {
  const treasurySystemType =
    payload.treasurySystemType ||
    payload.raw?.treasurySystemType ||
    payload.raw?.metadata?.treasurySystemType ||
    "REVENUE_TREASURY";

  const treasuryLabel =
    payload.treasuryLabel ||
    payload.raw?.treasuryLabel ||
    payload.raw?.metadata?.treasuryLabel ||
    "Revenue Treasury";

  return {
    treasurySystemType: String(treasurySystemType).trim(),
    treasuryLabel: String(treasuryLabel).trim(),
  };
}

async function findTransactionFromWebhook(Transaction, payload = {}, session = null) {
  const providerReference =
    payload.providerReference ||
    payload.reference ||
    payload.externalReference ||
    null;

  const transactionId =
    payload.transactionId ||
    payload.txCoreTransactionId ||
    payload.raw?.transactionId ||
    payload.raw?.metadata?.txCoreTransactionId ||
    null;

  const reference =
    payload.reference ||
    payload.txReference ||
    payload.raw?.reference ||
    payload.raw?.txReference ||
    payload.raw?.merchantReference ||
    payload.raw?.clientReference ||
    payload.raw?.metadata?.txReference ||
    payload.raw?.metadata?.txCoreReference ||
    null;

  if (transactionId) {
    const byId = await Transaction.findById(transactionId).session(session || null);
    if (byId) return byId;
  }

  if (providerReference) {
    const byProviderRef = await Transaction.findOne({ providerReference }).session(
      session || null
    );
    if (byProviderRef) return byProviderRef;
  }

  if (reference) {
    const byReference = await Transaction.findOne({ reference }).session(session || null);
    if (byReference) return byReference;
  }

  return null;
}

async function settleExternalTransactionWebhook(req, res, next) {
  let session = null;

  try {
    const {
      Transaction,
      captureSenderReserve,
      releaseSenderReserve,
      refundSenderFunds,
      creditReceiverFunds,
      creditAdminRevenue,
      startTxSession,
      maybeSessionOpts,
      canUseSharedSession,
      safeCommit,
      safeAbort,
      safeEndSession,
    } = runtime.getRuntime();

    const useSharedSession = Boolean(canUseSharedSession());

    session = await startTxSession();

    if (useSharedSession && typeof session?.startTransaction === "function") {
      session.startTransaction();
    }

    const sessOpts = maybeSessionOpts(session);
    const payload = req.body || {};
    const mapped = mapProviderState(payload);

    const tx = await findTransactionFromWebhook(
      Transaction,
      payload,
      sessOpts.session || null
    );

    if (!tx) {
      throw createError(404, "Transaction webhook introuvable");
    }

    if (hasWebhookEventBeenSeen(tx, payload)) {
      await safeCommit(session);
      safeEndSession(session);

      return res.status(200).json({
        success: true,
        duplicate: true,
        transactionId: tx._id.toString(),
        status: tx.status,
        providerStatus: tx.providerStatus,
        eventId: payload.eventId || null,
      });
    }

    appendWebhookHistory(tx, payload);

    const sourceCurrency = String(tx.senderCurrencySymbol || "").trim().toUpperCase();
    const targetCurrency = String(tx.localCurrencySymbol || "").trim().toUpperCase();
    const grossSource = round2(toFloat(tx.amount));
    const targetAmount = round2(toFloat(tx.localAmount));

    if (mapped === "PROCESSING") {
      tx.status = "processing";
      tx.providerStatus =
        payload.status || payload.providerStatus || "PROVIDER_PROCESSING";

      if (payload.providerReference || payload.reference) {
        tx.providerReference = payload.providerReference || payload.reference;
      }

      await tx.save(sessOpts);

      await safeCommit(session);
      safeEndSession(session);

      return res.status(202).json({
        success: true,
        transactionId: tx._id.toString(),
        status: tx.status,
        providerStatus: tx.providerStatus,
      });
    }

    if (mapped === "SUCCESS") {
      if (payload.providerReference || payload.reference) {
        tx.providerReference = payload.providerReference || payload.reference;
      }

      if (isOutboundExternalFlow(tx.flow)) {
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

        if (!tx.adminRevenueCredited) {
          const treasuryUserId = resolveRevenueTreasuryUserId(payload);
          const treasuryMeta = buildRevenueTreasuryMeta(payload);

          if (!treasuryUserId) {
            throw createError(
              500,
              "REVENUE_TREASURY_USER_ID introuvable pour créditer les revenus."
            );
          }

          await creditAdminRevenue({
            transaction: tx,
            pricingSnapshot: tx.pricingSnapshot || {},
            treasuryUserId,
            treasurySystemType: treasuryMeta.treasurySystemType,
            treasuryLabel: treasuryMeta.treasuryLabel,
            session,
          });

          tx.adminRevenueCredited = true;
          tx.adminRevenueCreditedAt = new Date();
          tx.revenueTreasury = {
            treasuryUserId,
            treasurySystemType: treasuryMeta.treasurySystemType,
            treasuryLabel: treasuryMeta.treasuryLabel,
            creditedAt: new Date(),
          };
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
        };

        await tx.save(sessOpts);
        await notifyParties(tx, "confirmed", session, sourceCurrency);

        await safeCommit(session);
        safeEndSession(session);

        return res.json({
          success: true,
          transactionId: tx._id.toString(),
          flow: tx.flow,
          status: tx.status,
          providerStatus: tx.providerStatus,
        });
      }

      if (isInboundExternalFlow(tx.flow)) {
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

        if (!tx.adminRevenueCredited) {
          const treasuryUserId = resolveRevenueTreasuryUserId(payload);
          const treasuryMeta = buildRevenueTreasuryMeta(payload);

          if (!treasuryUserId) {
            throw createError(
              500,
              "REVENUE_TREASURY_USER_ID introuvable pour créditer les revenus."
            );
          }

          await creditAdminRevenue({
            transaction: tx,
            pricingSnapshot: tx.pricingSnapshot || {},
            treasuryUserId,
            treasurySystemType: treasuryMeta.treasurySystemType,
            treasuryLabel: treasuryMeta.treasuryLabel,
            session,
          });

          tx.adminRevenueCredited = true;
          tx.adminRevenueCreditedAt = new Date();
          tx.revenueTreasury = {
            treasuryUserId,
            treasurySystemType: treasuryMeta.treasurySystemType,
            treasuryLabel: treasuryMeta.treasuryLabel,
            creditedAt: new Date(),
          };
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
        };

        await tx.save(sessOpts);
        await notifyParties(tx, "confirmed", session, targetCurrency);

        await safeCommit(session);
        safeEndSession(session);

        return res.json({
          success: true,
          transactionId: tx._id.toString(),
          flow: tx.flow,
          status: tx.status,
          providerStatus: tx.providerStatus,
        });
      }

      throw createError(400, `Flow externe non supporté en SUCCESS: ${tx.flow}`);
    }

    if (payload.providerReference || payload.reference) {
      tx.providerReference = payload.providerReference || payload.reference;
    }

    if (isOutboundExternalFlow(tx.flow)) {
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
      reason: payload.reason || payload.error || payload.message || "Provider failure",
    };

    await tx.save(sessOpts);
    await notifyParties(tx, "failed", session, sourceCurrency || targetCurrency);

    await safeCommit(session);
    safeEndSession(session);

    return res.json({
      success: true,
      transactionId: tx._id.toString(),
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
    });
  } catch (err) {
    try {
      if (session) {
        const { safeAbort, safeEndSession } = runtime;
        await safeAbort(session);
        safeEndSession(session);
      }
    } catch (_) {
      // no-op
    }
    return next(err);
  }
}

module.exports = {
  settleExternalTransactionWebhook,
};