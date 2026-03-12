// "use strict";

// const createError = require("http-errors");

// const {
//   Transaction,
//   User,
//   logTransaction,
//   captureSenderReserve,
//   creditReceiverFunds,
//   creditAdminRevenue,
//   startTxSession,
//   maybeSessionOpts,
//   CAN_USE_SHARED_SESSION,
//   assertTransition,
// } = require("../shared/runtime");

// const { notifyParties } = require("../shared/notifications");

// const {
//   sanitize,
//   toFloat,
//   round2,
//   sha256Hex,
//   looksLikeSha256Hex,
//   safeEqualHex,
//   MAX_CONFIRM_ATTEMPTS,
//   LOCK_MINUTES,
// } = require("../shared/helpers");

// const INTERNAL_FLOW = "PAYNOVAL_INTERNAL_TRANSFER";
// const OUTBOUND_EXTERNAL_FLOWS = new Set([
//   "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
//   "PAYNOVAL_TO_BANK_PAYOUT",
//   "PAYNOVAL_TO_CARD_PAYOUT",
// ]);
// const INBOUND_EXTERNAL_FLOWS = new Set([
//   "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
//   "BANK_TRANSFER_TO_PAYNOVAL",
//   "CARD_TOPUP_TO_PAYNOVAL",
// ]);

// function isInternalTransfer(tx) {
//   return tx?.flow === INTERNAL_FLOW;
// }

// function isOutboundExternalPayout(tx) {
//   return OUTBOUND_EXTERNAL_FLOWS.has(String(tx?.flow || ""));
// }

// function isInboundExternalCollection(tx) {
//   return INBOUND_EXTERNAL_FLOWS.has(String(tx?.flow || ""));
// }

// async function confirmController(req, res, next) {
//   const session = await startTxSession();

//   try {
//     if (CAN_USE_SHARED_SESSION) session.startTransaction();

//     const { transactionId, securityAnswer, securityCode } = req.body || {};
//     const provided = sanitize(securityAnswer || securityCode || "");

//     if (!transactionId || !provided) {
//       throw createError(400, "transactionId et securityAnswer sont requis");
//     }

//     const authHeader = req.headers.authorization;
//     if (!authHeader || !authHeader.startsWith("Bearer ")) {
//       throw createError(401, "Token manquant");
//     }

//     const sessOpts = maybeSessionOpts(session);

//     const tx = await Transaction.findById(transactionId)
//       .select([
//         "+flow",
//         "+provider",
//         "+providerStatus",
//         "+providerReference",
//         "+securityAnswerHash",
//         "+securityCode",
//         "+amount",
//         "+transactionFees",
//         "+netAmount",
//         "+senderCurrencySymbol",
//         "+localCurrencySymbol",
//         "+localAmount",
//         "+receiver",
//         "+sender",
//         "+feeSnapshot",
//         "+attemptCount",
//         "+lastAttemptAt",
//         "+lockedUntil",
//         "+status",
//         "+exchangeRate",
//         "+country",
//         "+funds",
//         "+recipientEmail",
//         "+pricingSnapshot",
//         "+adminRevenue",
//         "+adminRevenueCredited",
//         "+fundsReserved",
//         "+fundsCaptured",
//         "+beneficiaryCredited",
//       ])
//       .session(sessOpts.session || null);

//     if (!tx) throw createError(404, "Transaction introuvable");

//     logTransaction({
//       userId: req.user?.id || req.user?._id || null,
//       type: "confirm",
//       provider: tx.provider || tx.funds || "paynoval",
//       amount: toFloat(tx.amount),
//       currency: tx.senderCurrencySymbol,
//       toEmail: tx.recipientEmail || "",
//       details: { transactionId: tx._id.toString(), flow: tx.flow },
//       flagged: false,
//       flagReason: "",
//       transactionId: tx._id,
//       ip: req.ip,
//     }).catch(() => {});

//     const now = new Date();

//     if (tx.lockedUntil && tx.lockedUntil > now) {
//       throw createError(
//         423,
//         `Transaction bloquée, réessayez après ${tx.lockedUntil.toLocaleTimeString("fr-FR")}`
//       );
//     }

//     if (isInboundExternalCollection(tx)) {
//       throw createError(
//         409,
//         "Cette transaction est pilotée par callback provider et ne se confirme pas manuellement."
//       );
//     }

//     if (isInternalTransfer(tx)) {
//       assertTransition(tx.status, "confirmed");

//       if (String(tx.receiver) !== String(req.user.id)) {
//         throw createError(403, "Vous n’êtes pas le destinataire de cette transaction");
//       }
//     } else if (isOutboundExternalPayout(tx)) {
//       if (!["pending", "pending_review", "relaunch"].includes(String(tx.status || ""))) {
//         throw createError(409, "Transaction non confirmable dans son état actuel");
//       }

//       if (String(tx.sender) !== String(req.user.id)) {
//         throw createError(403, "Vous n’êtes pas autorisé à confirmer cette transaction");
//       }
//     } else {
//       throw createError(400, `Flow non supporté pour confirm: ${tx.flow}`);
//     }

//     const storedHash = String(tx.securityAnswerHash || "") || String(tx.securityCode || "");
//     if (!storedHash) {
//       throw createError(500, "securityAnswerHash manquant sur la transaction");
//     }

//     const inputHash = sha256Hex(provided);
//     const ok = looksLikeSha256Hex(storedHash)
//       ? safeEqualHex(inputHash, storedHash)
//       : safeEqualHex(inputHash, sha256Hex(String(storedHash)));

//     if (!ok) {
//       tx.attemptCount = (tx.attemptCount || 0) + 1;
//       tx.lastAttemptAt = now;

//       if (tx.attemptCount >= MAX_CONFIRM_ATTEMPTS) {
//         tx.lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60 * 1000);
//         tx.status = "locked";
//         tx.providerStatus = "LOCKED_TOO_MANY_ATTEMPTS";
//         await tx.save(sessOpts);

//         await notifyParties(tx, "locked", session, tx.senderCurrencySymbol);

//         throw createError(423, `Réponse incorrecte. Transaction bloquée ${LOCK_MINUTES} min.`);
//       }

//       await tx.save(sessOpts);
//       throw createError(
//         401,
//         `Réponse incorrecte. Il vous reste ${MAX_CONFIRM_ATTEMPTS - tx.attemptCount} essai(s).`
//       );
//     }

//     tx.attemptCount = 0;
//     tx.lastAttemptAt = null;
//     tx.lockedUntil = null;

//     const grossSource = round2(toFloat(tx.amount));
//     const targetAmount = round2(toFloat(tx.localAmount));
//     const sourceCurrency = String(tx.senderCurrencySymbol || "").trim().toUpperCase();
//     const targetCurrency = String(tx.localCurrencySymbol || "").trim().toUpperCase();

//     if (!tx.fundsReserved) {
//       throw createError(409, "Fonds non réservés sur cette transaction");
//     }

//     if (!tx.fundsCaptured) {
//       await captureSenderReserve({
//         transaction: tx,
//         senderId: tx.sender,
//         amount: grossSource,
//         currency: sourceCurrency,
//         session,
//       });

//       tx.fundsCaptured = true;
//       tx.fundsCapturedAt = new Date();
//       tx.providerStatus = "FUNDS_CAPTURED";
//     }

//     /**
//      * FLOW INTERNE
//      * - crédit receiver local
//      * - crédit revenu admin
//      * - status = confirmed
//      */
//     if (isInternalTransfer(tx)) {
//       if (!tx.beneficiaryCredited) {
//         await creditReceiverFunds({
//           transaction: tx,
//           receiverId: tx.receiver,
//           amount: targetAmount,
//           currency: targetCurrency,
//           session,
//         });

//         tx.beneficiaryCredited = true;
//         tx.beneficiaryCreditedAt = new Date();
//         tx.providerStatus = "BENEFICIARY_CREDITED";
//       }

//       if (!tx.adminRevenueCredited) {
//         const adminUser = await User.findOne({ email: "admin@paynoval.com" })
//           .select("_id")
//           .session(sessOpts.session || null);

//         if (!adminUser) {
//           throw createError(500, "Compte administrateur introuvable");
//         }

//         await creditAdminRevenue({
//           transaction: tx,
//           pricingSnapshot: tx.pricingSnapshot || {},
//           adminUserId: adminUser._id,
//           session,
//         });

//         tx.adminRevenueCredited = true;
//         tx.adminRevenueCreditedAt = new Date();
//         tx.providerStatus = "ADMIN_REVENUE_CREDITED";
//       }

//       tx.status = "confirmed";
//       tx.confirmedAt = now;
//       tx.executedAt = now;
//       tx.providerStatus = "SUCCESS";

//       await tx.save(sessOpts);
//       await notifyParties(tx, "confirmed", session, sourceCurrency);

//       if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
//       session.endSession();

//       return res.json({
//         success: true,
//         transactionId: tx._id.toString(),
//         reference: tx.reference,
//         flow: tx.flow,
//         status: tx.status,
//         providerStatus: tx.providerStatus,
//         credited: targetAmount,
//         currencyCredited: targetCurrency,
//         pricingSnapshot: tx.pricingSnapshot || null,
//         adminRevenue: tx.adminRevenue || null,
//         fundsCaptured: !!tx.fundsCaptured,
//         beneficiaryCredited: !!tx.beneficiaryCredited,
//         adminRevenueCredited: !!tx.adminRevenueCredited,
//       });
//     }

//     /**
//      * PAYOUT EXTERNE
//      * - on capture la réserve
//      * - on NE crédite PAS de bénéficiaire local
//      * - on NE confirme PAS définitivement ici
//      * - le succès final doit venir du provider / webhook
//      */
//     tx.status = "processing";
//     tx.providerStatus = tx.providerReference
//       ? "PROVIDER_SUBMITTED"
//       : "CONFIRMED_BY_USER_PENDING_PROVIDER";
//     await tx.save(sessOpts);

//     await notifyParties(tx, "processing", session, sourceCurrency);

//     if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
//     session.endSession();

//     return res.status(202).json({
//       success: true,
//       transactionId: tx._id.toString(),
//       reference: tx.reference,
//       flow: tx.flow,
//       status: tx.status,
//       providerStatus: tx.providerStatus,
//       fundsCaptured: !!tx.fundsCaptured,
//       beneficiaryCredited: !!tx.beneficiaryCredited,
//       adminRevenueCredited: !!tx.adminRevenueCredited,
//       message: "Transaction confirmée côté utilisateur et en attente du provider.",
//     });
//   } catch (err) {
//     try {
//       if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
//     } catch {}
//     session.endSession();
//     next(err);
//   }
// }

// module.exports = { confirmController };







"use strict";

const createError = require("http-errors");

const {
  Transaction,
  User,
  logTransaction,
  captureSenderReserve,
  creditReceiverFunds,
  creditAdminRevenue,
  startTxSession,
  maybeSessionOpts,
  CAN_USE_SHARED_SESSION,
  assertTransition,
} = require("../shared/runtime");

const { notifyTransactionEvent } = require("../transactionNotificationService");

const {
  sanitize,
  toFloat,
  round2,
  sha256Hex,
  looksLikeSha256Hex,
  safeEqualHex,
  MAX_CONFIRM_ATTEMPTS,
  LOCK_MINUTES,
} = require("../shared/helpers");

const INTERNAL_FLOW = "PAYNOVAL_INTERNAL_TRANSFER";
const OUTBOUND_EXTERNAL_FLOWS = new Set([
  "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  "PAYNOVAL_TO_BANK_PAYOUT",
  "PAYNOVAL_TO_CARD_PAYOUT",
]);
const INBOUND_EXTERNAL_FLOWS = new Set([
  "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
  "BANK_TRANSFER_TO_PAYNOVAL",
  "CARD_TOPUP_TO_PAYNOVAL",
]);

function isInternalTransfer(tx) {
  return tx?.flow === INTERNAL_FLOW;
}

function isOutboundExternalPayout(tx) {
  return OUTBOUND_EXTERNAL_FLOWS.has(String(tx?.flow || ""));
}

function isInboundExternalCollection(tx) {
  return INBOUND_EXTERNAL_FLOWS.has(String(tx?.flow || ""));
}

async function confirmController(req, res, next) {
  const session = await startTxSession();

  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

    const { transactionId, securityAnswer, securityCode } = req.body || {};
    const provided = sanitize(securityAnswer || securityCode || "");

    if (!transactionId || !provided) {
      throw createError(400, "transactionId et securityAnswer sont requis");
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw createError(401, "Token manquant");
    }

    const sessOpts = maybeSessionOpts(session);

    const tx = await Transaction.findById(transactionId)
      .select([
        "+flow",
        "+provider",
        "+providerStatus",
        "+providerReference",
        "+securityAnswerHash",
        "+securityCode",
        "+amount",
        "+transactionFees",
        "+netAmount",
        "+senderCurrencySymbol",
        "+localCurrencySymbol",
        "+localAmount",
        "+receiver",
        "+sender",
        "+feeSnapshot",
        "+attemptCount",
        "+lastAttemptAt",
        "+lockedUntil",
        "+status",
        "+exchangeRate",
        "+country",
        "+funds",
        "+recipientEmail",
        "+pricingSnapshot",
        "+adminRevenue",
        "+adminRevenueCredited",
        "+fundsReserved",
        "+fundsCaptured",
        "+beneficiaryCredited",
      ])
      .session(sessOpts.session || null);

    if (!tx) throw createError(404, "Transaction introuvable");

    logTransaction({
      userId: req.user?.id || req.user?._id || null,
      type: "confirm",
      provider: tx.provider || tx.funds || "paynoval",
      amount: toFloat(tx.amount),
      currency: tx.senderCurrencySymbol,
      toEmail: tx.recipientEmail || "",
      details: { transactionId: tx._id.toString(), flow: tx.flow },
      flagged: false,
      flagReason: "",
      transactionId: tx._id,
      ip: req.ip,
    }).catch(() => {});

    const now = new Date();

    if (tx.lockedUntil && tx.lockedUntil > now) {
      throw createError(
        423,
        `Transaction bloquée, réessayez après ${tx.lockedUntil.toLocaleTimeString("fr-FR")}`
      );
    }

    if (isInboundExternalCollection(tx)) {
      throw createError(
        409,
        "Cette transaction est pilotée par callback provider et ne se confirme pas manuellement."
      );
    }

    if (isInternalTransfer(tx)) {
      assertTransition(tx.status, "confirmed");

      if (String(tx.receiver) !== String(req.user.id)) {
        throw createError(403, "Vous n’êtes pas le destinataire de cette transaction");
      }
    } else if (isOutboundExternalPayout(tx)) {
      if (!["pending", "pending_review", "relaunch"].includes(String(tx.status || ""))) {
        throw createError(409, "Transaction non confirmable dans son état actuel");
      }

      if (String(tx.sender) !== String(req.user.id)) {
        throw createError(403, "Vous n’êtes pas autorisé à confirmer cette transaction");
      }
    } else {
      throw createError(400, `Flow non supporté pour confirm: ${tx.flow}`);
    }

    const storedHash = String(tx.securityAnswerHash || "") || String(tx.securityCode || "");
    if (!storedHash) {
      throw createError(500, "securityAnswerHash manquant sur la transaction");
    }

    const inputHash = sha256Hex(provided);
    const ok = looksLikeSha256Hex(storedHash)
      ? safeEqualHex(inputHash, storedHash)
      : safeEqualHex(inputHash, sha256Hex(String(storedHash)));

    if (!ok) {
      tx.attemptCount = (tx.attemptCount || 0) + 1;
      tx.lastAttemptAt = now;

      if (tx.attemptCount >= MAX_CONFIRM_ATTEMPTS) {
        tx.lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60 * 1000);
        tx.status = "locked";
        tx.providerStatus = "LOCKED_TOO_MANY_ATTEMPTS";
        await tx.save(sessOpts);

        await notifyTransactionEvent(tx, "locked", session, tx.senderCurrencySymbol);

        throw createError(423, `Réponse incorrecte. Transaction bloquée ${LOCK_MINUTES} min.`);
      }

      await tx.save(sessOpts);
      throw createError(
        401,
        `Réponse incorrecte. Il vous reste ${MAX_CONFIRM_ATTEMPTS - tx.attemptCount} essai(s).`
      );
    }

    tx.attemptCount = 0;
    tx.lastAttemptAt = null;
    tx.lockedUntil = null;

    const grossSource = round2(toFloat(tx.amount));
    const targetAmount = round2(toFloat(tx.localAmount));
    const sourceCurrency = String(tx.senderCurrencySymbol || "").trim().toUpperCase();
    const targetCurrency = String(tx.localCurrencySymbol || "").trim().toUpperCase();

    if (!tx.fundsReserved) {
      throw createError(409, "Fonds non réservés sur cette transaction");
    }

    if (!tx.fundsCaptured) {
      await captureSenderReserve({
        transaction: tx,
        senderId: tx.sender,
        amount: grossSource,
        currency: sourceCurrency,
        session,
      });

      tx.fundsCaptured = true;
      tx.fundsCapturedAt = new Date();
      tx.providerStatus = "FUNDS_CAPTURED";
    }

    if (isInternalTransfer(tx)) {
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
        tx.providerStatus = "BENEFICIARY_CREDITED";
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
        tx.providerStatus = "ADMIN_REVENUE_CREDITED";
      }

      tx.status = "confirmed";
      tx.confirmedAt = now;
      tx.executedAt = now;
      tx.providerStatus = "SUCCESS";

      await tx.save(sessOpts);
      await notifyTransactionEvent(tx, "confirmed", session, sourceCurrency);

      if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
      session.endSession();

      return res.json({
        success: true,
        transactionId: tx._id.toString(),
        reference: tx.reference,
        flow: tx.flow,
        status: tx.status,
        providerStatus: tx.providerStatus,
        credited: targetAmount,
        currencyCredited: targetCurrency,
        pricingSnapshot: tx.pricingSnapshot || null,
        adminRevenue: tx.adminRevenue || null,
        fundsCaptured: !!tx.fundsCaptured,
        beneficiaryCredited: !!tx.beneficiaryCredited,
        adminRevenueCredited: !!tx.adminRevenueCredited,
      });
    }

    tx.status = "processing";
    tx.providerStatus = tx.providerReference
      ? "PROVIDER_SUBMITTED"
      : "CONFIRMED_BY_USER_PENDING_PROVIDER";
    await tx.save(sessOpts);

    await notifyTransactionEvent(tx, "processing", session, sourceCurrency);

    if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
    session.endSession();

    return res.status(202).json({
      success: true,
      transactionId: tx._id.toString(),
      reference: tx.reference,
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      fundsCaptured: !!tx.fundsCaptured,
      beneficiaryCredited: !!tx.beneficiaryCredited,
      adminRevenueCredited: !!tx.adminRevenueCredited,
      message: "Transaction confirmée côté utilisateur et en attente du provider.",
    });
  } catch (err) {
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    next(err);
  }
}

module.exports = { confirmController };