// File: config/cancellationFees.js

"use strict";

const ZERO_DECIMAL_CURRENCIES = new Set(["XOF", "XAF", "JPY"]);

const CANCELLATION_FEES_BY_COUNTRY = {
  CA: {
    countryCode: "CA",
    countryName: "Canada",
    currency: "CAD",
    amount: 2.99,
    type: "fixed",
    percent: 0,
    feeId: null,
    source: "COUNTRY_CA_CANCEL_2_99_CAD",
    label: "$CAD 2.99",
  },

  CI: {
    countryCode: "CI",
    countryName: "Côte d'Ivoire",
    currency: "XOF",
    amount: 300,
    type: "fixed",
    percent: 0,
    feeId: null,
    source: "COUNTRY_CI_CANCEL_300_XOF",
    label: "300 F CFA",
  },
};

function normalizeCurrency(value) {
  const raw = String(value || "").trim().toUpperCase();
  return raw || "CAD";
}

function normalizeCountryCode(value) {
  const raw = String(value || "").trim().toUpperCase();

  if (!raw) return null;

  if (["CA", "CAN", "CANADA"].includes(raw)) return "CA";

  if (
    [
      "CI",
      "CIV",
      "CÔTE D'IVOIRE",
      "COTE D'IVOIRE",
      "CÔTE D IVOIRE",
      "COTE D IVOIRE",
      "IVORY COAST",
    ].includes(raw)
  ) {
    return "CI";
  }

  return raw;
}

function roundMoney(amount, currency = "CAD") {
  const cur = normalizeCurrency(currency);
  const n = Number(amount || 0);

  if (!Number.isFinite(n)) return 0;

  const decimals = ZERO_DECIMAL_CURRENCIES.has(cur) ? 0 : 2;
  return Number(n.toFixed(decimals));
}

function extractSenderCountryCode(tx = {}) {
  const meta = tx?.meta && typeof tx.meta === "object" ? tx.meta : {};
  const senderSnapshot =
    tx?.senderSnapshot && typeof tx.senderSnapshot === "object"
      ? tx.senderSnapshot
      : {};

  const possibleValues = [
    tx.senderCountryCode,
    tx.sourceCountryCode,
    tx.fromCountryCode,
    tx.countryCode,

    tx.senderCountry,
    tx.sourceCountry,
    tx.fromCountry,
    tx.country,

    senderSnapshot.countryCode,
    senderSnapshot.country,

    meta.senderCountryCode,
    meta.sourceCountryCode,
    meta.fromCountryCode,
    meta.countryCode,

    meta.senderCountry,
    meta.sourceCountry,
    meta.fromCountry,
    meta.country,
  ];

  for (const value of possibleValues) {
    const normalized = normalizeCountryCode(value);
    if (normalized) return normalized;
  }

  return null;
}

function resolveCancellationFeeRule({ countryCode, currency } = {}) {
  const cur = normalizeCurrency(currency);
  const normalizedCountry = normalizeCountryCode(countryCode);

  if (
    normalizedCountry &&
    CANCELLATION_FEES_BY_COUNTRY[normalizedCountry]
  ) {
    return {
      ...CANCELLATION_FEES_BY_COUNTRY[normalizedCountry],
      resolvedBy: "country",
    };
  }

  if (cur === "CAD") {
    return {
      countryCode: null,
      countryName: null,
      currency: "CAD",
      amount: 2.99,
      type: "fixed",
      percent: 0,
      feeId: null,
      source: "FALLBACK_CURRENCY_CAD_CANCEL_2_99",
      label: "$CAD 2.99",
      resolvedBy: "currency",
    };
  }

  if (cur === "XOF" || cur === "XAF") {
    return {
      countryCode: null,
      countryName: null,
      currency: cur,
      amount: 300,
      type: "fixed",
      percent: 0,
      feeId: null,
      source: `FALLBACK_CURRENCY_${cur}_CANCEL_300`,
      label: cur === "XOF" ? "300 F CFA" : `300 ${cur}`,
      resolvedBy: "currency",
    };
  }

  return {
    countryCode: null,
    countryName: null,
    currency: cur,
    amount: 0,
    type: "fixed",
    percent: 0,
    feeId: null,
    source: "NO_STATIC_CANCEL_FEE",
    label: `0 ${cur}`,
    resolvedBy: "none",
  };
}

module.exports = {
  ZERO_DECIMAL_CURRENCIES,
  CANCELLATION_FEES_BY_COUNTRY,
  normalizeCurrency,
  normalizeCountryCode,
  roundMoney,
  extractSenderCountryCode,
  resolveCancellationFeeRule,
};