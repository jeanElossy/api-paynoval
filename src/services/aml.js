// File: services/aml.js
"use strict";

const AMLLog = require("../models/AMLLog");
const Transaction = require("../models/Transaction");
const { getSingleTxLimit } = require("../tools/amlLimits");
const { getCurrencySymbolByCode } = require("../tools/currency");

function normalizeIso(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return "";
  if (s === "FCFA" || s === "CFA" || s === "F CFA" || s.includes("CFA")) return "XOF";
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
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;

  if (typeof v?.toString === "function" && v?.toString !== Object.prototype.toString) {
    const n = parseFloat(String(v.toString()).replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }

  const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

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
      amount: Number.isFinite(amount) ? amount : 0,
      currency: currency ? normalizeIso(currency) : null,
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
    // ne jamais casser un flux tx à cause d'un log AML
    console.error("[AML-LOG] Failed to record log", e?.message || e);
  }
}

/**
 * ✅ currencyMatch robuste :
 * - match ISO (XOF/EUR/USD/CAD)
 * - + accepte symbole correspondant ("F CFA", "€", "$", "$USD", "$CAD")
 * - + match aussi currencySource/currencyTarget/legacy champs
 */
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
  if (iso === "EUR") compat.add("€");
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
    ],
  };
}

/**
 * ✅ Stats AML par user/provider/devise
 * IMPORTANT: tes tx internes stockent sender/receiver (pas userId).
 * Donc on calcule sur sender=userId (initiate) principalement.
 */
async function getUserTransactionsStats(userId, provider, currencyISO = null) {
  const currency = normalizeIso(currencyISO);
  const currencyMatch = currency ? buildCurrencyOrMatch(currency) : {};

  const now = Date.now();

  const lastHour = await Transaction.countDocuments({
    sender: userId,
    funds: provider, // ou destination/provider selon tes champs
    ...(currency ? currencyMatch : {}),
    createdAt: { $gte: new Date(now - 60 * 60 * 1000) },
  });

  const matchQuery = {
    sender: userId,
    funds: provider,
    createdAt: { $gte: new Date(now - 24 * 60 * 60 * 1000) },
    ...(currency ? currencyMatch : {}),
  };

  let dailyTotal = 0;

  try {
    const dailyTotalAgg = await Transaction.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: "$amount" } },
        },
      },
    ]);
    dailyTotal = dailyTotalAgg.length ? safeNumber(dailyTotalAgg[0].total) : 0;
  } catch {
    const txs = await Transaction.find(matchQuery).select("amount").lean();
    dailyTotal = txs.reduce((acc, t) => acc + safeNumber(t?.amount), 0);
  }

  const cutoff = new Date(now - 10 * 60 * 1000);

  const recentTx = await Transaction.find({
    sender: userId,
    funds: provider,
    ...(currency ? currencyMatch : {}),
    createdAt: { $gte: cutoff },
  })
    .select("recipientEmail toEmail toIBAN iban toPhone phoneNumber")
    .lean();

  const destCount = {};
  for (const tx of recentTx) {
    const key =
      tx.recipientEmail ||
      tx.toEmail ||
      tx.toIBAN ||
      tx.iban ||
      tx.toPhone ||
      tx.phoneNumber ||
      "none";
    destCount[key] = (destCount[key] || 0) + 1;
  }

  const sameDestShortTime = Object.keys(destCount).length ? Math.max(...Object.values(destCount)) : 0;

  return { lastHour, dailyTotal, sameDestShortTime };
}

async function getPEPOrSanctionedStatus(user, { toEmail }) {
  // Placeholder: remplace par un vrai check sanctions/pep si tu as
  if (user?.email === "ministere@etat.gov" || (toEmail && String(toEmail).endsWith("@etat.gov"))) {
    return { sanctioned: true, reason: "Utilisateur/personne politiquement exposée (PEP)" };
  }
  return { sanctioned: false };
}

async function getMLScore(payload, user) {
  const provider = String(payload?.provider || payload?.destination || payload?.funds || "paynoval").trim().toLowerCase();

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
};
