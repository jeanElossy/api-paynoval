"use strict";

const { isSandboxUser } = require("./sandboxUser");

const REAL_PROVIDERS = new Set([
  "orange",
  "orange_money",
  "orangemoney",
  "wave",
  "mtn",
  "mtn_money",
  "moov",
  "moov_money",
  "mobilemoney",
  "stripe",
  "visa_direct",
  "visadirect",
  "bank",
  "bank_transfer",
  "flutterwave",
  "card",
]);

function normalizeProvider(provider) {
  return String(provider || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function isRealProvider(provider) {
  return REAL_PROVIDERS.has(normalizeProvider(provider));
}

function assertProviderAllowedForUser(user, provider) {
  const normalizedProvider = normalizeProvider(provider);

  if (isSandboxUser(user) && isRealProvider(normalizedProvider)) {
    const error = new Error(
      `Compte sandbox : appel provider réel interdit (${normalizedProvider}).`
    );

    error.status = 403;
    error.statusCode = 403;
    error.code = "SANDBOX_REAL_PROVIDER_FORBIDDEN";
    error.provider = normalizedProvider;

    throw error;
  }

  return true;
}

module.exports = {
  REAL_PROVIDERS,
  normalizeProvider,
  isRealProvider,
  assertProviderAllowedForUser,
};