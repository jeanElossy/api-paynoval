// "use strict";

// function toNum(v, fallback = 0) {
//   const n = Number(v);
//   return Number.isFinite(n) ? n : fallback;
// }

// function upper(v) {
//   return String(v || "").trim().toUpperCase();
// }

// function roundMoney(amount, currency) {
//   const c = upper(currency);
//   const decimals = ["XOF", "XAF", "JPY"].includes(c) ? 0 : 2;
//   const p = 10 ** decimals;
//   return Math.round((Number(amount || 0) + Number.EPSILON) * p) / p;
// }

// function normalizePricingSnapshot(pricingSnapshot = {}) {
//   const request = pricingSnapshot?.request || {};
//   const result = pricingSnapshot?.result || {};

//   const fromCurrency = upper(request.fromCurrency);
//   const toCurrency = upper(request.toCurrency);

//   const grossFrom = roundMoney(toNum(result.grossFrom, 0), fromCurrency);
//   const fee = roundMoney(toNum(result.fee, 0), fromCurrency);
//   const netFrom = roundMoney(toNum(result.netFrom, 0), fromCurrency);
//   const netTo = roundMoney(toNum(result.netTo, 0), toCurrency);

//   const marketRate = result.marketRate != null ? Number(result.marketRate) : null;
//   const appliedRate = result.appliedRate != null ? Number(result.appliedRate) : null;

//   const feeRevenue = {
//     sourceCurrency: upper(result?.feeRevenue?.sourceCurrency || fromCurrency),
//     amount: roundMoney(toNum(result?.feeRevenue?.amount, fee), fromCurrency),
//     adminCurrency: upper(result?.feeRevenue?.adminCurrency || "CAD"),
//     amountCAD: roundMoney(toNum(result?.feeRevenue?.amountCAD, 0), "CAD"),
//     conversionRateToCAD: toNum(result?.feeRevenue?.conversionRateToCAD, 0),
//     calculatedAt: result?.feeRevenue?.calculatedAt || new Date().toISOString(),
//   };

//   const fxRevenue = {
//     toCurrency: upper(result?.fxRevenue?.toCurrency || toCurrency),
//     amount: roundMoney(toNum(result?.fxRevenue?.amount, 0), toCurrency),
//     rawAmount: toNum(result?.fxRevenue?.rawAmount, 0),
//     idealNetTo: roundMoney(toNum(result?.fxRevenue?.idealNetTo, 0), toCurrency),
//     actualNetTo: roundMoney(toNum(result?.fxRevenue?.actualNetTo, 0), toCurrency),
//     adminCurrency: upper(result?.fxRevenue?.adminCurrency || "CAD"),
//     amountCAD: roundMoney(toNum(result?.fxRevenue?.amountCAD, 0), "CAD"),
//     conversionRateToCAD: toNum(result?.fxRevenue?.conversionRateToCAD, 0),
//     calculatedAt: result?.fxRevenue?.calculatedAt || new Date().toISOString(),
//   };

//   return {
//     request: {
//       ...request,
//       fromCurrency,
//       toCurrency,
//     },
//     result: {
//       ...result,
//       grossFrom,
//       fee,
//       netFrom,
//       netTo,
//       marketRate,
//       appliedRate,
//       feeRevenue,
//       fxRevenue,
//     },
//     ruleApplied: pricingSnapshot?.ruleApplied || null,
//     fxRuleApplied: pricingSnapshot?.fxRuleApplied || null,
//     debug: pricingSnapshot?.debug || null,
//   };
// }

// function buildAdminRevenueBreakdown(pricingSnapshot = {}) {
//   const snap = normalizePricingSnapshot(pricingSnapshot);

//   const feeCAD = roundMoney(snap?.result?.feeRevenue?.amountCAD || 0, "CAD");
//   const fxCAD = roundMoney(snap?.result?.fxRevenue?.amountCAD || 0, "CAD");

//   return {
//     feeSource: roundMoney(snap?.result?.fee || 0, snap?.request?.fromCurrency),
//     feeSourceCurrency: snap?.request?.fromCurrency || null,
//     feeCAD,

//     fxToAmount: roundMoney(
//       snap?.result?.fxRevenue?.amount || 0,
//       snap?.result?.fxRevenue?.toCurrency || snap?.request?.toCurrency
//     ),
//     fxToCurrency:
//       snap?.result?.fxRevenue?.toCurrency || snap?.request?.toCurrency || null,
//     fxCAD,

//     totalCAD: roundMoney(feeCAD + fxCAD, "CAD"),
//     marketRate: snap?.result?.marketRate ?? null,
//     appliedRate: snap?.result?.appliedRate ?? null,
//     feeConversionRateToCAD: snap?.result?.feeRevenue?.conversionRateToCAD || 0,
//     fxConversionRateToCAD: snap?.result?.fxRevenue?.conversionRateToCAD || 0,
//     adminCurrency: "CAD",
//   };
// }

// module.exports = {
//   normalizePricingSnapshot,
//   buildAdminRevenueBreakdown,
//   roundMoney,
// };









"use strict";

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function upper(v) {
  return String(v || "").trim().toUpperCase();
}

function roundMoney(amount, currency) {
  const c = upper(currency);
  const decimals = ["XOF", "XAF", "JPY"].includes(c) ? 0 : 2;
  const p = 10 ** decimals;
  return Math.round((Number(amount || 0) + Number.EPSILON) * p) / p;
}

function normalizePricingSnapshot(pricingSnapshot = {}) {
  const request = pricingSnapshot?.request || {};
  const result = pricingSnapshot?.result || {};

  const fromCurrency = upper(request.fromCurrency);
  const toCurrency = upper(request.toCurrency);

  const grossFrom = roundMoney(toNum(result.grossFrom, 0), fromCurrency);
  const fee = roundMoney(toNum(result.fee, 0), fromCurrency);
  const netFrom = roundMoney(toNum(result.netFrom, 0), fromCurrency);
  const netTo = roundMoney(toNum(result.netTo, 0), toCurrency);

  const marketRate =
    result.marketRate != null ? Number(result.marketRate) : null;
  const appliedRate =
    result.appliedRate != null ? Number(result.appliedRate) : null;

  const feeRevenueTreasuryCurrency = upper(
    result?.feeRevenue?.treasuryCurrency || "CAD"
  );

  const fxRevenueTreasuryCurrency = upper(
    result?.fxRevenue?.treasuryCurrency || "CAD"
  );

  const feeRevenue = {
    systemType: "FEES_TREASURY",
    sourceCurrency: upper(result?.feeRevenue?.sourceCurrency || fromCurrency),
    amount: roundMoney(
      toNum(result?.feeRevenue?.amount, fee),
      upper(result?.feeRevenue?.sourceCurrency || fromCurrency)
    ),
    treasuryCurrency: feeRevenueTreasuryCurrency,
    amountInTreasuryCurrency: roundMoney(
      toNum(
        result?.feeRevenue?.amountInTreasuryCurrency,
        result?.feeRevenue?.amountCAD
      ),
      feeRevenueTreasuryCurrency
    ),
    conversionRateToTreasury: toNum(
      result?.feeRevenue?.conversionRateToTreasury,
      result?.feeRevenue?.conversionRateToCAD
    ),
    calculatedAt:
      result?.feeRevenue?.calculatedAt || new Date().toISOString(),
  };

  const fxRevenue = {
    systemType: "FX_MARGIN_TREASURY",
    toCurrency: upper(result?.fxRevenue?.toCurrency || toCurrency),
    amount: roundMoney(
      toNum(result?.fxRevenue?.amount, 0),
      upper(result?.fxRevenue?.toCurrency || toCurrency)
    ),
    rawAmount: toNum(result?.fxRevenue?.rawAmount, 0),
    idealNetTo: roundMoney(
      toNum(result?.fxRevenue?.idealNetTo, 0),
      upper(result?.fxRevenue?.toCurrency || toCurrency)
    ),
    actualNetTo: roundMoney(
      toNum(result?.fxRevenue?.actualNetTo, 0),
      upper(result?.fxRevenue?.toCurrency || toCurrency)
    ),
    treasuryCurrency: fxRevenueTreasuryCurrency,
    amountInTreasuryCurrency: roundMoney(
      toNum(
        result?.fxRevenue?.amountInTreasuryCurrency,
        result?.fxRevenue?.amountCAD
      ),
      fxRevenueTreasuryCurrency
    ),
    conversionRateToTreasury: toNum(
      result?.fxRevenue?.conversionRateToTreasury,
      result?.fxRevenue?.conversionRateToCAD
    ),
    calculatedAt:
      result?.fxRevenue?.calculatedAt || new Date().toISOString(),
  };

  return {
    request: {
      ...request,
      fromCurrency,
      toCurrency,
    },
    result: {
      ...result,
      grossFrom,
      fee,
      netFrom,
      netTo,
      marketRate,
      appliedRate,
      feeRevenue,
      fxRevenue,
    },
    ruleApplied: pricingSnapshot?.ruleApplied || null,
    fxRuleApplied: pricingSnapshot?.fxRuleApplied || null,
    debug: pricingSnapshot?.debug || null,
  };
}

function buildTreasuryRevenueBreakdown(pricingSnapshot = {}) {
  const snap = normalizePricingSnapshot(pricingSnapshot);

  const feeRevenue = {
    systemType: "FEES_TREASURY",
    sourceAmount: roundMoney(
      snap?.result?.feeRevenue?.amount || snap?.result?.fee || 0,
      snap?.result?.feeRevenue?.sourceCurrency || snap?.request?.fromCurrency
    ),
    sourceCurrency:
      snap?.result?.feeRevenue?.sourceCurrency || snap?.request?.fromCurrency || null,
    treasuryAmount: roundMoney(
      snap?.result?.feeRevenue?.amountInTreasuryCurrency || 0,
      snap?.result?.feeRevenue?.treasuryCurrency || "CAD"
    ),
    treasuryCurrency:
      snap?.result?.feeRevenue?.treasuryCurrency || "CAD",
    conversionRateToTreasury:
      snap?.result?.feeRevenue?.conversionRateToTreasury || 0,
  };

  const fxRevenue = {
    systemType: "FX_MARGIN_TREASURY",
    sourceAmount: roundMoney(
      snap?.result?.fxRevenue?.amount || 0,
      snap?.result?.fxRevenue?.toCurrency || snap?.request?.toCurrency
    ),
    sourceCurrency:
      snap?.result?.fxRevenue?.toCurrency || snap?.request?.toCurrency || null,
    treasuryAmount: roundMoney(
      snap?.result?.fxRevenue?.amountInTreasuryCurrency || 0,
      snap?.result?.fxRevenue?.treasuryCurrency || "CAD"
    ),
    treasuryCurrency:
      snap?.result?.fxRevenue?.treasuryCurrency || "CAD",
    conversionRateToTreasury:
      snap?.result?.fxRevenue?.conversionRateToTreasury || 0,
    idealNetTo: roundMoney(
      snap?.result?.fxRevenue?.idealNetTo || 0,
      snap?.result?.fxRevenue?.toCurrency || snap?.request?.toCurrency
    ),
    actualNetTo: roundMoney(
      snap?.result?.fxRevenue?.actualNetTo || 0,
      snap?.result?.fxRevenue?.toCurrency || snap?.request?.toCurrency
    ),
    rawAmount: toNum(snap?.result?.fxRevenue?.rawAmount, 0),
  };

  return {
    feeRevenue,
    fxRevenue,
    totals: {
      feeTreasuryAmount: feeRevenue.treasuryAmount,
      feeTreasuryCurrency: feeRevenue.treasuryCurrency,
      fxTreasuryAmount: fxRevenue.treasuryAmount,
      fxTreasuryCurrency: fxRevenue.treasuryCurrency,
    },
    marketRate: snap?.result?.marketRate ?? null,
    appliedRate: snap?.result?.appliedRate ?? null,
  };
}

module.exports = {
  normalizePricingSnapshot,
  buildTreasuryRevenueBreakdown,
  roundMoney,
};