// "use strict";

// const createError = require("http-errors");

// const {
//   axios,
//   Transaction,
//   User,
//   logTransaction,
//   releaseSenderReserve,
//   chargeCancellationFee,
//   convertAmount,
//   GATEWAY_URL,
//   INTERNAL_TOKEN,
//   startTxSession,
//   maybeSessionOpts,
//   CAN_USE_SHARED_SESSION,
//   assertTransition,
// } = require("../shared/runtime");

// const { notifyParties } = require("../shared/notifications");
// const { sanitize, toFloat, round2, getGatewayBase } = require("../shared/helpers");

// const INTERNAL_FLOW = "PAYNOVAL_INTERNAL_TRANSFER";
// const OUTBOUND_EXTERNAL_FLOWS = new Set([
//   "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
//   "PAYNOVAL_TO_BANK_PAYOUT",
//   "PAYNOVAL_TO_CARD_PAYOUT",
// ]);

// function isInternalTransfer(tx) {
//   return tx?.flow === INTERNAL_FLOW;
// }

// function isOutboundExternalPayout(tx) {
//   return OUTBOUND_EXTERNAL_FLOWS.has(String(tx?.flow || ""));
// }

// async function cancelController(req, res, next) {
//   const session = await startTxSession();

//   try {
//     if (CAN_USE_SHARED_SESSION) session.startTransaction();

//     const { transactionId, reason = "Annulé" } = req.body;
//     if (!transactionId) throw createError(400, "transactionId requis pour annuler");

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
//         "+beneficiaryCredited",
//         "+cancellationFee",
//         "+cancellationFeeType",
//         "+cancellationFeePercent",
//         "+cancellationFeeId",
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
//       details: { transactionId: tx._id.toString(), reason, flow: tx.flow },
//       flagged: false,
//       flagReason: "",
//       transactionId: tx._id,
//       ip: req.ip,
//     }).catch(() => {});

//     assertTransition(tx.status, "cancelled");

//     const userId = String(req.user.id);
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

//     /**
//      * Si déjà exécutée / créditée -> trop tard
//      */
//     if (tx.fundsCaptured || tx.beneficiaryCredited) {
//       throw createError(409, "Transaction déjà exécutée, annulation impossible");
//     }

//     const grossSource = round2(toFloat(tx.amount));
//     const netStored = round2(toFloat(tx.netAmount));
//     const sourceCurrency = String(tx.senderCurrencySymbol || "").trim().toUpperCase();

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

//     let cancellationFee = 0;
//     let cancellationFeeType = "fixed";
//     let cancellationFeePercent = 0;
//     let cancellationFeeId = null;

//     try {
//       const gatewayBase = getGatewayBase(GATEWAY_URL);

//       const { data } = await axios.get(`${gatewayBase}/fees/simulate`, {
//         params: {
//           provider: tx.provider || tx.funds || "paynoval",
//           amount: String(tx.amount),
//           fromCurrency: sourceCurrency,
//           toCurrency: sourceCurrency,
//           type: "cancellation",
//         },
//         headers: {
//           ...(INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : {}),
//           ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
//         },
//         timeout: 8000,
//       });

//       if (data && data.success) {
//         cancellationFee = toFloat(data.data?.fees, 0);
//         cancellationFeeType = data.data?.type || "fixed";
//         cancellationFeePercent = data.data?.feePercent || 0;
//         cancellationFeeId = data.data?.feeId || null;
//       }
//     } catch {
//       if (["USD", "CAD", "EUR"].includes(sourceCurrency)) cancellationFee = 2.99;
//       else if (["XOF", "XAF"].includes(sourceCurrency)) cancellationFee = 300;
//     }

//     cancellationFee = round2(cancellationFee);

//     if (cancellationFee > netStored) {
//       throw createError(400, "Frais d’annulation supérieurs au net à rembourser");
//     }

//     let adminFeeConverted = 0;
//     let conversionRateToCAD = 0;

//     if (cancellationFee > 0) {
//       try {
//         const converted = await convertAmount(sourceCurrency, "CAD", cancellationFee);
//         adminFeeConverted = round2(toFloat(converted?.converted, 0));
//         conversionRateToCAD = Number(converted?.rate || 0);
//       } catch {
//         adminFeeConverted = 0;
//         conversionRateToCAD = 0;
//       }
//     }

//     let adminUserId = null;
//     if (adminFeeConverted > 0) {
//       const adminUser = await User.findOne({ email: "admin@paynoval.com" })
//         .select("_id")
//         .session(sessOpts.session || null);

//       if (!adminUser) {
//         throw createError(500, "Compte administrateur introuvable");
//       }
//       adminUserId = adminUser._id;
//     }

//     let feeChargeResult = null;
//     if (cancellationFee > 0 && adminUserId) {
//       feeChargeResult = await chargeCancellationFee({
//         transaction: tx,
//         senderId: tx.sender,
//         senderCurrency: sourceCurrency,
//         feeSourceAmount: cancellationFee,
//         adminUserId,
//         adminFeeCAD: adminFeeConverted,
//         conversionRateToCAD,
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

//     await tx.save(sessOpts);

//     await notifyParties(tx, "cancelled", session, sourceCurrency);

//     if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
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
//       currency: sourceCurrency,
//       cancellationFeeInSenderCurrency: cancellationFee,
//       cancellationFeeType,
//       cancellationFeePercent,
//       cancellationFeeId,
//       adminFeeCredited: adminFeeConverted,
//       adminCurrency: "CAD",
//       feeChargeResult: feeChargeResult || null,
//     });
//   } catch (err) {
//     try {
//       if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
//     } catch {}
//     session.endSession();
//     next(err);
//   }
// }

// module.exports = { cancelController };




"use strict";

const createError = require("http-errors");

const {
  axios,
  Transaction,
  User,
  logTransaction,
  releaseSenderReserve,
  chargeCancellationFee,
  convertAmount,
  GATEWAY_URL,
  INTERNAL_TOKEN,
  startTxSession,
  maybeSessionOpts,
  CAN_USE_SHARED_SESSION,
  assertTransition,
} = require("../shared/runtime");

const { notifyTransactionEvent } = require("../transactionNotificationService");

const { sanitize, toFloat, round2, getGatewayBase } = require("../shared/helpers");

const INTERNAL_FLOW = "PAYNOVAL_INTERNAL_TRANSFER";
const OUTBOUND_EXTERNAL_FLOWS = new Set([
  "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  "PAYNOVAL_TO_BANK_PAYOUT",
  "PAYNOVAL_TO_CARD_PAYOUT",
]);

function isInternalTransfer(tx) {
  return tx?.flow === INTERNAL_FLOW;
}

function isOutboundExternalPayout(tx) {
  return OUTBOUND_EXTERNAL_FLOWS.has(String(tx?.flow || ""));
}

async function cancelController(req, res, next) {
  const session = await startTxSession();

  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

    const { transactionId, reason = "Annulé" } = req.body;
    if (!transactionId) throw createError(400, "transactionId requis pour annuler");

    const sessOpts = maybeSessionOpts(session);

    const tx = await Transaction.findById(transactionId)
      .select([
        "+reference",
        "+flow",
        "+provider",
        "+providerStatus",
        "+providerReference",
        "+amount",
        "+netAmount",
        "+senderCurrencySymbol",
        "+sender",
        "+receiver",
        "+status",
        "+funds",
        "+recipientEmail",
        "+fundsReserved",
        "+fundsCaptured",
        "+reserveReleased",
        "+beneficiaryCredited",
        "+cancellationFee",
        "+cancellationFeeType",
        "+cancellationFeePercent",
        "+cancellationFeeId",
      ])
      .session(sessOpts.session || null);

    if (!tx) throw createError(404, "Transaction introuvable");

    logTransaction({
      userId: req.user?.id || req.user?._id || null,
      type: "cancel",
      provider: tx.provider || tx.funds || "paynoval",
      amount: toFloat(tx.amount),
      currency: tx.senderCurrencySymbol,
      toEmail: tx.recipientEmail || "",
      details: { transactionId: tx._id.toString(), reason, flow: tx.flow },
      flagged: false,
      flagReason: "",
      transactionId: tx._id,
      ip: req.ip,
    }).catch(() => {});

    assertTransition(tx.status, "cancelled");

    const userId = String(req.user.id);
    const senderId = String(tx.sender || "");
    const receiverId = String(tx.receiver || "");

    if (isInternalTransfer(tx)) {
      if (userId !== senderId && userId !== receiverId) {
        throw createError(403, "Vous n’êtes pas autorisé à annuler");
      }
    } else if (isOutboundExternalPayout(tx)) {
      if (userId !== senderId) {
        throw createError(403, "Seul l’expéditeur peut annuler cette transaction");
      }
    } else {
      throw createError(400, `Flow non supporté pour cancel: ${tx.flow}`);
    }

    if (tx.fundsCaptured || tx.beneficiaryCredited) {
      throw createError(409, "Transaction déjà exécutée, annulation impossible");
    }

    const grossSource = round2(toFloat(tx.amount));
    const netStored = round2(toFloat(tx.netAmount));
    const sourceCurrency = String(tx.senderCurrencySymbol || "").trim().toUpperCase();

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

    let cancellationFee = 0;
    let cancellationFeeType = "fixed";
    let cancellationFeePercent = 0;
    let cancellationFeeId = null;

    try {
      const gatewayBase = getGatewayBase(GATEWAY_URL);

      const { data } = await axios.get(`${gatewayBase}/fees/simulate`, {
        params: {
          provider: tx.provider || tx.funds || "paynoval",
          amount: String(tx.amount),
          fromCurrency: sourceCurrency,
          toCurrency: sourceCurrency,
          type: "cancellation",
        },
        headers: {
          ...(INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : {}),
          ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        },
        timeout: 8000,
      });

      if (data && data.success) {
        cancellationFee = toFloat(data.data?.fees, 0);
        cancellationFeeType = data.data?.type || "fixed";
        cancellationFeePercent = data.data?.feePercent || 0;
        cancellationFeeId = data.data?.feeId || null;
      }
    } catch {
      if (["USD", "CAD", "EUR"].includes(sourceCurrency)) cancellationFee = 2.99;
      else if (["XOF", "XAF"].includes(sourceCurrency)) cancellationFee = 300;
    }

    cancellationFee = round2(cancellationFee);

    if (cancellationFee > netStored) {
      throw createError(400, "Frais d’annulation supérieurs au net à rembourser");
    }

    let adminFeeConverted = 0;
    let conversionRateToCAD = 0;

    if (cancellationFee > 0) {
      try {
        const converted = await convertAmount(sourceCurrency, "CAD", cancellationFee);
        adminFeeConverted = round2(toFloat(converted?.converted, 0));
        conversionRateToCAD = Number(converted?.rate || 0);
      } catch {
        adminFeeConverted = 0;
        conversionRateToCAD = 0;
      }
    }

    let adminUserId = null;
    if (adminFeeConverted > 0) {
      const adminUser = await User.findOne({ email: "admin@paynoval.com" })
        .select("_id")
        .session(sessOpts.session || null);

      if (!adminUser) {
        throw createError(500, "Compte administrateur introuvable");
      }
      adminUserId = adminUser._id;
    }

    let feeChargeResult = null;
    if (cancellationFee > 0 && adminUserId) {
      feeChargeResult = await chargeCancellationFee({
        transaction: tx,
        senderId: tx.sender,
        senderCurrency: sourceCurrency,
        feeSourceAmount: cancellationFee,
        adminUserId,
        adminFeeCAD: adminFeeConverted,
        conversionRateToCAD,
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

    await tx.save(sessOpts);

    await notifyTransactionEvent(tx, "cancelled", session, sourceCurrency);

    if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
    session.endSession();

    return res.json({
      success: true,
      transactionId: tx._id.toString(),
      reference: tx.reference,
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      reserveReleased: !!tx.reserveReleased,
      releasedAmount: grossSource,
      currency: sourceCurrency,
      cancellationFeeInSenderCurrency: cancellationFee,
      cancellationFeeType,
      cancellationFeePercent,
      cancellationFeeId,
      adminFeeCredited: adminFeeConverted,
      adminCurrency: "CAD",
      feeChargeResult: feeChargeResult || null,
    });
  } catch (err) {
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    next(err);
  }
}

module.exports = { cancelController };