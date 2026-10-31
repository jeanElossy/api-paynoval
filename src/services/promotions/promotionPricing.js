"use strict";

const { roundMoney } = require("../../utils/money");
const { buildTreasuryRevenueBreakdown } = require("../pricingSnapshotNormalizer");

/**
 * A promotion reduces OUR fee, nothing else. The sender pays less and the
 * recipient receives exactly what the quote promised (Wise's fee discounts).
 *
 *   before : gross = net + fee
 *   after  : gross - discount = net + (fee - discount)
 *
 * ⚠️ The treasury is credited from `pricingSnapshot`, not from the transaction
 * fields. The snapshot must carry the reduced fee, or the treasury would record
 * money nobody paid and the ledger would stop balancing.
 */

function computeDiscount({ fee, percent, cap, currency }) {
  const value = Number(fee);
  const rate = Number(percent);
  const ceiling = Number(cap);

  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) return 0;
  // No ceiling for this currency: the code does not apply. Never unlimited.
  if (!Number.isFinite(ceiling) || ceiling <= 0) return 0;

  return roundMoney(Math.min((value * rate) / 100, ceiling, value), currency);
}

/** Returns a new pricing bundle with the discount applied. Pure. */
function applyDiscountToBundle(bundle, discount, currency) {
  const { pricingSnapshot, grossFrom, fee, netFrom, netTo } = bundle;

  const newFee = roundMoney(fee - discount, currency);
  const newGross = roundMoney(grossFrom - discount, currency);

  // Fail closed: an unbalanced result is a refused transfer, never a guess.
  if (newFee < 0 || Math.abs(newGross - netFrom - newFee) > 0.011) {
    const err = new Error("Réduction incohérente : transfert refusé.");
    err.status = 500;
    err.code = "PROMO_UNBALANCED";
    throw err;
  }

  const result = pricingSnapshot?.result || {};
  const feeRevenue = result.feeRevenue || null;
  const scale = fee > 0 ? newFee / fee : 0;

  const nextSnapshot = {
    ...pricingSnapshot,
    result: {
      ...result,
      fee: newFee,
      grossFrom: newGross,
      ...(result.amount !== undefined ? { amount: newGross } : {}),
      feeBeforePromotion: fee,
      promotionDiscount: discount,
      ...(feeRevenue
        ? {
            feeRevenue: {
              ...feeRevenue,
              amount: newFee,
              amountInTreasuryCurrency: Number(feeRevenue.amountInTreasuryCurrency || 0) * scale,
            },
          }
        : {}),
    },
  };

  return {
    ...bundle,
    pricingSnapshot: nextSnapshot,
    grossFrom: newGross,
    fee: newFee,
    netFrom,
    netTo,
    treasuryRevenue: buildTreasuryRevenueBreakdown(nextSnapshot),
  };
}

module.exports = { applyDiscountToBundle, computeDiscount };
