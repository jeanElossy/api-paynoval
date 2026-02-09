// File: services/feeEngine.js
"use strict";

/**
 * Fee Engine (TX Core) — Source of truth
 * - Calcule fees/netAfterFees
 * - Retourne un snapshot stable à stocker dans Transaction.feeSnapshot
 *
 * ⚙️ Config via ENV (valeurs par défaut safe):
 *  - FEE_FIXED_DEFAULT=0
 *  - FEE_PERCENT_DEFAULT=0.02   (2%)
 *  - FEE_MIN_DEFAULT=0
 *  - FEE_MAX_DEFAULT=0          (0 => pas de max)
 *
 *  - Tu peux définir par provider/action:
 *    FEE_PAYNOVAL_SEND_PERCENT=0.015
 *    FEE_PAYNOVAL_SEND_FIXED=0.25
 */

const config = require("../config");

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
function round2(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}
function clamp(x, min, max) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  if (Number.isFinite(min)) x = Math.max(v, min);
  else x = v;
  if (Number.isFinite(max) && max > 0) x = Math.min(x, max);
  return x;
}

function envKey(provider, action, suffix) {
  const p = String(provider || "default").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const a = String(action || "generic").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return `FEE_${p}_${a}_${suffix}`;
}

function getRule({ provider, action }) {
  const fixed =
    n(process.env[envKey(provider, action, "FIXED")], NaN) ??
    n(process.env.FEE_FIXED_DEFAULT, 0);

  const percent =
    n(process.env[envKey(provider, action, "PERCENT")], NaN) ??
    n(process.env.FEE_PERCENT_DEFAULT, 0.02);

  const minFee =
    n(process.env[envKey(provider, action, "MIN")], NaN) ??
    n(process.env.FEE_MIN_DEFAULT, 0);

  const maxFee =
    n(process.env[envKey(provider, action, "MAX")], NaN) ??
    n(process.env.FEE_MAX_DEFAULT, 0);

  return {
    fixed: Number.isFinite(fixed) ? fixed : n(process.env.FEE_FIXED_DEFAULT, 0),
    percent: Number.isFinite(percent) ? percent : n(process.env.FEE_PERCENT_DEFAULT, 0.02),
    minFee: Number.isFinite(minFee) ? minFee : n(process.env.FEE_MIN_DEFAULT, 0),
    maxFee: Number.isFinite(maxFee) ? maxFee : n(process.env.FEE_MAX_DEFAULT, 0),
  };
}

/**
 * computeQuote()
 * @returns { feeId, fees, netAfterFees, breakdown, ts, version }
 */
async function computeQuote({
  provider = "paynoval",
  action = "send",
  amount,
  currencySource,
  currencyTarget,
  country,
  userId,
  kycLevel = "L0",
  metadata = {},
} = {}) {
  const amt = n(amount, 0);
  if (!Number.isFinite(amt) || amt <= 0) {
    const e = new Error("amount invalide (feeEngine)");
    e.status = 400;
    throw e;
  }

  const rule = getRule({ provider, action });

  // fee brut = fixed + percent*amount
  const feePercentPart = round2(amt * rule.percent);
  const feeFixedPart = round2(rule.fixed);

  let fee = round2(feePercentPart + feeFixedPart);

  // clamp min/max
  fee = clamp(fee, rule.minFee, rule.maxFee);

  // net after fees
  const net = round2(Math.max(0, amt - fee));

  // feeId stable (versioning simple)
  const version = config?.pricingVersion || process.env.PRICING_VERSION || "v1";
  const feeId = `fee:${version}:${String(provider)}:${String(action)}`;

  return {
    success: true,
    feeId,
    provider,
    action,
    amountSource: round2(amt),
    currencySource: String(currencySource || "").trim().toUpperCase() || null,
    currencyTarget: String(currencyTarget || "").trim().toUpperCase() || null,
    country: country || null,
    userId: userId || null,
    kycLevel: kycLevel || "L0",

    fees: round2(fee),
    netAfterFees: round2(net),

    breakdown: {
      fixed: feeFixedPart,
      percent: rule.percent,
      percentAmount: feePercentPart,
      minFee: rule.minFee,
      maxFee: rule.maxFee,
    },

    // si tu veux ajouter promos plus tard:
    discounts: metadata?.discounts || null,

    ts: new Date().toISOString(),
    version,
  };
}

module.exports = {
  computeQuote,
};
