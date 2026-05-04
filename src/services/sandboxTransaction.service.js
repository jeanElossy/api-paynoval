// File: src/services/sandboxTransaction.service.js
"use strict";

const mongoose = require("mongoose");

const runtime = require("./transactions/shared/runtime");
const db = require("../config/db");

const {
  resolveExternalFlow,
  isOutboundExternalFlow,
  isInboundExternalFlow,
} = require("./transactions/handlers/flowHelpers");

const {
  isSandboxUser,
  isAppleReviewUserId,
  resolveUserId,
} = require("../utils/sandboxUser");

const VALID_FLOWS = new Set([
  "PAYNOVAL_INTERNAL_TRANSFER",
  "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
  "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  "BANK_TRANSFER_TO_PAYNOVAL",
  "PAYNOVAL_TO_BANK_PAYOUT",
  "CARD_TOPUP_TO_PAYNOVAL",
  "PAYNOVAL_TO_CARD_PAYOUT",
  "UNKNOWN_FLOW",
]);

const VALID_RAILS = new Set([
  "paynoval",
  "stripe",
  "bank",
  "mobilemoney",
  "visa_direct",
  "stripe2momo",
  "cashin",
  "cashout",
]);

function normalizeCurrency(value) {
  const s = String(value || "CAD").trim().toUpperCase();

  if (s === "FCFA" || s === "CFA") return "XOF";
  if (s === "$CAD") return "CAD";
  if (s === "$USD") return "USD";

  return s || "CAD";
}

function normalizeRail(value, fallback = "paynoval") {
  const raw = String(value || "").trim().toLowerCase();

  if (!raw) return fallback;

  const mapped = raw
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");

  if (mapped === "card") return fallback === "visa_direct" ? "visa_direct" : "stripe";
  if (mapped === "visa" || mapped === "visadirect") return "visa_direct";
  if (mapped === "momo" || mapped === "mobile_money") return "mobilemoney";
  if (mapped === "bank_transfer" || mapped === "banque") return "bank";
  if (mapped === "sandbox") return fallback;

  return VALID_RAILS.has(mapped) ? mapped : fallback;
}

function currencyDecimals(currency = "CAD") {
  return ["XOF", "XAF", "JPY"].includes(normalizeCurrency(currency)) ? 0 : 2;
}

function roundCurrency(amount, currency = "CAD") {
  const n = Number(amount || 0);
  const safe = Number.isFinite(n) ? n : 0;
  return Number(safe.toFixed(currencyDecimals(currency)));
}

function toDecimal128(amount, currency = "CAD") {
  const rounded = roundCurrency(amount, currency);

  return mongoose.Types.Decimal128.fromString(
    rounded.toFixed(currencyDecimals(currency))
  );
}

function decimalToNumber(value) {
  if (value == null) return 0;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "object" && typeof value.$numberDecimal === "string") {
    const n = Number(value.$numberDecimal);
    return Number.isFinite(n) ? n : 0;
  }

  if (typeof value.toString === "function") {
    const n = Number(value.toString());
    return Number.isFinite(n) ? n : 0;
  }

  return 0;
}

function normalizeAmount(value) {
  const n = Number(value || 0);

  if (!Number.isFinite(n) || n <= 0) {
    const error = new Error("Montant sandbox invalide.");
    error.status = 400;
    error.statusCode = 400;
    throw error;
  }

  return n;
}

function optionalAmount(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function getTxModelSafe(modelName) {
  try {
    if (typeof runtime?.getTxModel === "function") {
      const model = runtime.getTxModel(modelName);
      if (model?.modelName === modelName) return model;
    }
  } catch (_) {}

  try {
    const direct = runtime?.[modelName];
    if (direct?.modelName === modelName) return direct;
  } catch (_) {}

  try {
    const model = db.getTxModel(modelName);
    if (model?.modelName === modelName) return model;
  } catch (_) {}

  const error = new Error(
    `${modelName} model indisponible sur la connexion transactions.`
  );
  error.status = 500;
  error.statusCode = 500;
  throw error;
}

function getTransactionModel() {
  return getTxModelSafe("Transaction");
}

function getTxWalletBalanceModel() {
  return getTxModelSafe("TxWalletBalance");
}

function modelHasPath(Model, path) {
  try {
    return Boolean(Model?.schema?.path(path));
  } catch (_) {
    return false;
  }
}

function buildWalletUserOrQuery(Model, userId) {
  const or = [];

  if (modelHasPath(Model, "user")) {
    or.push({ user: userId });
  }

  if (modelHasPath(Model, "userId")) {
    or.push({ userId });
  }

  if (modelHasPath(Model, "ownerUserId")) {
    or.push({ ownerUserId: userId });
  }

  if (!or.length) {
    or.push({ user: userId });
  }

  return or;
}

function buildWalletUserPayload(Model, userId) {
  const payload = {};

  if (modelHasPath(Model, "user")) {
    payload.user = userId;
  } else if (modelHasPath(Model, "userId")) {
    payload.userId = userId;
  } else if (modelHasPath(Model, "ownerUserId")) {
    payload.ownerUserId = userId;
  } else {
    payload.user = userId;
  }

  return payload;
}

function normalizeFlowValue(flow) {
  const value = String(flow || "").trim().toUpperCase();

  if (VALID_FLOWS.has(value)) return value;

  if (value === "INTERNAL_TX" || value === "PAYNOVAL_TO_PAYNOVAL") {
    return "PAYNOVAL_INTERNAL_TRANSFER";
  }

  return "UNKNOWN_FLOW";
}

function isInternalSandboxFlow(body = {}) {
  const funds = norm(body.funds);
  const destination = norm(body.destination);
  const provider = norm(body.provider);
  const method = norm(body.method);

  return (
    funds === "paynoval" &&
    destination === "paynoval" &&
    (!provider || provider === "paynoval") &&
    (!method || method === "paynoval" || method === "internal")
  );
}

function resolveSandboxFlowType(body = {}) {
  if (isInternalSandboxFlow(body)) {
    return {
      type: "internal",
      flow: "PAYNOVAL_INTERNAL_TRANSFER",
      walletAction: "debit",
    };
  }

  const externalFlow = resolveExternalFlow(body);

  if (externalFlow && isOutboundExternalFlow(externalFlow)) {
    return {
      type: "external_out",
      flow: normalizeFlowValue(externalFlow),
      walletAction: "debit",
    };
  }

  if (externalFlow && isInboundExternalFlow(externalFlow)) {
    return {
      type: "external_in",
      flow: normalizeFlowValue(externalFlow),
      walletAction: "credit",
    };
  }

  return {
    type: "generic",
    flow: normalizeFlowValue(body.flow || body.meta?.flow || "UNKNOWN_FLOW"),
    walletAction: "debit",
  };
}

function buildSandboxReference() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `SBX-${Date.now()}-${rand}`;
}

function pickAmount(body = {}) {
  return (
    body.amountSource ||
    body.amount ||
    body.netAmount ||
    body.amountTarget ||
    body.localAmount ||
    body.money?.source?.amount ||
    body.money?.target?.amount ||
    0
  );
}

function pickCurrency(body = {}, user = {}) {
  return normalizeCurrency(
    body.currencySource ||
      body.currency ||
      body.senderCurrencyCode ||
      body.localCurrencyCode ||
      user.currency ||
      process.env.APPLE_REVIEW_CURRENCY ||
      "CAD"
  );
}

function pickFees(body = {}) {
  return optionalAmount(
    body.transactionFees ??
      body.feeSource ??
      body.fees ??
      body.money?.feeSource?.amount,
    0
  );
}

function pickTargetAmount(body = {}, amount, fee) {
  return optionalAmount(
    body.amountTarget ??
      body.localAmount ??
      body.netAmount ??
      body.money?.target?.amount,
    Math.max(0, amount - fee)
  );
}

function pickExchangeRate(body = {}) {
  return optionalAmount(
    body.exchangeRate ?? body.fxRateSourceToTarget ?? body.money?.fxRateSourceToTarget,
    1
  );
}

function buildRecipientSnapshot(body = {}) {
  const rawCard = String(body.cardNumber || body.beneficiary?.cardNumber || "")
    .replace(/\D/g, "");

  return {
    receiverId:
      body.receiver ||
      body.receiverId ||
      body.receiverUserId ||
      body.recipientInfo?.receiverId ||
      body.recipientInfo?.userId ||
      body.meta?.resolvedPaynovalRecipient?.receiverId ||
      body.meta?.resolvedPaynovalRecipient?.userId ||
      body.meta?.receiverId ||
      body.meta?.receiverUserId ||
      null,

    email:
      body.toEmail ||
      body.recipientEmail ||
      body.recipientInfo?.email ||
      body.beneficiary?.email ||
      body.meta?.recipientEmail ||
      body.meta?.toEmail ||
      null,

    name:
      body.recipientName ||
      body.toName ||
      body.recipientInfo?.name ||
      body.recipientInfo?.accountHolderName ||
      body.beneficiary?.name ||
      body.meta?.resolvedPaynovalRecipient?.fullName ||
      body.meta?.resolvedPaynovalRecipient?.displayName ||
      null,

    phone:
      body.phoneNumber ||
      body.toPhone ||
      body.recipientPhone ||
      body.beneficiary?.phoneNumber ||
      body.meta?.resolvedPaynovalRecipient?.phone ||
      null,

    operator:
      body.operator ||
      body.operatorName ||
      body.provider ||
      body.providerSelected ||
      null,

    bankName: body.bankName || body.beneficiary?.bankName || null,

    cardLast4: rawCard.length >= 4 ? rawCard.slice(-4) : null,

    country:
      body.recipientInfo?.country ||
      body.meta?.resolvedPaynovalRecipient?.country ||
      body.toCountry ||
      body.destinationCountry ||
      null,

    currency:
      body.recipientInfo?.currency ||
      body.meta?.resolvedPaynovalRecipient?.currency ||
      body.currencyTarget ||
      body.localCurrencyCode ||
      null,
  };
}

function resolveReceiverIdForTx({ userId, flowInfo, recipientSnapshot }) {
  if (flowInfo.type === "external_in") {
    return userId;
  }

  if (flowInfo.type === "internal") {
    const receiverId = String(recipientSnapshot?.receiverId || "").trim();

    if (receiverId && mongoose.isValidObjectId(receiverId)) {
      return receiverId;
    }

    return userId;
  }

  return null;
}

function resolveFundsRail(body = {}, flowInfo) {
  if (flowInfo.type === "external_in") {
    return normalizeRail(body.funds || body.provider || body.method, "stripe");
  }

  return normalizeRail(body.funds || "paynoval", "paynoval");
}

function resolveDestinationRail(body = {}, flowInfo) {
  if (flowInfo.type === "external_out") {
    const destination = norm(body.destination || body.provider || body.method);

    if (destination === "card") return "visa_direct";
    if (destination === "mobilemoney" || destination === "mobile_money") return "mobilemoney";
    if (destination === "bank" || destination === "bank_transfer") return "bank";

    return normalizeRail(destination, "mobilemoney");
  }

  return normalizeRail(body.destination || "paynoval", "paynoval");
}

async function autoCreateAppleReviewWallet({ Model, userId, currency }) {
  if (!isAppleReviewUserId(userId)) {
    return null;
  }

  const rawBalance =
    process.env.APPLE_REVIEW_SANDBOX_BALANCE_CAD ||
    process.env.APPLE_REVIEW_SANDBOX_BALANCE ||
    1000;

  const balance = Number(rawBalance);
  const safeBalance = Number.isFinite(balance) && balance >= 0 ? balance : 1000;
  const now = new Date();

  const userPayload = buildWalletUserPayload(Model, userId);

  const query = {
    $or: buildWalletUserOrQuery(Model, userId),
    currency,
  };

  const payload = {
    ...userPayload,
    currency,
    amount: toDecimal128(safeBalance, currency),
    availableAmount: toDecimal128(safeBalance, currency),
    reservedAmount: toDecimal128(0, currency),
    status: "active",
    isSandbox: true,
    metadata: {
      source: "apple_review_auto_wallet",
      reason:
        "Wallet sandbox recréé automatiquement côté tx-core car introuvable.",
      userId,
      currency,
      balance: safeBalance,
      createdAt: now,
    },
  };

  return Model.findOneAndUpdate(
    query,
    { $set: payload },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );
}

async function getSandboxWallet({ userId, currency }) {
  const TxWalletBalance = getTxWalletBalanceModel();

  const baseQuery = {
    $or: buildWalletUserOrQuery(TxWalletBalance, userId),
    currency,
  };

  let wallet = await TxWalletBalance.findOne({
    ...baseQuery,
    status: "active",
  });

  if (!wallet) {
    wallet = await TxWalletBalance.findOne(baseQuery);
  }

  if (!wallet) {
    wallet = await autoCreateAppleReviewWallet({
      Model: TxWalletBalance,
      userId,
      currency,
    });
  }

  if (!wallet) {
    const error = new Error(`Wallet sandbox ${currency} introuvable.`);
    error.status = 404;
    error.statusCode = 404;
    throw error;
  }

  wallet.status = "active";
  wallet.isSandbox = true;

  return wallet;
}

function assertWalletCanMutate({ wallet, action, amount }) {
  if (action === "credit") return;

  const currentAmount = decimalToNumber(wallet.amount);
  const currentAvailable = decimalToNumber(
    wallet.availableAmount ?? wallet.amount
  );

  if (currentAvailable < amount || currentAmount < amount) {
    const error = new Error("Solde sandbox insuffisant.");
    error.status = 400;
    error.statusCode = 400;
    throw error;
  }
}

async function applySandboxWalletMutation({
  wallet,
  action,
  amount,
  currency,
  session,
}) {
  const currentAmount = decimalToNumber(wallet.amount);
  const currentAvailable = decimalToNumber(
    wallet.availableAmount ?? wallet.amount
  );

  let nextAmount = currentAmount;
  let nextAvailable = currentAvailable;

  if (action === "credit") {
    nextAmount = currentAmount + amount;
    nextAvailable = currentAvailable + amount;
  } else {
    if (currentAvailable < amount || currentAmount < amount) {
      const error = new Error("Solde sandbox insuffisant.");
      error.status = 400;
      error.statusCode = 400;
      throw error;
    }

    nextAmount = currentAmount - amount;
    nextAvailable = currentAvailable - amount;
  }

  wallet.amount = toDecimal128(nextAmount, currency);
  wallet.availableAmount = toDecimal128(nextAvailable, currency);
  wallet.reservedAmount = wallet.reservedAmount || toDecimal128(0, currency);
  wallet.status = "active";
  wallet.isSandbox = true;

  wallet.metadata = {
    ...(wallet.metadata || {}),
    lastSandboxMutation: {
      action,
      amount,
      currency,
      at: new Date().toISOString(),
    },
  };

  if (session) {
    await wallet.save({ session });
  } else {
    await wallet.save();
  }

  return {
    amount: roundCurrency(nextAmount, currency),
    availableAmount: roundCurrency(nextAvailable, currency),
  };
}

function getUserId(user) {
  const userId = String(resolveUserId(user) || "").trim();

  if (!userId) {
    const error = new Error("Utilisateur sandbox introuvable.");
    error.status = 401;
    error.statusCode = 401;
    throw error;
  }

  if (!mongoose.isValidObjectId(userId)) {
    const error = new Error("Identifiant utilisateur sandbox invalide.");
    error.status = 400;
    error.statusCode = 400;
    throw error;
  }

  return userId;
}

async function createTransactionAndMutateWallet({
  Transaction,
  txPayload,
  wallet,
  flowInfo,
  amount,
  currency,
}) {
  const conn = Transaction.db;
  let session = null;

  try {
    if (conn && typeof conn.startSession === "function") {
      session = await conn.startSession();
      session.startTransaction();

      const created = await Transaction.create([txPayload], { session });
      const tx = created[0];

      const walletAfter = await applySandboxWalletMutation({
        wallet,
        action: flowInfo.walletAction,
        amount,
        currency,
        session,
      });

      await session.commitTransaction();
      session.endSession();

      return { tx, walletAfter };
    }
  } catch (err) {
    try {
      if (session) await session.abortTransaction();
    } catch (_) {}

    try {
      if (session) session.endSession();
    } catch (_) {}

    throw err;
  }

  const tx = await Transaction.create(txPayload);

  const walletAfter = await applySandboxWalletMutation({
    wallet,
    action: flowInfo.walletAction,
    amount,
    currency,
  });

  return { tx, walletAfter };
}

async function createSandboxTransaction({ user, body = {}, metadata = {} }) {
  if (!isSandboxUser(user)) {
    const error = new Error(
      "Cette transaction sandbox est réservée aux comptes sandbox."
    );
    error.status = 403;
    error.statusCode = 403;
    throw error;
  }

  const Transaction = getTransactionModel();

  const userId = getUserId(user);
  const amount = normalizeAmount(pickAmount(body));
  const currency = pickCurrency(body, user);
  const fees = pickFees(body);
  const targetAmount = pickTargetAmount(body, amount, fees);
  const exchangeRate = pickExchangeRate(body);
  const flowInfo = resolveSandboxFlowType(body);

  const wallet = await getSandboxWallet({
    userId,
    currency,
  });

  assertWalletCanMutate({
    wallet,
    action: flowInfo.walletAction,
    amount,
  });

  const now = new Date();
  const reference = buildSandboxReference();
  const recipientSnapshot = buildRecipientSnapshot(body);
  const receiverId = resolveReceiverIdForTx({
    userId,
    flowInfo,
    recipientSnapshot,
  });

  const fundsRail = resolveFundsRail(body, flowInfo);
  const destinationRail = resolveDestinationRail(body, flowInfo);

  const txPayload = {
    reference,

    userId,
    sender: userId,
    receiver: receiverId,

    senderName: user.fullName || user.name || "Apple Reviewer",
    senderEmail: user.email || null,

    nameDestinataire: recipientSnapshot.name || null,
    recipientEmail: recipientSnapshot.email || null,

    operationKind: "transfer",
    initiatedBy: "user",

    amount: toDecimal128(amount, currency),
    amountSource: toDecimal128(amount, currency),
    transactionFees: toDecimal128(fees, currency),
    feeSource: toDecimal128(fees, currency),
    netAmount: toDecimal128(targetAmount, currency),
    amountTarget: toDecimal128(targetAmount, currency),
    localAmount: toDecimal128(targetAmount, currency),

    exchangeRate: toDecimal128(exchangeRate, currency),
    fxRateSourceToTarget: toDecimal128(exchangeRate, currency),

    currency,
    currencySource: currency,
    currencyTarget: currency,
    senderCurrencySymbol: currency,
    localCurrencySymbol: currency,

    money: {
      source: {
        amount,
        currency,
      },
      feeSource: {
        amount: fees,
        currency,
      },
      target: {
        amount: targetAmount,
        currency,
      },
      fxRateSourceToTarget: exchangeRate,
    },

    funds: fundsRail,
    destination: destinationRail,

    provider: "sandbox",
    operator: null,
    flow: flowInfo.flow,

    status: "confirmed",
    providerStatus: "sandbox_completed",
    providerReference: reference,

    fundsReserved: false,
    fundsCaptured: true,
    fundsCapturedAt: now,

    reserveReleased: false,

    beneficiaryCredited: false,
    beneficiaryCreditedAt: null,

    treasuryRevenueCredited: false,

    description:
      body.description || "Transaction simulée pour Apple App Review.",

    metadata: {
      source: "apple_review_sandbox",
      sandbox: true,
      reason: "Aucun argent réel déplacé.",
      flowType: flowInfo.type,
      walletAction: flowInfo.walletAction,
      originalProvider: body.provider || body.channel || null,
      originalFlow: body.flow || body.meta?.flow || null,
      recipientSnapshot,
      realReceiverNotCredited: true,
      providerExecutionSkipped: true,
      ...metadata,
    },

    meta: {
      source: "apple_review_sandbox",
      sandbox: true,
      flowType: flowInfo.type,
      walletAction: flowInfo.walletAction,
      providerExecutionSkipped: true,
      realReceiverNotCredited: true,
      recipientSnapshot,
    },

    confirmedAt: now,
    executedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const { tx, walletAfter } = await createTransactionAndMutateWallet({
    Transaction,
    txPayload,
    wallet,
    flowInfo,
    amount,
    currency,
  });

  return {
    transaction: tx,
    wallet: {
      user: userId,
      currency,
      amount: walletAfter.amount,
      availableAmount: walletAfter.availableAmount,
    },
  };
}

module.exports = {
  createSandboxTransaction,
};