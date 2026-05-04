// File: services/aml.js
"use strict";

const AMLLog = require("../models/AMLLog");
const TransactionModule = require("../models/Transaction");

const { getSingleTxLimit } = require("../tools/amlLimits");
const { getCurrencySymbolByCode } = require("../tools/currency");

/**
 * --------------------------------------------------------------------------
 * AML Service
 * --------------------------------------------------------------------------
 *
 * Correction principale :
 * - certains projets exportent Transaction directement
 * - d'autres exportent { Transaction }, { default }, { model }, etc.
 * - donc on résout le vrai modèle avant countDocuments/find/aggregate
 *
 * Objectif :
 * - ne plus avoir : Transaction.countDocuments is not a function
 * - garder les stats AML fiables : lastHour, dailyTotal, sameDestShortTime
 * --------------------------------------------------------------------------
 */

/* -------------------------------------------------------------------------- */
/* Model helpers                                                              */
/* -------------------------------------------------------------------------- */

function resolveTransactionModel() {
  const candidates = [
    TransactionModule,
    TransactionModule?.Transaction,
    TransactionModule?.default,
    TransactionModule?.model,
    TransactionModule?.TxTransaction,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (
      typeof candidate?.countDocuments === "function" ||
      typeof candidate?.find === "function" ||
      typeof candidate?.aggregate === "function"
    ) {
      return candidate;
    }
  }

  return null;
}

function getTransactionModelOrThrow() {
  const Transaction = resolveTransactionModel();

  if (!Transaction) {
    const err = new Error(
      "Transaction model indisponible ou export invalide dans ../models/Transaction"
    );
    err.code = "TRANSACTION_MODEL_UNAVAILABLE";
    throw err;
  }

  return Transaction;
}

async function safeCountDocuments(Model, query) {
  if (typeof Model.countDocuments === "function") {
    return Model.countDocuments(query);
  }

  if (typeof Model.count === "function") {
    return Model.count(query);
  }

  if (typeof Model.find === "function") {
    const docs = await Model.find(query).select("_id").lean();
    return Array.isArray(docs) ? docs.length : 0;
  }

  return 0;
}

async function safeAggregate(Model, pipeline) {
  if (typeof Model.aggregate === "function") {
    return Model.aggregate(pipeline);
  }

  return null;
}

async function safeFind(Model, query, select = "") {
  if (typeof Model.find !== "function") return [];

  let q = Model.find(query);

  if (select && typeof q.select === "function") {
    q = q.select(select);
  }

  if (typeof q.lean === "function") {
    q = q.lean();
  }

  const out = await q;
  return Array.isArray(out) ? out : [];
}

/* -------------------------------------------------------------------------- */
/* Currency helpers                                                           */
/* -------------------------------------------------------------------------- */

function normalizeIso(v) {
  const s = String(v || "").trim().toUpperCase();

  if (!s) return "";

  if (s === "FCFA" || s === "CFA" || s === "F CFA" || s.includes("CFA")) {
    return "XOF";
  }

  if (s === "€" || s.includes("EUR")) return "EUR";
  if (s === "$" || s === "$USD" || s.includes("USD")) return "USD";
  if (s === "$CAD" || s.includes("CAD")) return "CAD";
  if (s.includes("GBP") || s.includes("£")) return "GBP";
  if (s.includes("XOF")) return "XOF";
  if (s.includes("XAF")) return "XAF";

  const letters = s.replace(/[^A-Z]/g, "");

  if (/^[A-Z]{3}$/.test(letters)) return letters;
  if (/^[A-Z]{3}$/.test(s)) return s;

  return "";
}

function safeNumber(v) {
  if (v == null) return 0;

  if (typeof v === "number") {
    return Number.isFinite(v) ? v : 0;
  }

  if (
    typeof v?.toString === "function" &&
    v?.toString !== Object.prototype.toString
  ) {
    const n = parseFloat(
      String(v.toString()).replace(/\s/g, "").replace(",", ".")
    );

    return Number.isFinite(n) ? n : 0;
  }

  const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/* -------------------------------------------------------------------------- */
/* AML log                                                                    */
/* -------------------------------------------------------------------------- */

async function logTransaction({
  userId,
  type,
  provider,
  amount,
  currency = null,
  toEmail,
  details,
  flagged = false,
  flagReason = "",
  transactionId = null,
  ip = null,
}) {
  try {
    await AMLLog.create({
      userId: userId || null,
      type: type || "initiate",
      provider: provider || "unknown",
      amount: safeNumber(amount),
      currency: currency ? normalizeIso(currency) || String(currency) : null,
      toEmail: toEmail || "",
      details: details || {},
      flagged: !!flagged,
      flagReason: flagReason || "",
      reviewed: false,
      transactionId,
      ip,
      loggedAt: new Date(),
    });
  } catch (e) {
    console.error("[AML-LOG] Failed to record log", e?.message || e);
  }
}

/* -------------------------------------------------------------------------- */
/* Query builders                                                             */
/* -------------------------------------------------------------------------- */

function buildCurrencyOrMatch(currencyISO) {
  const iso = normalizeIso(currencyISO);
  if (!iso) return {};

  const symbol = getCurrencySymbolByCode(iso);
  const compat = new Set([iso, symbol]);

  if (iso === "USD") {
    compat.add("$");
    compat.add("$USD");
    compat.add("USD$");
    compat.add("US$");
  }

  if (iso === "CAD") {
    compat.add("$CAD");
    compat.add("CAD$");
  }

  if (iso === "EUR") {
    compat.add("€");
  }

  if (iso === "XOF" || iso === "XAF") {
    compat.add("F CFA");
    compat.add("FCFA");
    compat.add("CFA");
  }

  const values = Array.from(compat).filter(Boolean);

  return {
    $or: [
      { currencySource: { $in: values } },
      { currencyTarget: { $in: values } },
      { currency: { $in: values } },
      { currencyCode: { $in: values } },
      { senderCurrencyCode: { $in: values } },
      { senderCurrencySymbol: { $in: values } },
      { localCurrencyCode: { $in: values } },
      { localCurrencySymbol: { $in: values } },
      { "money.source.currency": { $in: values } },
      { "money.target.currency": { $in: values } },
      { "money.feeSource.currency": { $in: values } },
    ],
  };
}

function normalizeProvider(provider) {
  const p = String(provider || "").trim().toLowerCase();

  if (!p) return "";

  if (p === "mobile_money") return "mobilemoney";
  if (p === "visa") return "visa_direct";

  return p;
}

function buildProviderOrMatch(provider) {
  const p = normalizeProvider(provider);

  if (!p) return {};

  const aliases = new Set([p]);

  if (p === "paynoval") {
    aliases.add("internal");
  }

  if (p === "mobilemoney") {
    aliases.add("mobile_money");
    aliases.add("wave");
    aliases.add("orange");
    aliases.add("mtn");
    aliases.add("moov");
    aliases.add("flutterwave");
  }

  if (p === "stripe" || p === "visa_direct" || p === "card") {
    aliases.add("stripe");
    aliases.add("visa_direct");
    aliases.add("visa");
    aliases.add("card");
  }

  const values = Array.from(aliases);

  return {
    $or: [
      { provider: { $in: values } },
      { funds: { $in: values } },
      { destination: { $in: values } },
      { operator: { $in: values } },
      { "metadata.provider": { $in: values } },
      { "meta.provider": { $in: values } },
      { "metadata.rail": { $in: values } },
      { "meta.rail": { $in: values } },
    ],
  };
}

function buildUserOrMatch(userId) {
  const uid = String(userId || "").trim();

  return {
    $or: [
      { userId: uid },
      { sender: uid },
      { receiver: uid },
      { createdBy: uid },
      { ownerUserId: uid },
      { initiatorUserId: uid },
      { "meta.userId": uid },
      { "metadata.userId": uid },
      { "meta.ownerUserId": uid },
      { "metadata.ownerUserId": uid },
    ],
  };
}

function mergeAndQueries(...parts) {
  const cleanParts = parts.filter(
    (part) => part && typeof part === "object" && Object.keys(part).length > 0
  );

  if (!cleanParts.length) return {};
  if (cleanParts.length === 1) return cleanParts[0];

  return {
    $and: cleanParts,
  };
}

function buildAmountExpression() {
  return {
    $convert: {
      input: {
        $ifNull: [
          "$amountSource",
          {
            $ifNull: [
              "$amount",
              {
                $ifNull: ["$money.source.amount", 0],
              },
            ],
          },
        ],
      },
      to: "double",
      onError: 0,
      onNull: 0,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* AML stats                                                                  */
/* -------------------------------------------------------------------------- */

async function getUserTransactionsStats(userId, provider, currencyISO = null) {
  const uid = String(userId || "").trim();

  if (!uid) {
    return {
      lastHour: 0,
      dailyTotal: 0,
      sameDestShortTime: 0,
    };
  }

  const Transaction = getTransactionModelOrThrow();

  const currency = normalizeIso(currencyISO);
  const currencyMatch = currency ? buildCurrencyOrMatch(currency) : {};
  const providerMatch = buildProviderOrMatch(provider);
  const userMatch = buildUserOrMatch(uid);

  const now = Date.now();
  const lastHourDate = new Date(now - 60 * 60 * 1000);
  const last24hDate = new Date(now - 24 * 60 * 60 * 1000);
  const last10minDate = new Date(now - 10 * 60 * 1000);

  const lastHourQuery = mergeAndQueries(userMatch, providerMatch, currencyMatch, {
    createdAt: { $gte: lastHourDate },
  });

  const dailyQuery = mergeAndQueries(userMatch, providerMatch, currencyMatch, {
    createdAt: { $gte: last24hDate },
  });

  const recentQuery = mergeAndQueries(userMatch, providerMatch, currencyMatch, {
    createdAt: { $gte: last10minDate },
  });

  const lastHour = await safeCountDocuments(Transaction, lastHourQuery);

  let dailyTotal = 0;

  try {
    const dailyTotalAgg = await safeAggregate(Transaction, [
      { $match: dailyQuery },
      {
        $group: {
          _id: null,
          total: {
            $sum: buildAmountExpression(),
          },
        },
      },
    ]);

    if (Array.isArray(dailyTotalAgg) && dailyTotalAgg.length) {
      dailyTotal = safeNumber(dailyTotalAgg[0].total);
    }
  } catch {
    dailyTotal = 0;
  }

  if (!dailyTotal) {
    try {
      const txs = await safeFind(
        Transaction,
        dailyQuery,
        "amount amountSource money"
      );

      dailyTotal = txs.reduce((acc, tx) => {
        const txAmount =
          tx?.amountSource ?? tx?.amount ?? tx?.money?.source?.amount ?? 0;

        return acc + safeNumber(txAmount);
      }, 0);
    } catch {
      dailyTotal = 0;
    }
  }

  const recentTx = await safeFind(
    Transaction,
    recentQuery,
    "recipientEmail toEmail toIBAN iban toPhone phoneNumber recipientInfo"
  );

  const destCount = {};

  for (const tx of recentTx) {
    const key =
      tx.recipientEmail ||
      tx.toEmail ||
      tx.recipientInfo?.email ||
      tx.recipientInfo?.recipientEmail ||
      tx.toIBAN ||
      tx.iban ||
      tx.toPhone ||
      tx.phoneNumber ||
      tx.recipientInfo?.phone ||
      "none";

    destCount[key] = (destCount[key] || 0) + 1;
  }

  const sameDestShortTime = Object.keys(destCount).length
    ? Math.max(...Object.values(destCount))
    : 0;

  return {
    lastHour: Number(lastHour || 0),
    dailyTotal: safeNumber(dailyTotal),
    sameDestShortTime: Number(sameDestShortTime || 0),
  };
}

/* -------------------------------------------------------------------------- */
/* PEP / Sanctions placeholder                                                */
/* -------------------------------------------------------------------------- */

async function getPEPOrSanctionedStatus(user, { toEmail }) {
  if (
    user?.email === "ministere@etat.gov" ||
    (toEmail && String(toEmail).endsWith("@etat.gov"))
  ) {
    return {
      sanctioned: true,
      reason: "Utilisateur/personne politiquement exposée (PEP)",
    };
  }

  return {
    sanctioned: false,
  };
}

/* -------------------------------------------------------------------------- */
/* ML score placeholder                                                       */
/* -------------------------------------------------------------------------- */

async function getMLScore(payload, user) {
  const provider = String(
    payload?.provider || payload?.destination || payload?.funds || "paynoval"
  )
    .trim()
    .toLowerCase();

  const currencyISO =
    normalizeIso(payload?.currencySource) ||
    normalizeIso(payload?.currencyCode) ||
    normalizeIso(payload?.senderCurrencyCode) ||
    normalizeIso(payload?.currency) ||
    normalizeIso(payload?.senderCurrencySymbol) ||
    "USD";

  const amt = safeNumber(payload?.amountSource ?? payload?.amount);

  const singleLimit = getSingleTxLimit(provider, currencyISO);

  if (amt > singleLimit) return 0.92;

  return Math.random() * 0.4;
}

async function getBusinessKYBStatus() {
  return "validé";
}

module.exports = {
  logTransaction,
  getUserTransactionsStats,
  getPEPOrSanctionedStatus,
  getMLScore,
  getBusinessKYBStatus,

  normalizeIso,
  safeNumber,
  buildCurrencyOrMatch,
};