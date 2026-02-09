// File: tools/amlLimits.js
"use strict";

const { getCurrencySymbolByCode, getCurrencyCodeByCountry } = require("./currency");

/**
 * Plafonds AML _journaliers_ (cumul 24h)
 * Table en symbole (car UI) mais on RESOUT en ISO d'abord.
 */
const AML_DAILY_LIMITS = {
  paynoval: {
    "F CFA": 5_000_000,
    "€": 10_000,
    "$": 10_000,
    "$USD": 10_000,
    "$CAD": 10_000,
    "£": 8_000,
  },
  stripe: {
    "F CFA": 3_000_000,
    "€": 10_000,
    "$": 10_000,
    "$USD": 10_000,
    "$CAD": 10_000,
  },
  mobilemoney: {
    "F CFA": 2_000_000,
    "€": 2_000,
    "$": 2_000,
    "$USD": 2_000,
    "$CAD": 2_000,
  },
  bank: {
    "F CFA": 50_000_000,
    "€": 100_000,
    "$": 100_000,
    "$USD": 100_000,
    "$CAD": 100_000,
  },
};

/**
 * Plafonds AML _par envoi_ (single transaction)
 */
const AML_SINGLE_TX_LIMITS = {
  paynoval: {
    "F CFA": 2_000_000,
    "€": 5_000,
    "$": 5_000,
    "$USD": 5_000,
    "$CAD": 5_000,
    "£": 3_000,
  },
  stripe: {
    "F CFA": 1_500_000,
    "€": 2_000,
    "$": 2_000,
    "$USD": 2_000,
    "$CAD": 2_000,
  },
  mobilemoney: {
    "F CFA": 750_000,
    "€": 1_000,
    "$": 1_000,
    "$USD": 1_000,
    "$CAD": 1_000,
  },
  bank: {
    "F CFA": 10_000_000,
    "€": 40_000,
    "$": 40_000,
    "$USD": 40_000,
    "$CAD": 40_000,
  },
};

// ---------- Helpers robustes ----------
const normalizeIso = (v) => {
  const s0 = String(v || "").trim().toUpperCase();
  if (!s0) return "";

  const s = s0.replace(/\u00A0/g, " ");

  if (s.includes("CFA") || s === "FCFA" || s === "F CFA") return "XOF";
  if (s === "XAF") return "XAF";
  if (s === "XOF") return "XOF";

  if (s === "€") return "EUR";
  if (s === "£") return "GBP";
  if (s === "$") return "USD";

  const letters = s.replace(/[^A-Z]/g, "");

  if (letters === "CAD") return "CAD";
  if (letters === "USD") return "USD";
  if (letters === "EUR") return "EUR";
  if (letters === "GBP") return "GBP";
  if (letters === "XOF") return "XOF";
  if (letters === "XAF") return "XAF";

  if (/^[A-Z]{3}$/.test(letters)) return letters;
  if (/^[A-Z]{3}$/.test(s)) return s;

  return "";
};

/**
 * ✅ Résout la devise AML à partir du body.
 * Priorité: currencySource/senderCurrencyCode > currencyCode > currency/selectedCurrency > (senderCountry/country → currency)
 */
function resolveAmlCurrency(body = {}) {
  const iso =
    normalizeIso(body.currencySource) ||
    normalizeIso(body.senderCurrencyCode) ||
    normalizeIso(body.currencyCode) ||
    normalizeIso(body.currencySender) ||
    normalizeIso(body.currency) ||
    normalizeIso(body.selectedCurrency);

  if (iso) return iso;

  const ctry = body.senderCountry || body.originCountry || body.fromCountry || body.country || "";
  const byCountry = normalizeIso(getCurrencyCodeByCountry(ctry));
  return byCountry || "USD";
}

/**
 * ✅ Résout le montant AML.
 * Priorité: amountSource > amount
 */
function resolveAmlAmount(body = {}) {
  const raw = body.amountSource ?? body.amount ?? 0;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function getSingleTxLimit(provider, currencyISO) {
  const limits = AML_SINGLE_TX_LIMITS[String(provider || "").toLowerCase()] || {};
  const iso = normalizeIso(currencyISO) || "USD";
  const symbol = getCurrencySymbolByCode(iso); // XOF -> "F CFA", EUR->"€", USD->"$", CAD->"$CAD"
  return limits[symbol] ?? limits["$"] ?? 1_000_000;
}

function getDailyLimit(provider, currencyISO) {
  const limits = AML_DAILY_LIMITS[String(provider || "").toLowerCase()] || {};
  const iso = normalizeIso(currencyISO) || "USD";
  const symbol = getCurrencySymbolByCode(iso);
  return limits[symbol] ?? limits["$"] ?? 5_000_000;
}

module.exports = {
  AML_SINGLE_TX_LIMITS,
  AML_DAILY_LIMITS,
  getSingleTxLimit,
  getDailyLimit,
  resolveAmlCurrency,
  resolveAmlAmount,
  normalizeIso,
};
