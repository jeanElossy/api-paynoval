// File: src/services/transactionAutoCancelService.js
"use strict";

const os = require("os");
const crypto = require("crypto");

let logger = console;
try {
  logger = require("../utils/logger");
} catch {}

const runtime = require("./transactions/shared/runtime");
const TxWalletBalanceFactory = require("../models/TxWalletBalance");

const {
  AUTO_CANCELLABLE_STATUSES,
  normalizeStatus,
  isFinalTransactionStatus,
  isAutoCancellableStatus,
  getAutoCancelAfterDays,
  getAutoCancelReason,
} = require("./transactions/shared/autoCancelPolicy");

const notificationService = (() => {
  try {
    return require("./transactions/transactionNotificationService");
  } catch (err) {
    logger.warn?.("[TX AUTO CANCEL] transactionNotificationService introuvable", {
      message: err?.message || err,
    });

    return {};
  }
})();

const notifyTransactionEvent =
  typeof notificationService.notifyTransactionEvent === "function"
    ? notificationService.notifyTransactionEvent
    : async () => null;

const AUTO_CANCEL_BATCH_SIZE = Math.max(
  1,
  Number(process.env.TX_AUTO_CANCEL_BATCH_SIZE || 50)
);

const AUTO_CANCEL_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.TX_AUTO_CANCEL_INTERVAL_MS || 5 * 60 * 1000)
);

const LOCK_TTL_MS = Math.max(
  60_000,
  Number(process.env.TX_AUTO_CANCEL_LOCK_TTL_MS || 10 * 60 * 1000)
);

const AUTO_CANCELLABLE_MONGO_STATUSES = Array.from(
  new Set([
    ...(AUTO_CANCELLABLE_STATUSES
      ? Array.from(AUTO_CANCELLABLE_STATUSES)
      : []),

    "pending",
    "pendingreview",
    "pending_review",
    "pendingValidation",
    "pending_validation",
    "processing",
    "initiated",
    "awaiting_validation",
    "awaiting_confirmation",
  ])
);

function buildWorkerId() {
  return `${os.hostname()}:${process.pid}:${crypto
    .randomBytes(4)
    .toString("hex")}`;
}

function getTransactionModel() {
  if (!runtime.Transaction) {
    throw new Error("Transaction model indisponible dans runtime");
  }

  return runtime.Transaction;
}

function getWalletBalanceModel() {
  if (runtime.TxWalletBalance) return runtime.TxWalletBalance;
  if (runtime.WalletBalance) return runtime.WalletBalance;

  return TxWalletBalanceFactory();
}

function getSessionOptions(session) {
  if (!session) return {};
  return { session };
}

function getTxId(tx) {
  return String(tx?._id || tx?.id || tx?.transactionId || "");
}

function toNumber(value, fallback = 0) {
  if (value == null) return fallback;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  if (typeof value === "object") {
    if (typeof value.$numberDecimal === "string") {
      const n = Number(value.$numberDecimal);
      return Number.isFinite(n) ? n : fallback;
    }

    if (typeof value.$numberInt === "string") {
      const n = Number(value.$numberInt);
      return Number.isFinite(n) ? n : fallback;
    }

    if (typeof value.$numberLong === "string") {
      const n = Number(value.$numberLong);
      return Number.isFinite(n) ? n : fallback;
    }

    if (typeof value.toString === "function") {
      const n = Number(value.toString());
      return Number.isFinite(n) ? n : fallback;
    }
  }

  return fallback;
}

function normalizeCurrency(value) {
  const cur = String(value || "").trim().toUpperCase();

  if (!cur) return "";
  if (cur === "FCFA") return "XOF";
  if (cur === "CFA") return "XOF";
  if (cur === "$CAD") return "CAD";
  if (cur === "$USD") return "USD";

  return cur;
}

function resolveReservedCurrency(tx = {}) {
  return normalizeCurrency(
    tx.currencySource ||
      tx.senderCurrencySymbol ||
      tx.money?.source?.currency ||
      tx.currency ||
      ""
  );
}

function resolveReservedAmount(tx = {}) {
  return toNumber(
    tx.money?.source?.amount ??
      tx.amountSource ??
      tx.amount ??
      tx.grossAmount ??
      0
  );
}

function resolveSenderId(tx = {}) {
  return String(tx.sender || tx.userId || tx.ownerUserId || "").trim();
}

function isLocalAutoCancellableStatus(status) {
  const normalized = normalizeStatus(status);

  if (isAutoCancellableStatus(normalized)) return true;

  return normalized === "pending_review" || normalized === "pendingreview";
}

function isTxEligibleForAutoCancel(tx = {}) {
  const status = normalizeStatus(tx.status);

  if (!isLocalAutoCancellableStatus(status)) return false;
  if (isFinalTransactionStatus(status)) return false;

  if (tx.autoCancelledAt) return false;
  if (tx.fundsCaptured === true) return false;
  if (tx.beneficiaryCredited === true) return false;

  return ![
    "confirmed",
    "completed",
    "cancelled",
    "canceled",
    "failed",
    "refunded",
    "reversed",
  ].includes(status);
}

function buildExpiredQuery() {
  const now = new Date();

  const fallbackCreatedBefore = new Date(
    Date.now() - getAutoCancelAfterDays() * 24 * 60 * 60 * 1000
  );

  return {
    status: { $in: AUTO_CANCELLABLE_MONGO_STATUSES },
    beneficiaryCredited: { $ne: true },
    fundsCaptured: { $ne: true },
    autoCancelledAt: null,

    $or: [
      { autoCancelAt: { $lte: now } },
      {
        autoCancelAt: null,
        createdAt: { $lte: fallbackCreatedBefore },
      },
      {
        autoCancelAt: { $exists: false },
        createdAt: { $lte: fallbackCreatedBefore },
      },
    ],
  };
}

function buildLockQuery() {
  const staleLockDate = new Date(Date.now() - LOCK_TTL_MS);

  return {
    $or: [
      { autoCancelLockAt: null },
      { autoCancelLockAt: { $exists: false } },
      { autoCancelLockAt: { $lte: staleLockDate } },
    ],
  };
}

async function findExpiredTransactions({
  limit = AUTO_CANCEL_BATCH_SIZE,
} = {}) {
  const Transaction = getTransactionModel();

  return Transaction.find(buildExpiredQuery())
    .sort({ autoCancelAt: 1, createdAt: 1 })
    .limit(Math.max(1, Number(limit || AUTO_CANCEL_BATCH_SIZE)))
    .lean();
}

async function lockTransaction(tx, workerId) {
  const Transaction = getTransactionModel();
  const txId = getTxId(tx);

  if (!txId) return null;

  return Transaction.findOneAndUpdate(
    {
      _id: txId,
      $and: [buildExpiredQuery(), buildLockQuery()],
    },
    {
      $set: {
        autoCancelLockAt: new Date(),
        autoCancelWorkerId: workerId,
        lastAutoCancelError: "",
      },
    },
    {
      new: true,
    }
  );
}

async function clearAutoCancelLock(tx, workerId, extraSet = {}) {
  const Transaction = getTransactionModel();
  const txId = getTxId(tx);

  if (!txId) return;

  await Transaction.updateOne(
    {
      _id: txId,
      autoCancelWorkerId: workerId,
    },
    {
      $set: {
        autoCancelLockAt: null,
        autoCancelWorkerId: "",
        ...extraSet,
      },
    }
  );
}

function isReserveInsufficientError(err) {
  const message = String(err?.message || err || "").toLowerCase();

  return (
    message.includes("réserve insuffisante") ||
    message.includes("reserve insuffisante") ||
    message.includes("insufficient reserve")
  );
}

async function releaseReservedFundsIfNeeded(tx, session) {
  const TxWalletBalance = getWalletBalanceModel();

  if (tx.fundsReserved !== true) {
    return {
      released: false,
      reason: "NO_RESERVED_FUNDS",
    };
  }

  if (tx.reserveReleased === true) {
    return {
      released: false,
      reason: "RESERVE_ALREADY_RELEASED",
    };
  }

  const senderId = resolveSenderId(tx);
  const currency = resolveReservedCurrency(tx);
  const expectedAmount = resolveReservedAmount(tx);

  if (!senderId || !currency || !(expectedAmount > 0)) {
    return {
      released: false,
      reason: "INVALID_RESERVE_INPUT",
      senderId,
      currency,
      expectedAmount,
    };
  }

  const wallet =
    typeof TxWalletBalance.findWallet === "function"
      ? await TxWalletBalance.findWallet(
          senderId,
          currency,
          getSessionOptions(session)
        )
      : await TxWalletBalance.findOne(
          {
            user: senderId,
            currency,
          },
          null,
          getSessionOptions(session)
        );

  const actualReserved = toNumber(wallet?.reservedAmount || 0);

  if (!wallet || actualReserved <= 0) {
    return {
      released: false,
      reason: "RESERVE_NOT_AVAILABLE_OR_ALREADY_RELEASED",
      senderId,
      currency,
      expectedAmount,
      actualReserved: 0,
    };
  }

  const amountToRelease = Math.min(expectedAmount, actualReserved);

  if (!(amountToRelease > 0)) {
    return {
      released: false,
      reason: "NO_POSITIVE_RESERVE_TO_RELEASE",
      senderId,
      currency,
      expectedAmount,
      actualReserved,
    };
  }

  const releaseFn =
    typeof TxWalletBalance.releaseReserveForAutoCancel === "function"
      ? TxWalletBalance.releaseReserveForAutoCancel.bind(TxWalletBalance)
      : TxWalletBalance.releaseReserve.bind(TxWalletBalance);

  try {
    await releaseFn(
      senderId,
      currency,
      amountToRelease,
      getSessionOptions(session)
    );

    return {
      released: true,
      reason:
        amountToRelease < expectedAmount
          ? "PARTIAL_RESERVE_RELEASED"
          : "RESERVE_RELEASED",
      senderId,
      currency,
      expectedAmount,
      actualReserved,
      amount: amountToRelease,
    };
  } catch (err) {
    if (isReserveInsufficientError(err)) {
      return {
        released: false,
        reason: "RESERVE_RELEASE_FAILED_INCONSISTENT_WALLET",
        senderId,
        currency,
        expectedAmount,
        actualReserved,
        amountAttempted: amountToRelease,
        error: err?.message || String(err),
      };
    }

    throw err;
  }
}

async function markFailure(tx, err) {
  const Transaction = getTransactionModel();
  const txId = getTxId(tx);

  if (!txId) return;

  await Transaction.updateOne(
    { _id: txId },
    {
      $set: {
        autoCancelLockAt: null,
        autoCancelWorkerId: "",
        lastAutoCancelError: String(
          err?.message || err || "AUTO_CANCEL_FAILED"
        ).slice(0, 2000),
      },
    }
  );
}

async function cancelLockedTransaction(lockedTx, workerId) {
  const Transaction = getTransactionModel();
  const reason = getAutoCancelReason();

  let session = null;
  let useSession = false;

  try {
    session = await runtime.startTxSession();
    useSession = !!session && runtime.canUseSharedSession();

    if (useSession) {
      session.startTransaction();
    }

    const tx = await Transaction.findOne({
      _id: lockedTx._id,
      autoCancelWorkerId: workerId,
    }).session(useSession ? session : null);

    if (!tx || !isTxEligibleForAutoCancel(tx)) {
      if (useSession) {
        await session.abortTransaction();
      }

      await clearAutoCancelLock(lockedTx, workerId);

      return {
        ok: false,
        skipped: true,
        reason: "NOT_ELIGIBLE_ANYMORE",
      };
    }

    const releaseResult = await releaseReservedFundsIfNeeded(
      tx,
      useSession ? session : null
    );

    const now = new Date();

    tx.status = "cancelled";
    tx.providerStatus = "AUTO_CANCELLED_EXPIRED";

    tx.cancelledAt = tx.cancelledAt || now;
    tx.cancelReason = tx.cancelReason || reason;

    tx.autoCancelledAt = now;
    tx.autoCancelReason = reason;
    tx.autoCancelLockAt = null;
    tx.autoCancelWorkerId = "";
    tx.lastAutoCancelError = "";

    tx.reserveReleased = tx.reserveReleased || releaseResult.released;
    tx.reserveReleasedAt =
      tx.reserveReleasedAt || (releaseResult.released ? now : null);

    tx.reversedAt = tx.reversedAt || now;

    tx.meta = {
      ...(tx.meta && typeof tx.meta === "object" ? tx.meta : {}),
      autoCancelled: true,
      autoCancelReason: reason,
      autoCancelWorkerId: workerId,
      autoCancelledAt: now,
      reserveRelease: releaseResult,
    };

    tx.metadata = {
      ...(tx.metadata && typeof tx.metadata === "object" ? tx.metadata : {}),
      autoCancelled: true,
      autoCancelReason: reason,
      autoCancelWorkerId: workerId,
      autoCancelledAt: now,
      reserveRelease: releaseResult,
    };

    await tx.save(getSessionOptions(useSession ? session : null));

    if (typeof runtime.logTransaction === "function") {
      runtime
        .logTransaction({
          userId: String(tx.sender || tx.userId || ""),
          type: "auto_cancel",
          provider: tx.provider || tx.destination || "paynoval",
          amount: resolveReservedAmount(tx),
          currency: resolveReservedCurrency(tx),
          toEmail: tx.recipientEmail || tx.receiverEmail || "",
          details: {
            transactionId: String(tx._id),
            reference: tx.reference,
            reason,
            autoCancelledAt: now,
            reserveRelease: releaseResult,
          },
          flagged: false,
          flagReason: "",
          transactionId: tx._id,
        })
        .catch(() => {});
    }

    try {
      await notifyTransactionEvent(
        tx,
        "cancelled",
        useSession ? session : null,
        resolveReservedCurrency(tx)
      );
    } catch (notifyErr) {
      logger.warn?.("[TX AUTO CANCEL] notification auto-cancel ignorée", {
        transactionId: String(tx._id),
        err: notifyErr?.message || notifyErr,
      });
    }

    if (useSession) {
      await session.commitTransaction();
    }

    logger.info?.("[TX AUTO CANCEL] transaction annulée automatiquement", {
      transactionId: String(tx._id),
      reference: tx.reference,
      workerId,
      reserveRelease: releaseResult,
    });

    return {
      ok: true,
      transactionId: String(tx._id),
      reserveRelease: releaseResult,
    };
  } catch (err) {
    try {
      if (useSession && session) {
        await session.abortTransaction();
      }
    } catch {}

    await markFailure(lockedTx, err);

    logger.error?.("[TX AUTO CANCEL] échec annulation automatique", {
      transactionId: getTxId(lockedTx),
      workerId,
      err: err?.message || err,
      stack: err?.stack || "",
    });

    return {
      ok: false,
      transactionId: getTxId(lockedTx),
      reason: err?.message || "AUTO_CANCEL_FAILED",
    };
  } finally {
    try {
      session?.endSession?.();
    } catch {}
  }
}

async function processExpiredTransactions({
  limit = AUTO_CANCEL_BATCH_SIZE,
  workerId,
} = {}) {
  const wid = workerId || buildWorkerId();

  const expired = await findExpiredTransactions({
    limit,
  });

  let cancelled = 0;
  let skipped = 0;
  let failed = 0;

  for (const tx of expired) {
    const lockedTx = await lockTransaction(tx, wid);

    if (!lockedTx) {
      skipped += 1;
      continue;
    }

    const result = await cancelLockedTransaction(lockedTx, wid);

    if (result.ok) {
      cancelled += 1;
    } else if (result.skipped) {
      skipped += 1;
    } else {
      failed += 1;
    }
  }

  return {
    workerId: wid,
    scanned: expired.length,
    cancelled,
    skipped,
    failed,
  };
}

function startTransactionAutoCancelWorker({
  intervalMs = AUTO_CANCEL_INTERVAL_MS,
  batchSize = AUTO_CANCEL_BATCH_SIZE,
  workerId,
} = {}) {
  const enabled =
    String(process.env.TX_AUTO_CANCEL_ENABLED || "true").toLowerCase() !==
    "false";

  if (!enabled) {
    logger.warn?.("[TX AUTO CANCEL] worker désactivé par env");

    return {
      workerId: workerId || "",
      stop() {},
    };
  }

  const wid = workerId || buildWorkerId();

  logger.info?.("[TX AUTO CANCEL] worker démarré", {
    workerId: wid,
    intervalMs,
    batchSize,
    autoCancelAfterDays: getAutoCancelAfterDays(),
  });

  const run = async () => {
    try {
      const result = await processExpiredTransactions({
        limit: batchSize,
        workerId: wid,
      });

      if (result.cancelled || result.failed) {
        logger.info?.("[TX AUTO CANCEL] résultat", result);
      }
    } catch (err) {
      logger.error?.("[TX AUTO CANCEL] tick échoué", {
        workerId: wid,
        err: err?.message || err,
        stack: err?.stack || "",
      });
    }
  };

  run();

  const timer = setInterval(run, Math.max(30_000, Number(intervalMs)));

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    workerId: wid,

    stop() {
      clearInterval(timer);

      logger.info?.("[TX AUTO CANCEL] worker arrêté", {
        workerId: wid,
      });
    },
  };
}

module.exports = {
  processExpiredTransactions,
  startTransactionAutoCancelWorker,
};