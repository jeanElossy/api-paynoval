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
  assertTransition,
  runInTransaction,
  safeAbort,
  safeEndSession,
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

/**
 * Volet sandbox.
 *
 * Ne valide plus lui-même la session et NE RÉPOND PLUS : il mute la
 * transaction, l'enregistre dans la session qu'on lui donne, et rend le corps
 * de la réponse à l'appelant. C'est l'appelant qui décide quand la transaction
 * est acquise, et lui seul qui écrit sur `res` — une fois, après le commit.
 *
 * La raison est le rejeu : `session.withTransaction()` peut réexécuter tout le
 * corps si Mongo signale un conflit d'écriture. Une réponse HTTP émise depuis
 * l'intérieur serait envoyée deux fois, et la seconde lèverait
 * ERR_HTTP_HEADERS_SENT sur une transaction pourtant valide.
 */
async function applySandboxCancel({ req, tx, reason, sessOpts }) {
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

  return {
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
  };
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

/**
 * Les champs nécessaires à l'annulation, en un seul endroit : la phase de
 * devis et la phase transactionnelle doivent lire EXACTEMENT le même jeu de
 * champs, sinon la comparaison entre les deux ne veut rien dire.
 */
const CANCEL_SELECT = [
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
];

function loadCancelTarget(transactionId, sessOpts) {
  return Transaction.findById(transactionId)
    .select(CANCEL_SELECT)
    .session(sessOpts?.session || null);
}

function resolveSourceCurrency(tx) {
  return String(tx?.senderCurrencySymbol || tx?.currencySource || "")
    .trim()
    .toUpperCase();
}

/**
 * Toutes les vérifications d'autorisation et d'état, regroupées et PURES.
 *
 * Elles tournent deux fois : une première fois hors transaction, pour rejeter
 * une demande invalide sans avoir ouvert quoi que ce soit ; puis à nouveau
 * DANS la transaction, sur l'état lu sous session — c'est cette seconde
 * exécution qui fait foi. La première n'est qu'une politesse envers le
 * serveur.
 */
function assertCancellable({ req, tx }) {
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
      throw createError(403, "Seul l’expéditeur peut annuler cette transaction");
    }
  } else {
    throw createError(400, `Flow non supporté pour cancel: ${tx.flow}`);
  }

  if (tx.fundsCaptured || tx.beneficiaryCredited) {
    throw createError(409, "Transaction déjà exécutée, annulation impossible");
  }

  const sourceCurrency = resolveSourceCurrency(tx);

  if (!sourceCurrency) {
    throw createError(500, "Devise source introuvable sur la transaction");
  }

  const grossSource = round2(toFloat(tx.amount));
  const netStored = round2(toFloat(tx.netAmount));
  const staticFee = getStaticCancellationFee(sourceCurrency);
  const cancellationFee = round2(staticFee.amount);

  if (cancellationFee > grossSource) {
    throw createError(400, "Frais d’annulation supérieurs au montant réservé");
  }

  if (cancellationFee > netStored && netStored > 0) {
    throw createError(400, "Frais d’annulation supérieurs au net à rembourser");
  }

  return {
    userId,
    senderId,
    receiverId,
    sourceCurrency,
    grossSource,
    netStored,
    cancellationFee,
    cancellationFeeType: staticFee.type || "fixed",
    cancellationFeePercent: Number(staticFee.percent || 0) || 0,
    cancellationFeeSource: staticFee.source || "static_rule",
  };
}

async function cancelController(req, res, next) {
  const session = await startTxSession();

  try {
    const { transactionId, reason = "Annulé" } = req.body || {};

    if (!transactionId) {
      throw createError(400, "transactionId requis pour annuler");
    }

    /**
     * ════════════════════════════════════════════════════════════════════
     * PHASE 1 — DEVIS. AUCUNE ÉCRITURE, AUCUNE TRANSACTION OUVERTE.
     * ════════════════════════════════════════════════════════════════════
     *
     * `resolveTreasuryCreditInCad()` appelle `convertAmount()`, qui interroge
     * le service de taux du backend principal par HTTP — 5 s de délai
     * d'attente, cache mémoire de 10 minutes. Ce n'est donc PAS un appel
     * gratuit : une fois sur N il part sur le réseau.
     *
     * Le laisser à l'intérieur de la transaction, c'est tenir des verrous
     * Mongo pendant qu'on attend un tiers ; et au-delà de
     * `transactionLifetimeLimitSeconds` (60 s par défaut) le serveur tue la
     * transaction sous nos pieds. C'est le même défaut que celui corrigé dans
     * `submitExternalExecution`, à cela près qu'ici l'appel est masqué
     * derrière deux niveaux d'indirection.
     *
     * On le sort donc, comme Stripe et Wise sortent la cotation du taux de la
     * validation du mouvement : le taux est un DEVIS, pris avant, revérifié
     * après. La phase 2 refuse de s'en servir s'il ne correspond plus.
     */
    const preview = await loadCancelTarget(transactionId, null);

    if (!preview) {
      throw createError(404, "Transaction introuvable");
    }

    const previewIsSandbox = isSandboxTx(preview);
    let quote = null;

    if (!previewIsSandbox) {
      logTransaction({
        userId: getAuthedUserId(req) || null,
        type: "cancel",
        provider: preview.provider || preview.funds || "paynoval",
        amount: toFloat(preview.amount),
        currency: preview.senderCurrencySymbol,
        toEmail: preview.recipientEmail || "",
        details: {
          transactionId: preview._id.toString(),
          reason,
          flow: preview.flow,
          treasurySystemType: FEES_TREASURY_SYSTEM_TYPE,
        },
        flagged: false,
        flagReason: "",
        transactionId: preview._id,
        ip: req.ip,
      }).catch(() => {});

      const previewCheck = assertCancellable({ req, tx: preview });

      const fx = await resolveTreasuryCreditInCad({
        cancellationFee: previewCheck.cancellationFee,
        sourceCurrency: previewCheck.sourceCurrency,
      });

      quote = {
        sourceCurrency: previewCheck.sourceCurrency,
        cancellationFee: previewCheck.cancellationFee,
        ...fx,
      };
    }

    /**
     * ════════════════════════════════════════════════════════════════════
     * PHASE 2 — UNITÉ DE TRAVAIL. REJOUABLE DE BOUT EN BOUT.
     * ════════════════════════════════════════════════════════════════════
     *
     * Tout ce qui suit est relu sous session et peut être réexécuté
     * intégralement par le pilote si Mongo signale un conflit d'écriture. Rien
     * ici ne sort de la base : pas de réseau, pas de réponse HTTP, pas d'effet
     * de bord non annulable.
     */
    const body = await runInTransaction(session, async (sess) => {
      const sessOpts = maybeSessionOpts(sess);

      const tx = await loadCancelTarget(transactionId, sessOpts);

      if (!tx) {
        throw createError(404, "Transaction introuvable");
      }

      if (isSandboxTx(tx)) {
        return applySandboxCancel({ req, tx, reason, sessOpts });
      }

      const {
        userId,
        receiverId,
        sourceCurrency,
        grossSource,
        cancellationFee,
        cancellationFeeType,
        cancellationFeePercent,
        cancellationFeeSource,
      } = assertCancellable({ req, tx });

      /**
       * Le devis a été calculé hors transaction, sur un état qui a pu changer
       * depuis. S'il ne correspond plus, on refuse plutôt que d'appliquer un
       * taux périmé à un montant qui n'est plus le même. Le client réessaie —
       * et son en-tête `Idempotency-Key` garantit qu'il ne paiera pas deux
       * fois pour autant.
       */
      if (
        !quote ||
        quote.sourceCurrency !== sourceCurrency ||
        quote.cancellationFee !== cancellationFee
      ) {
        throw createError(
          409,
          "La transaction a changé pendant l’annulation, veuillez réessayer"
        );
      }

      const {
        treasuryFeeAmount,
        treasuryFeeCurrency,
        treasuryConversionRate,
      } = quote;

      const cancellationFeeId = null;

      if (tx.fundsReserved && !tx.reserveReleased) {
        await releaseSenderReserve({
          transaction: tx,
          senderId: tx.sender,
          amount: grossSource,
          currency: sourceCurrency,
          session: sess,
        });

        tx.reserveReleased = true;
        tx.reserveReleasedAt = new Date();
      }

      const treasuryMeta =
        cancellationFee > 0 ? resolveFeesTreasuryMeta(tx) : null;

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
          session: sess,
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

      /**
       * Écrit dans l'Outbox SOUS LA MÊME SESSION : si la transaction est
       * annulée, l'événement disparaît avec elle. Aucune notification n'est
       * émise en direct — c'est le worker qui draine l'Outbox après le commit.
       */
      await notifyTransactionEvent(tx, "cancelled", sess, sourceCurrency);

      return {
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
        treasuryUserId:
          treasuryMeta?.treasuryUserId || tx.treasuryUserId || null,
        treasurySystemType:
          treasuryMeta?.treasurySystemType ||
          tx.treasurySystemType ||
          FEES_TREASURY_SYSTEM_TYPE,
        treasuryLabel:
          treasuryMeta?.treasuryLabel || tx.treasuryLabel || FEES_TREASURY_LABEL,
        feeChargeResult: feeChargeResult || null,
      };
    });

    /**
     * PHASE 3 — la réponse, une seule fois, après le commit. Tant qu'on n'est
     * pas ici, rien n'a été promis au client.
     */
    return res.json(body);
  } catch (err) {
    await safeAbort(session);
    next(err);
  } finally {
    await safeEndSession(session);
  }
}

module.exports = { cancelController };
