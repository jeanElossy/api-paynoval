"use strict";

/**
 * --------------------------------------------------------------------------
 * Ledger Service
 * --------------------------------------------------------------------------
 * Rôle :
 * - encapsuler les mouvements financiers wallet + ledger
 * - centraliser les écritures comptables applicatives
 * - rester strict sur les validations d'entrée
 *
 * Notes importantes :
 * - Le wallet est la source de vérité opérationnelle pour les soldes.
 * - Le ledger sert d’audit trail explicite.
 * - Ce service ne doit pas "deviner" les flows métier : il exécute des
 *   primitives financières appelées par les controllers/services métier.
 * --------------------------------------------------------------------------
 */

const mongoose = require("mongoose");
const {
  roundMoney,
  buildAdminRevenueBreakdown,
} = require("./pricingSnapshotNormalizer");

/* -------------------------------------------------------------------------- */
/* Connexions                                                                 */
/* -------------------------------------------------------------------------- */

const getTxConnSafe = () => {
  try {
    const { getTxConn } = require("../config/db");
    return getTxConn();
  } catch {
    return mongoose;
  }
};

const getUsersConnSafe = () => {
  try {
    const { getUsersConn } = require("../config/db");
    return getUsersConn();
  } catch {
    return mongoose;
  }
};

const txConn = getTxConnSafe();
const usersConn = getUsersConnSafe();

const LedgerEntry = require("../models/LedgerEntry")(txConn);
const Balance = require("../models/Balance")(usersConn);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function maybeSessionOpts(session) {
  return session ? { session } : {};
}

function normalizeCurrency(currency) {
  const cur = String(currency || "").trim().toUpperCase();
  if (!cur || cur.length < 3 || cur.length > 6) {
    throw new Error(`Devise invalide: ${currency}`);
  }
  return cur;
}

function normalizeObjectIdLike(v, fieldName) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${fieldName} requis`);
  return s;
}

function normalizePositiveAmount(amount, currency = "CAD", { allowZero = false } = {}) {
  const rounded = Number(roundMoney(Number(amount || 0), currency));
  if (!Number.isFinite(rounded)) {
    throw new Error(`Montant invalide: ${amount}`);
  }
  if (allowZero ? rounded < 0 : rounded <= 0) {
    throw new Error(`Montant invalide (${rounded}) pour ${currency}`);
  }
  return rounded;
}

function dec(n, currency = "CAD") {
  const value = normalizePositiveAmount(n, currency, { allowZero: true });
  return mongoose.Types.Decimal128.fromString(String(value));
}

function assertTransactionLike(transaction) {
  if (!transaction || !transaction._id) {
    throw new Error("transaction invalide");
  }
}

function userWalletAccountId(userId, currency) {
  return `user_wallet:${normalizeObjectIdLike(userId, "userId")}:${normalizeCurrency(currency)}`;
}

function adminRevenueAccountId(currency = "CAD") {
  return `admin_revenue:${normalizeCurrency(currency)}`;
}

/* -------------------------------------------------------------------------- */
/* Ledger generic                                                             */
/* -------------------------------------------------------------------------- */

async function createLedgerEntry({
  transactionId,
  reference,
  userId = null,
  accountType,
  accountId,
  direction,
  entryType,
  amount,
  currency,
  metadata = null,
  session = null,
}) {
  const normalizedCurrency = normalizeCurrency(currency);
  const normalizedAmount = normalizePositiveAmount(amount, normalizedCurrency, {
    allowZero: false,
  });

  const allowedDirections = new Set(["DEBIT", "CREDIT"]);
  const allowedAccountTypes = new Set(["USER_WALLET", "ADMIN_REVENUE"]);
  const allowedEntryTypes = new Set([
    "RESERVE",
    "RESERVE_CAPTURE",
    "RESERVE_RELEASE",
    "USER_CREDIT",
    "REVERSAL",
    "REFUND",
    "FEE_REVENUE",
    "FX_REVENUE",
    "ADJUSTMENT",
  ]);

  if (!allowedDirections.has(String(direction || "").toUpperCase())) {
    throw new Error(`direction ledger invalide: ${direction}`);
  }

  if (!allowedAccountTypes.has(String(accountType || "").toUpperCase())) {
    throw new Error(`accountType ledger invalide: ${accountType}`);
  }

  if (!allowedEntryTypes.has(String(entryType || "").toUpperCase())) {
    throw new Error(`entryType ledger invalide: ${entryType}`);
  }

  const [doc] = await LedgerEntry.create(
    [
      {
        transactionId,
        reference: reference || null,
        userId: userId || null,
        accountType: String(accountType).toUpperCase(),
        accountId: String(accountId || "").trim(),
        direction: String(direction).toUpperCase(),
        entryType: String(entryType).toUpperCase(),
        amount: dec(normalizedAmount, normalizedCurrency),
        currency: normalizedCurrency,
        status: "POSTED",
        metadata:
          metadata && typeof metadata === "object" && !Array.isArray(metadata)
            ? metadata
            : null,
      },
    ],
    maybeSessionOpts(session)
  );

  return doc;
}

/* -------------------------------------------------------------------------- */
/* Wallet reserve / capture / release                                         */
/* -------------------------------------------------------------------------- */

async function reserveSenderFunds({
  transaction,
  senderId,
  amount,
  currency,
  session = null,
}) {
  assertTransactionLike(transaction);

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await Balance.reserve(sender, cur, amt, maybeSessionOpts(session));

  await createLedgerEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    userId: sender,
    accountType: "USER_WALLET",
    accountId: userWalletAccountId(sender, cur),
    direction: "DEBIT",
    entryType: "RESERVE",
    amount: amt,
    currency: cur,
    metadata: {
      stage: "initiate",
      flow: transaction.flow || null,
    },
    session,
  });

  return wallet;
}

async function captureSenderReserve({
  transaction,
  senderId,
  amount,
  currency,
  session = null,
}) {
  assertTransactionLike(transaction);

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await Balance.captureReserve(sender, cur, amt, maybeSessionOpts(session));

  await createLedgerEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    userId: sender,
    accountType: "USER_WALLET",
    accountId: userWalletAccountId(sender, cur),
    direction: "DEBIT",
    entryType: "RESERVE_CAPTURE",
    amount: amt,
    currency: cur,
    metadata: {
      stage: "confirm",
      flow: transaction.flow || null,
    },
    session,
  });

  return wallet;
}

async function releaseSenderReserve({
  transaction,
  senderId,
  amount,
  currency,
  session = null,
}) {
  assertTransactionLike(transaction);

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await Balance.releaseReserve(sender, cur, amt, maybeSessionOpts(session));

  await createLedgerEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    userId: sender,
    accountType: "USER_WALLET",
    accountId: userWalletAccountId(sender, cur),
    direction: "CREDIT",
    entryType: "RESERVE_RELEASE",
    amount: amt,
    currency: cur,
    metadata: {
      stage: "cancel_or_failure",
      flow: transaction.flow || null,
    },
    session,
  });

  return wallet;
}

/* -------------------------------------------------------------------------- */
/* User credit / debit / refund                                               */
/* -------------------------------------------------------------------------- */

async function creditReceiverFunds({
  transaction,
  receiverId,
  amount,
  currency,
  session = null,
}) {
  assertTransactionLike(transaction);

  const receiver = normalizeObjectIdLike(receiverId, "receiverId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await Balance.credit(receiver, cur, amt, maybeSessionOpts(session));

  await createLedgerEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    userId: receiver,
    accountType: "USER_WALLET",
    accountId: userWalletAccountId(receiver, cur),
    direction: "CREDIT",
    entryType: "USER_CREDIT",
    amount: amt,
    currency: cur,
    metadata: {
      stage: "confirm",
      flow: transaction.flow || null,
    },
    session,
  });

  return wallet;
}

async function debitReceiverFunds({
  transaction,
  receiverId,
  amount,
  currency,
  session = null,
}) {
  assertTransactionLike(transaction);

  const receiver = normalizeObjectIdLike(receiverId, "receiverId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await Balance.debit(receiver, cur, amt, maybeSessionOpts(session));

  await createLedgerEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    userId: receiver,
    accountType: "USER_WALLET",
    accountId: userWalletAccountId(receiver, cur),
    direction: "DEBIT",
    entryType: "REVERSAL",
    amount: amt,
    currency: cur,
    metadata: {
      stage: "refund",
      flow: transaction.flow || null,
    },
    session,
  });

  return wallet;
}

async function refundSenderFunds({
  transaction,
  senderId,
  amount,
  currency,
  session = null,
}) {
  assertTransactionLike(transaction);

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await Balance.credit(sender, cur, amt, maybeSessionOpts(session));

  await createLedgerEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    userId: sender,
    accountType: "USER_WALLET",
    accountId: userWalletAccountId(sender, cur),
    direction: "CREDIT",
    entryType: "REFUND",
    amount: amt,
    currency: cur,
    metadata: {
      stage: "refund",
      flow: transaction.flow || null,
    },
    session,
  });

  return wallet;
}

/* -------------------------------------------------------------------------- */
/* Admin revenue                                                              */
/* -------------------------------------------------------------------------- */

async function creditAdminRevenue({
  transaction,
  pricingSnapshot,
  adminUserId,
  session = null,
}) {
  assertTransactionLike(transaction);

  const adminId = normalizeObjectIdLike(adminUserId, "adminUserId");
  const adminRevenue = buildAdminRevenueBreakdown(pricingSnapshot || {});
  const credits = [];

  const feeCAD = normalizePositiveAmount(adminRevenue.feeCAD || 0, "CAD", {
    allowZero: true,
  });

  const fxCAD = normalizePositiveAmount(adminRevenue.fxCAD || 0, "CAD", {
    allowZero: true,
  });

  if (feeCAD > 0) {
    await Balance.credit(adminId, "CAD", feeCAD, maybeSessionOpts(session));

    credits.push(
      await createLedgerEntry({
        transactionId: transaction._id,
        reference: transaction.reference,
        userId: adminId,
        accountType: "ADMIN_REVENUE",
        accountId: adminRevenueAccountId("CAD"),
        direction: "CREDIT",
        entryType: "FEE_REVENUE",
        amount: feeCAD,
        currency: "CAD",
        metadata: {
          sourceCurrency: adminRevenue.feeSourceCurrency || null,
          feeSource: Number(adminRevenue.feeSource || 0),
          flow: transaction.flow || null,
        },
        session,
      })
    );
  }

  if (fxCAD > 0) {
    await Balance.credit(adminId, "CAD", fxCAD, maybeSessionOpts(session));

    credits.push(
      await createLedgerEntry({
        transactionId: transaction._id,
        reference: transaction.reference,
        userId: adminId,
        accountType: "ADMIN_REVENUE",
        accountId: adminRevenueAccountId("CAD"),
        direction: "CREDIT",
        entryType: "FX_REVENUE",
        amount: fxCAD,
        currency: "CAD",
        metadata: {
          fxToAmount: Number(adminRevenue.fxToAmount || 0),
          fxToCurrency: adminRevenue.fxToCurrency || null,
          flow: transaction.flow || null,
        },
        session,
      })
    );
  }

  return {
    adminRevenue: {
      ...adminRevenue,
      feeCAD,
      fxCAD,
    },
    entries: credits,
  };
}

/* -------------------------------------------------------------------------- */
/* Cancellation fee                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Frais d'annulation :
 * - débit wallet user dans la devise source
 * - crédit admin en CAD
 * - écritures ledger sender + admin
 */
async function chargeCancellationFee({
  transaction,
  senderId,
  senderCurrency,
  feeSourceAmount,
  adminUserId,
  adminFeeCAD,
  conversionRateToCAD = 0,
  feeType = "fixed",
  feePercent = 0,
  feeId = null,
  session = null,
}) {
  assertTransactionLike(transaction);

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const adminId = normalizeObjectIdLike(adminUserId, "adminUserId");
  const sourceCurrency = normalizeCurrency(senderCurrency);

  const out = {
    senderDebited: false,
    adminCredited: false,
    feeSourceAmount: normalizePositiveAmount(feeSourceAmount || 0, sourceCurrency, {
      allowZero: true,
    }),
    feeSourceCurrency: sourceCurrency,
    adminFeeCAD: normalizePositiveAmount(adminFeeCAD || 0, "CAD", {
      allowZero: true,
    }),
    adminCurrency: "CAD",
    conversionRateToCAD: Number(conversionRateToCAD || 0),
    feeType: String(feeType || "fixed").trim().toLowerCase() === "percent" ? "percent" : "fixed",
    feePercent: Number(feePercent || 0),
    feeId: feeId || null,
  };

  if (out.feeSourceAmount > 0) {
    await Balance.debit(sender, out.feeSourceCurrency, out.feeSourceAmount, maybeSessionOpts(session));

    await createLedgerEntry({
      transactionId: transaction._id,
      reference: transaction.reference,
      userId: sender,
      accountType: "USER_WALLET",
      accountId: userWalletAccountId(sender, out.feeSourceCurrency),
      direction: "DEBIT",
      entryType: "ADJUSTMENT",
      amount: out.feeSourceAmount,
      currency: out.feeSourceCurrency,
      metadata: {
        stage: "cancel",
        reason: "cancellation_fee",
        feeType: out.feeType,
        feePercent: out.feePercent,
        feeId: out.feeId,
        flow: transaction.flow || null,
      },
      session,
    });

    out.senderDebited = true;
  }

  if (out.adminFeeCAD > 0) {
    await Balance.credit(adminId, "CAD", out.adminFeeCAD, maybeSessionOpts(session));

    await createLedgerEntry({
      transactionId: transaction._id,
      reference: transaction.reference,
      userId: adminId,
      accountType: "ADMIN_REVENUE",
      accountId: adminRevenueAccountId("CAD"),
      direction: "CREDIT",
      entryType: "FEE_REVENUE",
      amount: out.adminFeeCAD,
      currency: "CAD",
      metadata: {
        stage: "cancel",
        reason: "cancellation_fee",
        sourceCurrency: out.feeSourceCurrency,
        feeSourceAmount: out.feeSourceAmount,
        conversionRateToCAD: out.conversionRateToCAD,
        feeType: out.feeType,
        feePercent: out.feePercent,
        feeId: out.feeId,
        flow: transaction.flow || null,
      },
      session,
    });

    out.adminCredited = true;
  }

  return out;
}

module.exports = {
  reserveSenderFunds,
  captureSenderReserve,
  releaseSenderReserve,
  creditReceiverFunds,
  debitReceiverFunds,
  refundSenderFunds,
  creditAdminRevenue,
  chargeCancellationFee,
  createLedgerEntry,
};