// File: config/cancellationFees.js

"use strict";

/**
 * ⚠️ Arrondi et liste de devises délégués à `utils/money` depuis le 2026-09-16.
 * Ce fichier arrondissait par `toFixed` avec trois devises sans décimale, quand
 * le moteur de tarification utilisait `Math.round` avec sa propre liste — deux
 * réponses possibles pour le même montant.
 */
const {
  ZERO_DECIMAL_CURRENCIES,
  roundMoney,
} = require("../utils/money");

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

  /**
   * Table unique des six devises (2026-11-04, décision de l'utilisateur) :
   * 300 en XOF / XAF, 2,99 en CAD, USD, EUR, GBP. Elle ne sert qu'à défaut d'un
   * barème `CANCELLATION` publié au back-office.
   */
  const PAR_DEVISE = {
    XOF: { amount: 300, label: "300 F CFA" },
    XAF: { amount: 300, label: "300 XAF" },
    CAD: { amount: 2.99, label: "$CAD 2.99" },
    USD: { amount: 2.99, label: "$2.99" },
    EUR: { amount: 2.99, label: "2,99 €" },
    GBP: { amount: 2.99, label: "£2.99" },
  };

  if (PAR_DEVISE[cur]) {
    return {
      countryCode: null,
      countryName: null,
      currency: cur,
      amount: PAR_DEVISE[cur].amount,
      type: "fixed",
      percent: 0,
      feeId: null,
      source: `FALLBACK_CURRENCY_${cur}_CANCEL`,
      label: PAR_DEVISE[cur].label,
      resolvedBy: "currency",
    };
  }

  /**
   * Devise hors table : AUCUN montant n'est inventé. Rendait « 0 », ce qui
   * offrait l'annulation gratuite ; l'appelant refuse désormais (règle B.2).
   */
  return null;
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