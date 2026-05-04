"use strict";

require("dotenv").config();

const path = require("path");
const mongoose = require("mongoose");

function tryRequireModel() {
  const candidates = [
    "../src/models/TxWalletBalance",
    "../models/TxWalletBalance",
  ];

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(__dirname, candidate);
      return require(resolved);
    } catch (err) {
      if (err?.code !== "MODULE_NOT_FOUND") {
        throw err;
      }
    }
  }

  throw new Error(
    "Modèle TxWalletBalance introuvable. Vérifie s’il est dans src/models/TxWalletBalance.js ou models/TxWalletBalance.js."
  );
}

function getTxWalletBalanceModel() {
  const mod = tryRequireModel();

  if (mod && typeof mod === "function" && mod.modelName) {
    return mod;
  }

  if (typeof mod === "function") {
    return mod(mongoose);
  }

  return mod;
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    throw new Error(`${name} est manquant dans .env.`);
  }

  return value;
}

function getMongoUri() {
  return (
    process.env.MONGO_TX_URI ||
    process.env.MONGO_URI_TRANSACTIONS ||
    process.env.TX_MONGO_URI ||
    process.env.MONGO_TRANSACTIONS_URI ||
    process.env.MONGO_URI ||
    process.env.DATABASE_URL ||
    ""
  );
}

function normalizeCurrency(value) {
  return String(value || "CAD").trim().toUpperCase();
}

function currencyDecimals(currency = "CAD") {
  const cur = normalizeCurrency(currency);
  return ["XOF", "XAF", "JPY"].includes(cur) ? 0 : 2;
}

function toDecimal128(amount, currency = "CAD") {
  const decimals = currencyDecimals(currency);
  const n = Number(amount || 0);
  const safe = Number.isFinite(n) ? n : 0;

  return mongoose.Types.Decimal128.fromString(safe.toFixed(decimals));
}

async function connectDB() {
  const mongoUri = getMongoUri();

  if (!mongoUri) {
    throw new Error(
      "MONGO_TX_URI, MONGO_URI_TRANSACTIONS ou MONGO_URI est manquant dans .env."
    );
  }

  if (mongoose.connection.readyState === 1) {
    return;
  }

  await mongoose.connect(mongoUri);
}

async function seedAppleReviewerWallet() {
  await connectDB();

  const TxWalletBalance = getTxWalletBalanceModel();

  const userId = requiredEnv("APPLE_REVIEW_USER_ID");

  const currency = normalizeCurrency(
    process.env.APPLE_REVIEW_CURRENCY || "CAD"
  );

  const balance = Number(
    process.env.APPLE_REVIEW_SANDBOX_BALANCE_CAD || 1000
  );

  if (!mongoose.isValidObjectId(userId)) {
    throw new Error("APPLE_REVIEW_USER_ID n’est pas un ObjectId Mongo valide.");
  }

  if (!Number.isFinite(balance) || balance < 0) {
    throw new Error("APPLE_REVIEW_SANDBOX_BALANCE_CAD doit être un nombre valide.");
  }

  const now = new Date();

  const wallet = await TxWalletBalance.findOneAndUpdate(
    {
      user: userId,
      currency,
    },
    {
      $set: {
        user: userId,
        currency,
        amount: toDecimal128(balance, currency),
        availableAmount: toDecimal128(balance, currency),
        reservedAmount: toDecimal128(0, currency),
        status: "active",
        isSandbox: true,
        metadata: {
          source: "apple_review_seed",
          reason: "Apple App Review sandbox wallet",
          userId,
          currency,
          balance,
          seededAt: now,
        },
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );

  console.log("✅ Wallet sandbox Apple Review prêt :");
  console.log({
    walletId: wallet._id.toString(),
    userId,
    currency: wallet.currency,
    amount: Number(wallet.amount?.toString?.() || 0),
    availableAmount: Number(wallet.availableAmount?.toString?.() || 0),
    reservedAmount: Number(wallet.reservedAmount?.toString?.() || 0),
    status: wallet.status,
    isSandbox: wallet.isSandbox === true,
  });

  await mongoose.disconnect();
}

seedAppleReviewerWallet().catch(async (err) => {
  console.error("❌ Erreur seedAppleReviewerWallet :", err?.message || err);

  try {
    await mongoose.disconnect();
  } catch (_) {}

  process.exit(1);
});