"use strict";

/**
 * --------------------------------------------------------------------------
 * Ledger Service
 * --------------------------------------------------------------------------
 * - séparation explicite user wallet / system treasury wallet
 * - fee revenue => FEES_TREASURY
 * - fx revenue  => FX_MARGIN_TREASURY
 * - fallback prudent vers TxWalletBalance si TxSystemBalance n'existe pas encore
 * --------------------------------------------------------------------------
 */

const mongoose = require("mongoose");
const {
  roundMoney,
  buildTreasuryRevenueBreakdown,
} = require("./pricingSnapshotNormalizer");

const { getTxConn } = require("../config/db");
const txConn = getTxConn();

const LedgerEntry = require("../models/LedgerEntry")(txConn);
const UserWalletBalance = require("../models/TxWalletBalance")(txConn);

let SystemWalletBalance = null;
try {
  SystemWalletBalance = require("../models/TxSystemBalance")(txConn);
} catch {
  SystemWalletBalance = null;
}

const TREASURY_SYSTEM_TYPES = new Set([
  "REFERRAL_TREASURY",
  "FEES_TREASURY",
  "OPERATIONS_TREASURY",
  "CAGNOTTE_FEES_TREASURY",
  "FX_MARGIN_TREASURY",
]);

const TREASURY_ENV_BY_SYSTEM_TYPE = Object.freeze({
  REFERRAL_TREASURY: String(process.env.REFERRAL_TREASURY_USER_ID || "").trim(),
  FEES_TREASURY: String(process.env.FEES_TREASURY_USER_ID || "").trim(),
  OPERATIONS_TREASURY: String(process.env.OPERATIONS_TREASURY_USER_ID || "").trim(),
  CAGNOTTE_FEES_TREASURY: String(process.env.CAGNOTTE_FEES_TREASURY_USER_ID || "").trim(),
  FX_MARGIN_TREASURY: String(process.env.FX_MARGIN_TREASURY_USER_ID || "").trim(),
});

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

function normalizeTreasurySystemType(value, fieldName = "treasurySystemType") {
  const s = String(value || "").trim().toUpperCase();
  if (!s) throw new Error(`${fieldName} requis`);
  if (!TREASURY_SYSTEM_TYPES.has(s)) {
    throw new Error(`${fieldName} invalide: ${value}`);
  }
  return s;
}

function getTreasuryUserIdBySystemType(systemType) {
  const normalizedType = normalizeTreasurySystemType(systemType, "systemType");
  const treasuryUserId = String(
    TREASURY_ENV_BY_SYSTEM_TYPE[normalizedType] || ""
  ).trim();

  if (!treasuryUserId) {
    throw new Error(`Aucun treasuryUserId configuré pour ${normalizedType}`);
  }

  return treasuryUserId;
}

function resolveTreasuryFromSystemType(systemType) {
  return getTreasuryUserIdBySystemType(systemType);
}

function normalizeOptionalLabel(value, fallback = "") {
  return String(value || fallback || "").trim();
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

function treasuryAccountId({ treasuryUserId, treasurySystemType, currency }) {
  const userId = normalizeObjectIdLike(treasuryUserId, "treasuryUserId");
  const systemType = normalizeTreasurySystemType(treasurySystemType);
  const cur = normalizeCurrency(currency);
  return `treasury:${systemType}:${userId}:${cur}`;
}

function assertUserWalletModel() {
  if (!UserWalletBalance) {
    throw new Error("TxWalletBalance indisponible");
  }

  const requiredMethods = [
    "reserve",
    "captureReserve",
    "releaseReserve",
    "credit",
    "debit",
  ];

  for (const method of requiredMethods) {
    if (typeof UserWalletBalance[method] !== "function") {
      throw new Error(`TxWalletBalance.${method} indisponible`);
    }
  }
}

function resolveTreasuryContext({
  treasuryUserId = null,
  treasurySystemType,
  treasuryLabel = "",
}) {
  const systemType = normalizeTreasurySystemType(treasurySystemType);
  const resolvedTreasuryUserId = treasuryUserId
    ? normalizeObjectIdLike(treasuryUserId, "treasuryUserId")
    : resolveTreasuryFromSystemType(systemType);

  return {
    treasuryUserId: resolvedTreasuryUserId,
    treasurySystemType: systemType,
    treasuryLabel: normalizeOptionalLabel(treasuryLabel),
  };
}

function getSystemWalletModel() {
  if (!SystemWalletBalance) {
    return null;
  }
  return SystemWalletBalance;
}

function buildSystemBalanceQuery({ treasuryUserId, treasurySystemType }) {
  const id = normalizeObjectIdLike(treasuryUserId, "treasuryUserId");
  const systemType = normalizeTreasurySystemType(treasurySystemType);

  const clauses = [
    { userId: id, systemType },
    { ownerId: id, systemType },
  ];

  if (mongoose.Types.ObjectId.isValid(id)) {
    const oid = new mongoose.Types.ObjectId(id);
    clauses.push({ userId: oid, systemType }, { ownerId: oid, systemType });
  }

  return {
    $or: clauses,
  };
}

async function ensureSystemBalanceDocument({
  treasuryUserId,
  treasurySystemType,
  currency,
  treasuryLabel = "",
  session = null,
}) {
  const SystemBalance = getSystemWalletModel();
  if (!SystemBalance) return null;

  const cur = normalizeCurrency(currency);
  const query = buildSystemBalanceQuery({ treasuryUserId, treasurySystemType });

  let doc = await SystemBalance.findOne(query).session(session || null);
  if (doc) {
    if (doc.balances == null || typeof doc.balances !== "object") {
      doc.balances = {};
    }
    if (doc.balances[cur] == null) {
      doc.balances[cur] = 0;
    }
    return doc;
  }

  const seedBalances = { [cur]: 0 };
  const [created] = await SystemBalance.create(
    [
      {
        userId: treasuryUserId,
        systemType: normalizeTreasurySystemType(treasurySystemType),
        fullName: normalizeOptionalLabel(treasuryLabel) || treasurySystemType,
        isSystem: true,
        managedCurrency: "MULTI",
        defaultCurrency: cur,
        balances: seedBalances,
        isActive: true,
        metadata: {
          source: "ledgerService.ensureSystemBalanceDocument",
        },
      },
    ],
    maybeSessionOpts(session)
  );

  return created;
}

async function creditSystemWallet({
  treasuryUserId,
  treasurySystemType,
  amount,
  currency,
  treasuryLabel = "",
  session = null,
}) {
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const SystemBalance = getSystemWalletModel();

  if (SystemBalance && typeof SystemBalance.credit === "function") {
    return SystemBalance.credit(
      treasuryUserId,
      normalizeTreasurySystemType(treasurySystemType),
      cur,
      amt,
      maybeSessionOpts(session)
    );
  }

  if (SystemBalance) {
    const doc = await ensureSystemBalanceDocument({
      treasuryUserId,
      treasurySystemType,
      currency: cur,
      treasuryLabel,
      session,
    });

    const balancePath = `balances.${cur}`;
    return SystemBalance.findOneAndUpdate(
      { _id: doc._id },
      {
        $inc: { [balancePath]: amt },
        $set: {
          updatedAt: new Date(),
          defaultCurrency: doc.defaultCurrency || cur,
          managedCurrency: doc.managedCurrency || "MULTI",
          isSystem: true,
          isActive: doc.isActive !== false,
        },
        $push: {
          balanceHistory: {
            type: "credit",
            amount: amt,
            currency: cur,
            reason: `ledger:${normalizeTreasurySystemType(treasurySystemType)}`,
            createdAt: new Date(),
          },
        },
      },
      { new: true, session }
    );
  }

  await UserWalletBalance.credit(
    treasuryUserId,
    cur,
    amt,
    maybeSessionOpts(session)
  );

  return null;
}

async function debitSystemWallet({
  treasuryUserId,
  treasurySystemType,
  amount,
  currency,
  treasuryLabel = "",
  session = null,
}) {
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const SystemBalance = getSystemWalletModel();

  if (SystemBalance && typeof SystemBalance.debit === "function") {
    return SystemBalance.debit(
      treasuryUserId,
      normalizeTreasurySystemType(treasurySystemType),
      cur,
      amt,
      maybeSessionOpts(session)
    );
  }

  if (SystemBalance) {
    const doc = await ensureSystemBalanceDocument({
      treasuryUserId,
      treasurySystemType,
      currency: cur,
      treasuryLabel,
      session,
    });

    const current = Number(doc?.balances?.[cur] || 0);
    if (current < amt) {
      throw new Error(
        `Solde insuffisant sur ${treasurySystemType} en ${cur}. Disponible=${current}, requis=${amt}`
      );
    }

    const balancePath = `balances.${cur}`;
    return SystemBalance.findOneAndUpdate(
      { _id: doc._id, [balancePath]: { $gte: amt } },
      {
        $inc: { [balancePath]: -amt },
        $set: { updatedAt: new Date() },
        $push: {
          balanceHistory: {
            type: "debit",
            amount: amt,
            currency: cur,
            reason: `ledger:${normalizeTreasurySystemType(treasurySystemType)}`,
            createdAt: new Date(),
          },
        },
      },
      { new: true, session }
    );
  }

  await UserWalletBalance.debit(
    treasuryUserId,
    cur,
    amt,
    maybeSessionOpts(session)
  );

  return null;
}

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
  const allowedAccountTypes = new Set([
    "USER_WALLET",
    "TREASURY",
    "SYSTEM_CLEARING",
    "SYSTEM_RESERVE",
  ]);
  const allowedEntryTypes = new Set([
    "RESERVE",
    "RESERVE_CAPTURE",
    "RESERVE_RELEASE",
    "USER_DEBIT",
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

async function reserveSenderFunds({ transaction, senderId, amount, currency, session = null }) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await UserWalletBalance.reserve(
    sender,
    cur,
    amt,
    maybeSessionOpts(session)
  );

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
    metadata: { stage: "initiate", flow: transaction.flow || null },
    session,
  });

  return wallet;
}

async function captureSenderReserve({ transaction, senderId, amount, currency, session = null }) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await UserWalletBalance.captureReserve(
    sender,
    cur,
    amt,
    maybeSessionOpts(session)
  );

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
    metadata: { stage: "confirm", flow: transaction.flow || null },
    session,
  });

  return wallet;
}

async function releaseSenderReserve({ transaction, senderId, amount, currency, session = null }) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await UserWalletBalance.releaseReserve(
    sender,
    cur,
    amt,
    maybeSessionOpts(session)
  );

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
    metadata: { stage: "cancel_or_failure", flow: transaction.flow || null },
    session,
  });

  return wallet;
}

async function creditReceiverFunds({ transaction, receiverId, amount, currency, session = null }) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const receiver = normalizeObjectIdLike(receiverId, "receiverId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await UserWalletBalance.credit(
    receiver,
    cur,
    amt,
    maybeSessionOpts(session)
  );

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
    metadata: { stage: "confirm", flow: transaction.flow || null },
    session,
  });

  return wallet;
}

async function debitReceiverFunds({ transaction, receiverId, amount, currency, session = null }) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const receiver = normalizeObjectIdLike(receiverId, "receiverId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await UserWalletBalance.debit(
    receiver,
    cur,
    amt,
    maybeSessionOpts(session)
  );

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
    metadata: { stage: "refund", flow: transaction.flow || null },
    session,
  });

  return wallet;
}

async function refundSenderFunds({ transaction, senderId, amount, currency, session = null }) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const cur = normalizeCurrency(currency);
  const amt = normalizePositiveAmount(amount, cur);

  const wallet = await UserWalletBalance.credit(
    sender,
    cur,
    amt,
    maybeSessionOpts(session)
  );

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
    metadata: { stage: "refund", flow: transaction.flow || null },
    session,
  });

  return wallet;
}

async function creditRevenueLineToTreasury({
  transaction,
  revenueLine,
  explicitTreasuryUserId = null,
  explicitTreasuryLabel = "",
  entryType,
  session = null,
}) {
  const systemType = normalizeTreasurySystemType(revenueLine?.systemType);

  const treasury = resolveTreasuryContext({
    treasuryUserId: explicitTreasuryUserId,
    treasurySystemType: systemType,
    treasuryLabel: explicitTreasuryLabel,
  });

  const treasuryCurrency = normalizeCurrency(revenueLine?.treasuryCurrency || "CAD");
  const treasuryAmount = normalizePositiveAmount(
    revenueLine?.treasuryAmount || 0,
    treasuryCurrency,
    { allowZero: true }
  );

  if (treasuryAmount <= 0) {
    return null;
  }

  const walletAfter = await creditSystemWallet({
    treasuryUserId: treasury.treasuryUserId,
    treasurySystemType: treasury.treasurySystemType,
    amount: treasuryAmount,
    currency: treasuryCurrency,
    treasuryLabel: treasury.treasuryLabel,
    session,
  });

  const metadata = {
    treasuryUserId: treasury.treasuryUserId,
    treasurySystemType: treasury.treasurySystemType,
    treasuryLabel: treasury.treasuryLabel || null,
    sourceAmount: Number(revenueLine?.sourceAmount || 0),
    sourceCurrency: revenueLine?.sourceCurrency || null,
    treasuryAmount,
    treasuryCurrency,
    conversionRateToTreasury: Number(revenueLine?.conversionRateToTreasury || 0),
    flow: transaction.flow || null,
  };

  if (entryType === "FX_REVENUE") {
    metadata.idealNetTo = Number(revenueLine?.idealNetTo || 0);
    metadata.actualNetTo = Number(revenueLine?.actualNetTo || 0);
    metadata.rawAmount = Number(revenueLine?.rawAmount || 0);
  }

  const entry = await createLedgerEntry({
    transactionId: transaction._id,
    reference: transaction.reference,
    userId: treasury.treasuryUserId,
    accountType: "TREASURY",
    accountId: treasuryAccountId({
      treasuryUserId: treasury.treasuryUserId,
      treasurySystemType: treasury.treasurySystemType,
      currency: treasuryCurrency,
    }),
    direction: "CREDIT",
    entryType,
    amount: treasuryAmount,
    currency: treasuryCurrency,
    metadata,
    session,
  });

  return {
    entry,
    walletAfter,
    treasuryUserId: treasury.treasuryUserId,
    treasurySystemType: treasury.treasurySystemType,
    treasuryLabel: treasury.treasuryLabel,
    treasuryAmount,
    treasuryCurrency,
    sourceAmount: Number(revenueLine?.sourceAmount || 0),
    sourceCurrency: revenueLine?.sourceCurrency || null,
    conversionRateToTreasury: Number(revenueLine?.conversionRateToTreasury || 0),
  };
}

async function creditTreasuryRevenue({
  transaction,
  pricingSnapshot,
  treasuryUserId = null,
  treasurySystemType = null,
  treasuryLabel = "",
  session = null,
}) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const revenue = buildTreasuryRevenueBreakdown(pricingSnapshot || {});
  const entries = [];

  const feeLine = revenue?.feeRevenue || null;
  const fxLine = revenue?.fxRevenue || null;

  let feeCredit = null;
  let fxCredit = null;

  if (feeLine && Number(feeLine.treasuryAmount || 0) > 0) {
    feeCredit = await creditRevenueLineToTreasury({
      transaction,
      revenueLine: { ...feeLine, systemType: "FEES_TREASURY" },
      explicitTreasuryUserId: treasurySystemType === "FEES_TREASURY" ? treasuryUserId : null,
      explicitTreasuryLabel: treasurySystemType === "FEES_TREASURY" ? treasuryLabel : "",
      entryType: "FEE_REVENUE",
      session,
    });

    if (feeCredit?.entry) entries.push(feeCredit.entry);
  }

  if (fxLine && Number(fxLine.treasuryAmount || 0) > 0) {
    fxCredit = await creditRevenueLineToTreasury({
      transaction,
      revenueLine: { ...fxLine, systemType: "FX_MARGIN_TREASURY" },
      explicitTreasuryUserId: treasurySystemType === "FX_MARGIN_TREASURY" ? treasuryUserId : null,
      explicitTreasuryLabel: treasurySystemType === "FX_MARGIN_TREASURY" ? treasuryLabel : "",
      entryType: "FX_REVENUE",
      session,
    });

    if (fxCredit?.entry) entries.push(fxCredit.entry);
  }

  return {
    feeRevenue: feeCredit,
    fxRevenue: fxCredit,
    pricingSnapshot: revenue?.pricingSnapshot || pricingSnapshot || {},
    entries,
  };
}

async function chargeCancellationFee({
  transaction,
  senderId,
  senderCurrency,
  feeSourceAmount,
  treasuryUserId = null,
  treasurySystemType = "FEES_TREASURY",
  treasuryLabel = "",
  treasuryFeeAmount,
  treasuryFeeCurrency,
  conversionRateToTreasury = 0,
  feeType = "fixed",
  feePercent = 0,
  feeId = null,
  session = null,
}) {
  assertTransactionLike(transaction);
  assertUserWalletModel();

  const sender = normalizeObjectIdLike(senderId, "senderId");
  const treasury = resolveTreasuryContext({
    treasuryUserId,
    treasurySystemType,
    treasuryLabel,
  });

  const sourceCurrency = normalizeCurrency(senderCurrency);
  const targetCurrency = normalizeCurrency(treasuryFeeCurrency);

  const out = {
    senderDebited: false,
    treasuryCredited: false,
    feeSourceAmount: normalizePositiveAmount(feeSourceAmount || 0, sourceCurrency, {
      allowZero: true,
    }),
    feeSourceCurrency: sourceCurrency,
    treasuryFeeAmount: normalizePositiveAmount(treasuryFeeAmount || 0, targetCurrency, {
      allowZero: true,
    }),
    treasuryFeeCurrency: targetCurrency,
    treasuryUserId: treasury.treasuryUserId,
    treasurySystemType: treasury.treasurySystemType,
    treasuryLabel: treasury.treasuryLabel,
    conversionRateToTreasury: Number(conversionRateToTreasury || 0),
    feeType: String(feeType || "fixed").trim().toLowerCase() === "percent" ? "percent" : "fixed",
    feePercent: Number(feePercent || 0),
    feeId: feeId || null,
  };

  if (out.feeSourceAmount > 0) {
    await UserWalletBalance.debit(
      sender,
      out.feeSourceCurrency,
      out.feeSourceAmount,
      maybeSessionOpts(session)
    );

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
        treasuryUserId: treasury.treasuryUserId,
        treasurySystemType: treasury.treasurySystemType,
        treasuryLabel: treasury.treasuryLabel || null,
      },
      session,
    });

    out.senderDebited = true;
  }

  if (out.treasuryFeeAmount > 0) {
    await creditSystemWallet({
      treasuryUserId: treasury.treasuryUserId,
      treasurySystemType: treasury.treasurySystemType,
      amount: out.treasuryFeeAmount,
      currency: out.treasuryFeeCurrency,
      treasuryLabel: treasury.treasuryLabel,
      session,
    });

    await createLedgerEntry({
      transactionId: transaction._id,
      reference: transaction.reference,
      userId: treasury.treasuryUserId,
      accountType: "TREASURY",
      accountId: treasuryAccountId({
        treasuryUserId: treasury.treasuryUserId,
        treasurySystemType: treasury.treasurySystemType,
        currency: out.treasuryFeeCurrency,
      }),
      direction: "CREDIT",
      entryType: "FEE_REVENUE",
      amount: out.treasuryFeeAmount,
      currency: out.treasuryFeeCurrency,
      metadata: {
        stage: "cancel",
        reason: "cancellation_fee",
        feeType: out.feeType,
        feePercent: out.feePercent,
        feeId: out.feeId,
        sourceAmount: out.feeSourceAmount,
        sourceCurrency: out.feeSourceCurrency,
        treasuryUserId: treasury.treasuryUserId,
        treasurySystemType: treasury.treasurySystemType,
        treasuryLabel: treasury.treasuryLabel || null,
        conversionRateToTreasury: out.conversionRateToTreasury,
        flow: transaction.flow || null,
      },
      session,
    });

    out.treasuryCredited = true;
  }

  return out;
}

module.exports = {
  TREASURY_SYSTEM_TYPES,
  TREASURY_ENV_BY_SYSTEM_TYPE,
  normalizeTreasurySystemType,
  getTreasuryUserIdBySystemType,
  resolveTreasuryFromSystemType,
  getSystemWalletModel,
  creditSystemWallet,
  debitSystemWallet,
  reserveSenderFunds,
  captureSenderReserve,
  releaseSenderReserve,
  creditReceiverFunds,
  debitReceiverFunds,
  refundSenderFunds,
  creditTreasuryRevenue,
  chargeCancellationFee,
  createLedgerEntry,
};