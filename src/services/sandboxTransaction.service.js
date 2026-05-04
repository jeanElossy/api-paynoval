// File: src/services/transactions/handlers/sandboxTransaction.service.js
"use strict";

const mongoose = require("mongoose");
const runtime = require("../services/transactions/shared/runtime");

const { isSandboxUser, resolveUserId } = require("../utils/sandboxUser");

const {
  resolveExternalFlow,
  isOutboundExternalFlow,
  isInboundExternalFlow,
} = require("./flowHelpers");

function loadModel(modPath) {
  const mod = require(modPath);

  if (mod && typeof mod === "function" && mod.modelName) return mod;
  if (typeof mod === "function" && !mod.modelName) return mod();

  return mod;
}

const TxWalletBalance =
  runtime.TxWalletBalance || loadModel("../../../models/TxWalletBalance");

function normalizeCurrency(value) {
  return String(value || "CAD").trim().toUpperCase();
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

function currencyDecimals(currency = "CAD") {
  return ["XOF", "XAF", "JPY"].includes(normalizeCurrency(currency)) ? 0 : 2;
}

function roundCurrency(amount, currency = "CAD") {
  const decimals = currencyDecimals(currency);
  const n = Number(amount || 0);
  const safe = Number.isFinite(n) ? n : 0;
  return Number(safe.toFixed(decimals));
}

function toDecimal128(amount, currency = "CAD") {
  const rounded = roundCurrency(amount, currency);
  return mongoose.Types.Decimal128.fromString(
    rounded.toFixed(currencyDecimals(currency))
  );
}

function decimalToNumber(value) {
  if (value == null) return 0;

  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  if (typeof value === "object" && value.$numberDecimal) {
    const n = Number(value.$numberDecimal);
    return Number.isFinite(n) ? n : 0;
  }

  const n = Number(value.toString());
  return Number.isFinite(n) ? n : 0;
}

function norm(v) {
  return String(v || "").trim().toLowerCase();
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
      flow: externalFlow,
      walletAction: "debit",
    };
  }

  if (externalFlow && isInboundExternalFlow(externalFlow)) {
    return {
      type: "external_in",
      flow: externalFlow,
      walletAction: "credit",
    };
  }

  return {
    type: "generic",
    flow: body.flow || "SANDBOX_APPLE_REVIEW",
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

function buildRecipientSnapshot(body = {}) {
  return {
    email:
      body.toEmail ||
      body.recipientEmail ||
      body.recipientInfo?.email ||
      body.beneficiary?.email ||
      null,
    name:
      body.recipientName ||
      body.toName ||
      body.recipientInfo?.name ||
      body.beneficiary?.name ||
      null,
    phone:
      body.phoneNumber ||
      body.toPhone ||
      body.recipientPhone ||
      body.beneficiary?.phoneNumber ||
      null,
    operator:
      body.operator ||
      body.operatorName ||
      body.provider ||
      body.providerSelected ||
      null,
    bankName: body.bankName || body.beneficiary?.bankName || null,
    cardLast4: body.cardNumber
      ? String(body.cardNumber).replace(/\D/g, "").slice(-4)
      : null,
  };
}

async function getSandboxWallet({ userId, currency }) {
  const wallet = await TxWalletBalance.findOne({
    user: userId,
    currency,
    status: "active",
  });

  if (!wallet) {
    const error = new Error(`Wallet sandbox ${currency} introuvable.`);
    error.status = 404;
    error.statusCode = 404;
    throw error;
  }

  return wallet;
}

async function applySandboxWalletMutation({
  wallet,
  action,
  amount,
  currency,
}) {
  const currentAmount = decimalToNumber(wallet.amount);
  const currentAvailable = decimalToNumber(wallet.availableAmount ?? wallet.amount);

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

  await wallet.save();

  return {
    amount: roundCurrency(nextAmount, currency),
    availableAmount: roundCurrency(nextAvailable, currency),
  };
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

  const Transaction = runtime.Transaction;

  if (!Transaction) {
    const error = new Error("Transaction model indisponible.");
    error.status = 500;
    error.statusCode = 500;
    throw error;
  }

  const userId = String(resolveUserId(user) || "").trim();

  if (!userId) {
    const error = new Error("Utilisateur sandbox introuvable.");
    error.status = 401;
    error.statusCode = 401;
    throw error;
  }

  const amount = normalizeAmount(pickAmount(body));
  const currency = pickCurrency(body, user);
  const flowInfo = resolveSandboxFlowType(body);

  const wallet = await getSandboxWallet({
    userId,
    currency,
  });

  const walletAfter = await applySandboxWalletMutation({
    wallet,
    action: flowInfo.walletAction,
    amount,
    currency,
  });

  const now = new Date();
  const reference = buildSandboxReference();

  const txPayload = {
    reference,

    user: userId,
    userId,
    sender: userId,
    createdBy: userId,
    ownerUserId: userId,

    receiver: null,
    receiverUserId: null,

    amount,
    netAmount: amount,
    currency,
    currencySource: currency,
    currencyTarget: currency,
    senderCurrencySymbol: currency,
    localCurrencySymbol: currency,

    funds: body.funds || "paynoval",
    destination: body.destination || "sandbox",

    provider: "sandbox",
    channel: "sandbox",
    method: "sandbox",
    flow: flowInfo.flow,

    status: "completed",
    providerStatus: "sandbox_completed",
    providerReference: reference,

    isSandbox: true,
    fundsReserved: false,
    fundsCaptured: true,
    reserveReleased: false,
    beneficiaryCredited: flowInfo.walletAction === "credit",

    description:
      body.description || "Transaction simulée pour Apple App Review.",

    recipientEmail:
      body.toEmail ||
      body.recipientEmail ||
      body.recipientInfo?.email ||
      null,

    recipientName:
      body.recipientName ||
      body.toName ||
      body.recipientInfo?.name ||
      null,

    metadata: {
      source: "apple_review_sandbox",
      reason: "Aucun argent réel déplacé.",
      flowType: flowInfo.type,
      walletAction: flowInfo.walletAction,
      originalProvider: body.provider || body.channel || null,
      originalFlow: body.flow || null,
      recipientSnapshot: buildRecipientSnapshot(body),
      ...metadata,
    },

    meta: {
      source: "apple_review_sandbox",
      sandbox: true,
      flowType: flowInfo.type,
      walletAction: flowInfo.walletAction,
    },

    completedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const tx = await Transaction.create(txPayload);

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