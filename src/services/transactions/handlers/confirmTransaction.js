// "use strict";

// const createError = require("http-errors");

// const {
//   Transaction,
//   captureSenderReserve,
//   creditReceiverFunds,
//   creditTreasuryRevenue,
//   resolveTreasuryFromSystemType,
//   normalizeTreasurySystemType,
//   startTxSession,
//   maybeSessionOpts,
//   canUseSharedSession,
//   assertTransition,
// } = require("../shared/runtime");

// const { notifyTransactionEvent } = require("../transactionNotificationService");
// const { syncReferralAfterConfirmedTx } = require("../../referralSyncService");

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

// const DEFAULT_FEES_TREASURY_SYSTEM_TYPE = "FEES_TREASURY";
// const DEFAULT_FEES_TREASURY_LABEL = "PayNoval Fees Treasury";

// function isInternalTransfer(tx) {
//   return tx?.flow === INTERNAL_FLOW;
// }

// function isOutboundExternalPayout(tx) {
//   return OUTBOUND_EXTERNAL_FLOWS.has(String(tx?.flow || ""));
// }

// function isInboundExternalCollection(tx) {
//   return INBOUND_EXTERNAL_FLOWS.has(String(tx?.flow || ""));
// }

// function buildReferralSyncError(err) {
//   return {
//     ok: false,
//     skipped: true,
//     reason: "REFERRAL_SYNC_EXCEPTION",
//     error: err?.message || "Referral sync failed",
//   };
// }

// function resolveFeesTreasuryMeta(tx) {
//   const treasurySystemType = normalizeTreasurySystemType(
//     tx?.treasurySystemType || DEFAULT_FEES_TREASURY_SYSTEM_TYPE
//   );

//   const treasuryUserId = String(
//     tx?.treasuryUserId || resolveTreasuryFromSystemType(treasurySystemType) || ""
//   ).trim();

//   const treasuryLabel = String(
//     tx?.treasuryLabel || DEFAULT_FEES_TREASURY_LABEL
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

// async function confirmController(req, res, next) {
//   const session = await startTxSession();

//   try {
//     if (canUseSharedSession()) session.startTransaction();

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
//         "+userId",
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
//         "+treasuryRevenue",
//         "+treasuryRevenueCredited",
//         "+treasuryRevenueCreditedAt",
//         "+treasuryUserId",
//         "+treasurySystemType",
//         "+treasuryLabel",
//         "+fundsReserved",
//         "+fundsCaptured",
//         "+beneficiaryCredited",
//         "+reference",
//         "+confirmedAt",
//       ])
//       .session(sessOpts.session || null);

//     if (!tx) throw createError(404, "Transaction introuvable");

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
//         throw createError(
//           403,
//           "Vous n’êtes pas le destinataire de cette transaction"
//         );
//       }
//     } else if (isOutboundExternalPayout(tx)) {
//       if (!["pending", "pending_review", "relaunch"].includes(String(tx.status || ""))) {
//         throw createError(409, "Transaction non confirmable dans son état actuel");
//       }

//       if (String(tx.sender) !== String(req.user.id)) {
//         throw createError(
//           403,
//           "Vous n’êtes pas autorisé à confirmer cette transaction"
//         );
//       }
//     } else {
//       throw createError(400, `Flow non supporté pour confirm: ${tx.flow}`);
//     }

//     const storedHash =
//       String(tx.securityAnswerHash || "") || String(tx.securityCode || "");

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

//         await notifyTransactionEvent(tx, "locked", session, tx.senderCurrencySymbol);

//         throw createError(
//           423,
//           `Réponse incorrecte. Transaction bloquée ${LOCK_MINUTES} min.`
//         );
//       }

//       await tx.save(sessOpts);
//       throw createError(
//         401,
//         `Réponse incorrecte. Il vous reste ${
//           MAX_CONFIRM_ATTEMPTS - tx.attemptCount
//         } essai(s).`
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

//       if (!tx.treasuryRevenueCredited) {
//         const treasuryMeta = resolveFeesTreasuryMeta(tx);

//         const creditResult = await creditTreasuryRevenue({
//           transaction: tx,
//           pricingSnapshot: tx.pricingSnapshot || {},
//           treasurySystemType: treasuryMeta.treasurySystemType,
//           treasuryLabel: treasuryMeta.treasuryLabel,
//           session,
//         });

//         tx.treasuryRevenue = creditResult?.treasuryRevenue || null;
//         tx.treasuryRevenueCredited = true;
//         tx.treasuryRevenueCreditedAt = new Date();
//         tx.treasuryUserId = treasuryMeta.treasuryUserId;
//         tx.treasurySystemType = treasuryMeta.treasurySystemType;
//         tx.treasuryLabel = treasuryMeta.treasuryLabel;
//         tx.providerStatus = "TREASURY_REVENUE_CREDITED";
//       }

//       tx.status = "confirmed";
//       tx.confirmedAt = now;
//       tx.executedAt = now;
//       tx.providerStatus = "SUCCESS";

//       await tx.save(sessOpts);
//       await notifyTransactionEvent(tx, "confirmed", session, sourceCurrency);

//       if (canUseSharedSession()) {
//         await session.commitTransaction();
//       }
//       session.endSession();

//       let referralSync = null;
//       try {
//         referralSync = await syncReferralAfterConfirmedTx(tx);
//       } catch (refErr) {
//         referralSync = buildReferralSyncError(refErr);
//       }

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
//         treasuryRevenue: tx.treasuryRevenue || null,
//         fundsCaptured: !!tx.fundsCaptured,
//         beneficiaryCredited: !!tx.beneficiaryCredited,
//         treasuryRevenueCredited: !!tx.treasuryRevenueCredited,
//         treasuryUserId: tx.treasuryUserId || null,
//         treasurySystemType: tx.treasurySystemType || null,
//         treasuryLabel: tx.treasuryLabel || null,
//         referralSync,
//       });
//     }

//     tx.status = "processing";
//     tx.providerStatus = tx.providerReference
//       ? "PROVIDER_SUBMITTED"
//       : "CONFIRMED_BY_USER_PENDING_PROVIDER";

//     await tx.save(sessOpts);
//     await notifyTransactionEvent(tx, "processing", session, sourceCurrency);

//     if (canUseSharedSession()) {
//       await session.commitTransaction();
//     }
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
//       treasuryRevenueCredited: !!tx.treasuryRevenueCredited,
//       message: "Transaction confirmée côté utilisateur et en attente du provider.",
//     });
//   } catch (err) {
//     try {
//       if (canUseSharedSession()) await session.abortTransaction();
//     } catch {}
//     session.endSession();
//     next(err);
//   }
// }

// module.exports = { confirmController };





"use strict";

const createError = require("http-errors");

const {
  User,
  Transaction,
  captureSenderReserve,
  creditReceiverFunds,
  creditTreasuryRevenue,
  resolveTreasuryFromSystemType,
  normalizeTreasurySystemType,
  startTxSession,
  maybeSessionOpts,
  canUseSharedSession,
  assertTransition,
} = require("../shared/runtime");

const { notifyTransactionEvent } = require("../transactionNotificationService");
const { syncReferralAfterConfirmedTx } = require("../../referralSyncService");

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

const {
  normalizeCurrency,
  getCountryKey,
  getCurrencyByCountry,
  validatePaynovalUserProfile,
} = require("./corridorValidation");

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

const DEFAULT_FEES_TREASURY_SYSTEM_TYPE = "FEES_TREASURY";
const DEFAULT_FEES_TREASURY_LABEL = "PayNoval Fees Treasury";

const USER_CORRIDOR_SELECT = [
  "_id",
  "fullName",
  "email",
  "phone",

  "country",
  "countryCode",
  "selectedCountry",
  "residenceCountry",
  "registrationCountry",
  "nationality",

  "currency",
  "currencyCode",
  "defaultCurrency",
  "managedCurrency",

  "userType",
  "role",
  "isBusiness",
  "isSystem",
  "systemType",

  "accountStatus",
  "status",
  "staffStatus",

  "isBlocked",
  "isLoginDisabled",
  "hiddenFromTransfers",
  "hiddenFromUserSearch",
  "hiddenFromUserApp",

  "kycStatus",
  "kybStatus",

  "kyc",
  "kyb",
  "profile",
  "address",
  "wallet",

  "isDeleted",
  "deletedAt",
].join(" ");

function isInternalTransfer(tx) {
  return tx?.flow === INTERNAL_FLOW;
}

function isOutboundExternalPayout(tx) {
  return OUTBOUND_EXTERNAL_FLOWS.has(String(tx?.flow || ""));
}

function isInboundExternalCollection(tx) {
  return INBOUND_EXTERNAL_FLOWS.has(String(tx?.flow || ""));
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

function getCorridorLock(tx) {
  return (
    tx?.metadata?.corridorLock ||
    tx?.meta?.corridorLock ||
    tx?.metadata?.extra?.corridorLock ||
    tx?.meta?.extra?.corridorLock ||
    null
  );
}

function assertCorridorLockIsValid(tx) {
  const lock = getCorridorLock(tx);

  if (!lock || typeof lock !== "object") {
    throw createError(
      409,
      "Transaction sans verrou de corridor. Veuillez recréer la transaction."
    );
  }

  if (Number(lock.version || 0) !== 1) {
    throw createError(409, "Version du verrou de corridor non supportée.");
  }

  if (String(lock.flow || "") !== String(tx.flow || "")) {
    throw createError(
      409,
      "Le flow de la transaction ne correspond pas au verrou de corridor."
    );
  }

  const sourceCurrency =
    normalizeCurrency(tx.currencySource) ||
    normalizeCurrency(tx.senderCurrencySymbol) ||
    normalizeCurrency(tx.money?.source?.currency);

  const targetCurrency =
    normalizeCurrency(tx.currencyTarget) ||
    normalizeCurrency(tx.localCurrencySymbol) ||
    normalizeCurrency(tx.money?.target?.currency);

  const lockedSourceCurrency = normalizeCurrency(lock.sourceCurrency);
  const lockedTargetCurrency = normalizeCurrency(lock.targetCurrency);

  if (
    lockedSourceCurrency &&
    sourceCurrency &&
    lockedSourceCurrency !== sourceCurrency
  ) {
    throw createError(
      409,
      "La devise source de la transaction ne correspond pas au verrou de corridor."
    );
  }

  if (
    lockedTargetCurrency &&
    targetCurrency &&
    lockedTargetCurrency !== targetCurrency
  ) {
    throw createError(
      409,
      "La devise destination de la transaction ne correspond pas au verrou de corridor."
    );
  }

  const txTargetCountry = getCountryKey(tx.country);
  const lockTargetCountry = getCountryKey(lock.targetCountry);

  if (
    txTargetCountry &&
    lockTargetCountry &&
    txTargetCountry !== lockTargetCountry
  ) {
    throw createError(
      409,
      "Le pays destination de la transaction ne correspond pas au verrou de corridor."
    );
  }

  const expectedTargetCurrency = getCurrencyByCountry(lock.targetCountry);

  if (
    expectedTargetCurrency &&
    lockedTargetCurrency &&
    expectedTargetCurrency !== lockedTargetCurrency
  ) {
    throw createError(
      409,
      "La devise verrouillée ne correspond pas à la devise locale du pays destination."
    );
  }

  return lock;
}

function assertUserStillMatchesLock({
  user,
  expectedCountry,
  expectedCurrency,
  roleLabel,
  codePrefix,
}) {
  const profileLock = validatePaynovalUserProfile({
    user,
    requestedCountry: expectedCountry,
    requestedCurrency: expectedCurrency,
    roleLabel,
    codePrefix,
  });

  const currentCountry = getCountryKey(profileLock.country);
  const lockedCountry = getCountryKey(expectedCountry);

  if (!currentCountry || !lockedCountry || currentCountry !== lockedCountry) {
    throw createError(
      409,
      `Le pays actuel du compte ${roleLabel} ne correspond plus à la transaction.`
    );
  }

  const currentCurrency = normalizeCurrency(profileLock.currency);
  const lockedCurrency = normalizeCurrency(expectedCurrency);

  if (!currentCurrency || !lockedCurrency || currentCurrency !== lockedCurrency) {
    throw createError(
      409,
      `La devise actuelle du compte ${roleLabel} ne correspond plus à la transaction.`
    );
  }
}

async function assertCurrentProfilesStillMatchCorridor({ tx, lock, session }) {
  if (!User) {
    throw createError(500, "User model indisponible pour validation corridor");
  }

  if (isInternalTransfer(tx)) {
    const [senderUser, receiverUser] = await Promise.all([
      User.findById(tx.sender)
        .select(USER_CORRIDOR_SELECT)
        .lean()
        .session(session || null),

      User.findById(tx.receiver)
        .select(USER_CORRIDOR_SELECT)
        .lean()
        .session(session || null),
    ]);

    assertUserStillMatchesLock({
      user: senderUser,
      expectedCountry: lock.sourceCountry,
      expectedCurrency: lock.sourceCurrency,
      roleLabel: "expéditeur",
      codePrefix: "SENDER",
    });

    assertUserStillMatchesLock({
      user: receiverUser,
      expectedCountry: lock.targetCountry,
      expectedCurrency: lock.targetCurrency,
      roleLabel: "destinataire",
      codePrefix: "RECIPIENT",
    });

    return;
  }

  if (isOutboundExternalPayout(tx)) {
    const senderUser = await User.findById(tx.sender)
      .select(USER_CORRIDOR_SELECT)
      .lean()
      .session(session || null);

    assertUserStillMatchesLock({
      user: senderUser,
      expectedCountry: lock.sourceCountry,
      expectedCurrency: lock.sourceCurrency,
      roleLabel: "expéditeur",
      codePrefix: "SENDER",
    });
  }
}

function isAlreadyAutoCancelledOrFinal(tx) {
  const status = String(tx?.status || "").trim().toLowerCase();

  return (
    !!tx?.autoCancelledAt ||
    tx?.providerStatus === "AUTO_CANCELLED_EXPIRED" ||
    ["cancelled", "canceled", "failed", "refunded", "reversed"].includes(status)
  );
}

function isExpiredBeforeConfirmation(tx, now = new Date()) {
  if (!tx?.autoCancelAt) return false;

  const autoCancelDate = new Date(tx.autoCancelAt);
  if (!Number.isFinite(autoCancelDate.getTime())) return false;
  if (autoCancelDate > now) return false;

  return (
    !tx.confirmedAt &&
    !tx.executedAt &&
    tx.fundsCaptured !== true &&
    tx.beneficiaryCredited !== true
  );
}

async function endQuietly(session) {
  try {
    if (session) session.endSession();
  } catch {}
}

async function abortQuietly(session) {
  try {
    if (session && canUseSharedSession()) {
      await session.abortTransaction();
    }
  } catch {}
}

async function confirmController(req, res, next) {
  const session = await startTxSession();

  try {
    if (canUseSharedSession()) {
      session.startTransaction();
    }

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
        "+userId",
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
        "+currencySource",
        "+currencyTarget",
        "+money",

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
        "+treasuryRevenue",
        "+treasuryRevenueCredited",
        "+treasuryRevenueCreditedAt",
        "+treasuryUserId",
        "+treasurySystemType",
        "+treasuryLabel",

        "+fundsReserved",
        "+fundsCaptured",
        "+beneficiaryCredited",
        "+reserveReleased",

        "+reference",
        "+confirmedAt",
        "+executedAt",

        "+autoCancelAt",
        "+autoCancelledAt",
        "+autoCancelReason",
        "+autoCancelLockAt",
        "+autoCancelWorkerId",
        "+lastAutoCancelError",

        "+metadata",
        "+meta",
      ])
      .session(sessOpts.session || null);

    if (!tx) {
      throw createError(404, "Transaction introuvable");
    }

    const now = new Date();

    if (isAlreadyAutoCancelledOrFinal(tx)) {
      throw createError(
        410,
        "Cette transaction a déjà été annulée automatiquement ou n’est plus confirmable."
      );
    }

    if (isExpiredBeforeConfirmation(tx, now)) {
      throw createError(
        410,
        "Cette transaction a expiré. Elle sera annulée automatiquement."
      );
    }

    if (tx.lockedUntil && tx.lockedUntil > now) {
      throw createError(
        423,
        `Transaction bloquée, réessayez après ${tx.lockedUntil.toLocaleTimeString(
          "fr-FR"
        )}`
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
        throw createError(
          403,
          "Vous n’êtes pas le destinataire de cette transaction"
        );
      }
    } else if (isOutboundExternalPayout(tx)) {
      if (
        !["pending", "pending_review", "relaunch"].includes(
          String(tx.status || "")
        )
      ) {
        throw createError(409, "Transaction non confirmable dans son état actuel");
      }

      if (String(tx.sender) !== String(req.user.id)) {
        throw createError(
          403,
          "Vous n’êtes pas autorisé à confirmer cette transaction"
        );
      }
    } else {
      throw createError(400, `Flow non supporté pour confirm: ${tx.flow}`);
    }

    const storedHash =
      String(tx.securityAnswerHash || "") || String(tx.securityCode || "");

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

        await notifyTransactionEvent(
          tx,
          "locked",
          session,
          tx.senderCurrencySymbol
        );

        throw createError(
          423,
          `Réponse incorrecte. Transaction bloquée ${LOCK_MINUTES} min.`
        );
      }

      await tx.save(sessOpts);

      throw createError(
        401,
        `Réponse incorrecte. Il vous reste ${
          MAX_CONFIRM_ATTEMPTS - tx.attemptCount
        } essai(s).`
      );
    }

    const corridorLock = assertCorridorLockIsValid(tx);

    await assertCurrentProfilesStillMatchCorridor({
      tx,
      lock: corridorLock,
      session: sessOpts.session || null,
    });

    tx.attemptCount = 0;
    tx.lastAttemptAt = null;
    tx.lockedUntil = null;

    const grossSource = round2(toFloat(tx.amount));
    const targetAmount = round2(toFloat(tx.localAmount));

    const sourceCurrency =
      normalizeCurrency(tx.senderCurrencySymbol) ||
      normalizeCurrency(tx.currencySource) ||
      normalizeCurrency(tx.money?.source?.currency);

    const targetCurrency =
      normalizeCurrency(tx.localCurrencySymbol) ||
      normalizeCurrency(tx.currencyTarget) ||
      normalizeCurrency(tx.money?.target?.currency);

    if (!Number.isFinite(grossSource) || grossSource <= 0) {
      throw createError(409, "Montant source invalide");
    }

    if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
      throw createError(409, "Montant destination invalide");
    }

    if (!sourceCurrency) {
      throw createError(409, "Devise source invalide");
    }

    if (!targetCurrency) {
      throw createError(409, "Devise destination invalide");
    }

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
        tx.providerStatus = "TREASURY_REVENUE_CREDITED";
      }

      tx.status = "confirmed";
      tx.confirmedAt = now;
      tx.executedAt = now;
      tx.providerStatus = "SUCCESS";

      await tx.save(sessOpts);
      await notifyTransactionEvent(tx, "confirmed", session, sourceCurrency);

      if (canUseSharedSession()) {
        await session.commitTransaction();
      }

      await endQuietly(session);

      let referralSync = null;

      try {
        referralSync = await syncReferralAfterConfirmedTx(tx);
      } catch (refErr) {
        referralSync = buildReferralSyncError(refErr);
      }

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
        treasuryRevenue: tx.treasuryRevenue || null,
        fundsCaptured: !!tx.fundsCaptured,
        beneficiaryCredited: !!tx.beneficiaryCredited,
        treasuryRevenueCredited: !!tx.treasuryRevenueCredited,
        treasuryUserId: tx.treasuryUserId || null,
        treasurySystemType: tx.treasurySystemType || null,
        treasuryLabel: tx.treasuryLabel || null,
        autoCancelAt: tx.autoCancelAt || null,
        corridorLock,
        referralSync,
      });
    }

    tx.status = "processing";
    tx.providerStatus = tx.providerReference
      ? "PROVIDER_SUBMITTED"
      : "CONFIRMED_BY_USER_PENDING_PROVIDER";

    await tx.save(sessOpts);
    await notifyTransactionEvent(tx, "processing", session, sourceCurrency);

    if (canUseSharedSession()) {
      await session.commitTransaction();
    }

    await endQuietly(session);

    return res.status(202).json({
      success: true,
      transactionId: tx._id.toString(),
      reference: tx.reference,
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      fundsCaptured: !!tx.fundsCaptured,
      beneficiaryCredited: !!tx.beneficiaryCredited,
      treasuryRevenueCredited: !!tx.treasuryRevenueCredited,
      autoCancelAt: tx.autoCancelAt || null,
      corridorLock,
      message: "Transaction confirmée côté utilisateur et en attente du provider.",
    });
  } catch (err) {
    await abortQuietly(session);
    await endQuietly(session);
    next(err);
  }
}

module.exports = { confirmController };