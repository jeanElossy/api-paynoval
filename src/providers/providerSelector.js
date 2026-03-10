"use strict";

const waveAdapter = require("./mobilemoney/waveAdapter");
const orangeAdapter = require("./mobilemoney/orangeAdapter");
const mtnAdapter = require("./mobilemoney/mtnAdapter");
const moovAdapter = require("./mobilemoney/moovAdapter");

const bankGenericAdapter = require("./bank/bankGenericAdapter");

const stripeAdapter = require("./card/stripeAdapter");
const visaDirectAdapter = require("./card/visaDirectAdapter");

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function getMobileMoneyAdapter(provider) {
  switch (norm(provider)) {
    case "wave":
      return waveAdapter;
    case "orange":
      return orangeAdapter;
    case "mtn":
      return mtnAdapter;
    case "moov":
      return moovAdapter;
    default:
      throw new Error(`Unsupported mobile money provider: ${provider}`);
  }
}

function getBankAdapter(provider) {
  switch (norm(provider)) {
    case "bank":
    case "generic":
    case "bank_generic":
    case "bankgeneric":
    case "bank-transfer":
    case "bank_transfer":
      return bankGenericAdapter;
    default:
      return bankGenericAdapter;
  }
}

function getCardAdapter(provider) {
  switch (norm(provider)) {
    case "stripe":
      return stripeAdapter;
    case "visa_direct":
    case "visadirect":
    case "visa-direct":
      return visaDirectAdapter;
    default:
      throw new Error(`Unsupported card provider: ${provider}`);
  }
}

function getProviderAdapter({ rail, provider }) {
  switch (norm(rail)) {
    case "mobilemoney":
    case "mobile_money":
    case "mobile-money":
      return getMobileMoneyAdapter(provider);

    case "bank":
    case "bank_transfer":
    case "bank-transfer":
      return getBankAdapter(provider);

    case "card":
      return getCardAdapter(provider);

    default:
      throw new Error(`Unsupported rail: ${rail}`);
  }
}

module.exports = {
  getProviderAdapter,
  getMobileMoneyAdapter,
  getBankAdapter,
  getCardAdapter,
};