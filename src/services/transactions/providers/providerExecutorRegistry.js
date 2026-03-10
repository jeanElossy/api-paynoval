"use strict";

/**
 * Registry des executors provider TX Core.
 * Résout quel executor utiliser selon le flow.
 * Les executors choisissent ensuite le bon adapter provider.
 */

const {
  executeMobileMoneyPayout,
  startMobileMoneyCollection,
} = require("./mobilemoneyExecutor");

const {
  executeBankPayout,
  startBankCollection,
} = require("./bankExecutor");

const {
  executeCardPayout,
  startCardTopup,
} = require("./cardExecutor");

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function getServiceUrlByProvider() {
  return "";
}

function resolveExecutor({ flow, provider }) {
  const p = norm(provider);
  const f = String(flow || "").trim();

  if (
    f === "PAYNOVAL_TO_MOBILEMONEY_PAYOUT" ||
    f === "MOBILEMONEY_COLLECTION_TO_PAYNOVAL"
  ) {
    return {
      execute:
        f === "PAYNOVAL_TO_MOBILEMONEY_PAYOUT"
          ? executeMobileMoneyPayout
          : startMobileMoneyCollection,
      rail: "mobilemoney",
      provider: p || "wave",
    };
  }

  if (
    f === "PAYNOVAL_TO_BANK_PAYOUT" ||
    f === "BANK_TRANSFER_TO_PAYNOVAL"
  ) {
    return {
      execute:
        f === "PAYNOVAL_TO_BANK_PAYOUT"
          ? executeBankPayout
          : startBankCollection,
      rail: "bank",
      provider: p || "bank_generic",
    };
  }

  if (
    f === "PAYNOVAL_TO_CARD_PAYOUT" ||
    f === "CARD_TOPUP_TO_PAYNOVAL"
  ) {
    return {
      execute:
        f === "PAYNOVAL_TO_CARD_PAYOUT"
          ? executeCardPayout
          : startCardTopup,
      rail: "card",
      provider: p || (f === "CARD_TOPUP_TO_PAYNOVAL" ? "stripe" : "visa_direct"),
    };
  }

  return null;
}

module.exports = {
  getServiceUrlByProvider,
  resolveExecutor,
};