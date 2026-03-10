"use strict";

/**
 * Webhook settlement TX Core
 * - SUCCESS inbound  => crédit wallet receiver local
 * - SUCCESS outbound => confirmation finale sans crédit local receiver
 * - FAILED outbound  => release reserve OU refund sender si déjà capturé
 */

const createError = require("http-errors");

const {
  Transaction,
  User,
  captureSenderReserve,
  releaseSenderReserve,
  refundSenderFunds,
  creditReceiverFunds,
  creditAdminRevenue,
  startTxSession,
  maybeSessionOpts,
  CAN_USE_SHARED_SESSION,
} = require("../shared/runtime");

const { notifyParties } = require("../shared/notifications");
const { round2, toFloat } = require("../shared/helpers");
const {
  isOutboundExternalFlow,
  isInboundExternalFlow,
} = require("./flowHelpers");

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
    ].includes(s)
  ) {
    return "FAILED";
  }

  return "PROCESSING";
}

function appendWebhookHistory(tx, payload = {}) {
  const list = Array.isArray(tx.webhookHistory) ? [...tx.webhookHistory] : [];
  list.push({
    at: new Date(),
    status:
      payload.status || payload.providerStatus || payload.event || payload.state || null,
    providerReference:
      payload.providerReference || payload.reference || payload.externalReference || null,
    payload: payload,
  });
  tx.webhookHistory = list.slice(-20);
}

async function findTransactionFromWebhook(payload = {}, session = null) {
  const providerReference =
    payload.providerReference ||
    payload.reference ||
    payload.externalReference ||
    null;

  const transactionId = payload.transactionId || null;

  if (transactionId) {
    const byId = await Transaction.findById(transactionId).session(session || null);
    if (byId) return byId;
  }

  if (providerReference) {
    const byProviderRef = await Transaction.findOne({ providerReference }).session(session || null);
    if (byProviderRef) return byProviderRef;
  }

  if (payload.reference) {
    const byReference = await Transaction.findOne({ reference: payload.reference }).session(session || null);
    if (byReference) return byReference;
  }

  return null;
}

async function settleExternalTransactionWebhook(req, res, next) {
  const session = await startTxSession();

  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

    const sessOpts = maybeSessionOpts(session);
    const payload = req.body || {};
    const mapped = mapProviderState(payload);

    const tx = await findTransactionFromWebhook(payload, sessOpts.session || null);
    if (!tx) {
      throw createError(404, "Transaction webhook introuvable");
    }

    appendWebhookHistory(tx, payload);

    const sourceCurrency = String(tx.senderCurrencySymbol || "").trim().toUpperCase();
    const targetCurrency = String(tx.localCurrencySymbol || "").trim().toUpperCase();
    const grossSource = round2(toFloat(tx.amount));
    const targetAmount = round2(toFloat(tx.localAmount));

    if (mapped === "PROCESSING") {
      tx.status = "processing";
      tx.providerStatus = payload.status || payload.providerStatus || "PROVIDER_PROCESSING";
      if (payload.providerReference || payload.reference) {
        tx.providerReference = payload.providerReference || payload.reference;
      }
      await tx.save(sessOpts);

      if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
      session.endSession();

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
          const adminUser = await User.findOne({ email: "admin@paynoval.com" })
            .select("_id")
            .session(sessOpts.session || null);

          if (!adminUser) {
            throw createError(500, "Compte administrateur introuvable");
          }

          await creditAdminRevenue({
            transaction: tx,
            pricingSnapshot: tx.pricingSnapshot || {},
            adminUserId: adminUser._id,
            session,
          });

          tx.adminRevenueCredited = true;
          tx.adminRevenueCreditedAt = new Date();
        }

        tx.status = "confirmed";
        tx.confirmedAt = new Date();
        tx.executedAt = new Date();
        tx.providerStatus = payload.status || payload.providerStatus || "SUCCESS";
        tx.settlement = {
          ...(tx.settlement || {}),
          settledAt: new Date(),
          providerResult: "SUCCESS",
        };

        await tx.save(sessOpts);
        await notifyParties(tx, "confirmed", session, sourceCurrency);

        if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
        session.endSession();

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
          const adminUser = await User.findOne({ email: "admin@paynoval.com" })
            .select("_id")
            .session(sessOpts.session || null);

          if (!adminUser) {
            throw createError(500, "Compte administrateur introuvable");
          }

          await creditAdminRevenue({
            transaction: tx,
            pricingSnapshot: tx.pricingSnapshot || {},
            adminUserId: adminUser._id,
            session,
          });

          tx.adminRevenueCredited = true;
          tx.adminRevenueCreditedAt = new Date();
        }

        tx.status = "confirmed";
        tx.confirmedAt = new Date();
        tx.executedAt = new Date();
        tx.providerStatus = payload.status || payload.providerStatus || "SUCCESS";
        tx.settlement = {
          ...(tx.settlement || {}),
          settledAt: new Date(),
          providerResult: "SUCCESS",
        };

        await tx.save(sessOpts);
        await notifyParties(tx, "confirmed", session, targetCurrency);

        if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
        session.endSession();

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

    /**
     * FAILED
     */
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
      reason:
        payload.reason ||
        payload.error ||
        payload.message ||
        "Provider failure",
    };

    await tx.save(sessOpts);
    await notifyParties(tx, "failed", session, sourceCurrency || targetCurrency);

    if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
    session.endSession();

    return res.json({
      success: true,
      transactionId: tx._id.toString(),
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
    });
  } catch (err) {
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    next(err);
  }
}

module.exports = {
  settleExternalTransactionWebhook,
};