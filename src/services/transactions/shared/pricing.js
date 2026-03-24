// "use strict";

// const axios = require("axios");
// const createError = require("http-errors");

// const {
//   logger,
//   INTERNAL_TOKEN,
//   GATEWAY_URL,
//   normalizePricingSnapshot,
//   buildAdminRevenueBreakdown,
// } = require("./runtime");

// const {
//   toFloat,
//   round2,
//   roundMoney,
//   getGatewayBase,
//   normalizeTxTypeValue,
//   inferMethodValue,
//   pickCurrency,
// } = require("./helpers");

// function pickBodyPricingInput(reqBody = {}) {
//   const amount = toFloat(reqBody.amount ?? reqBody.amountSource, 0);

//   const fromCurrency = pickCurrency(
//     reqBody.senderCurrencyCode,
//     reqBody.currencySource,
//     reqBody.currencyCode,
//     reqBody.fromCurrency,
//     reqBody.senderCurrencySymbol,
//     reqBody.currency
//   );

//   const toCurrency =
//     pickCurrency(
//       reqBody.localCurrencyCode,
//       reqBody.currencyTarget,
//       reqBody.toCurrency,
//       reqBody.localCurrencySymbol,
//       reqBody.receiverCurrency,
//       reqBody.destinationCurrency
//     ) || fromCurrency;

//   const txTypeRaw =
//     reqBody.txType ||
//     (String(reqBody.action || "").toLowerCase() === "deposit"
//       ? "DEPOSIT"
//       : String(reqBody.action || "").toLowerCase() === "withdraw"
//       ? "WITHDRAW"
//       : "TRANSFER");

//   return {
//     txType: normalizeTxTypeValue(txTypeRaw),
//     method: inferMethodValue(reqBody),
//     amount,
//     fromCurrency,
//     toCurrency,
//     country: reqBody.country || null,
//     fromCountry: reqBody.fromCountry || reqBody.country || null,
//     toCountry: reqBody.toCountry || reqBody.destinationCountry || reqBody.country || null,
//     provider: String(reqBody.provider || "paynoval").toLowerCase(),
//     operator: reqBody.operator || null,
//   };
// }

// async function fetchPricingQuoteFromGateway({ authHeader, pricingInput }) {
//   const gatewayBase = getGatewayBase(GATEWAY_URL);
//   const url = `${gatewayBase}/pricing/quote`;

//   const headers = {
//     "Content-Type": "application/json",
//     ...(authHeader ? { Authorization: authHeader } : {}),
//     ...(INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : {}),
//   };

//   logger?.info?.("[TX-CORE][PRICING_CALL]", {
//     url,
//     hasAuthHeader: !!authHeader,
//     hasInternalToken: !!INTERNAL_TOKEN,
//     pricingInput,
//   });

//   try {
//     const response = await axios.post(url, pricingInput, {
//       headers,
//       timeout: 12000,
//     });

//     const payload = response?.data || {};
//     if (payload.ok === false || payload.success === false) {
//       throw createError(502, payload.error || payload.message || "Erreur pricing gateway");
//     }

//     return payload;
//   } catch (err) {
//     const status = err?.response?.status;
//     const payloadMessage =
//       err?.response?.data?.error ||
//       err?.response?.data?.message ||
//       err?.message ||
//       "Erreur pricing gateway";

//     logger?.error?.("[TX-CORE][PRICING_CALL][ERROR]", {
//       status: status || 502,
//       message: payloadMessage,
//       responseData: err?.response?.data || null,
//     });

//     throw createError(
//       status && status >= 400 && status < 600 ? status : 502,
//       payloadMessage
//     );
//   }
// }

// function extractPricingBundle(pricingPayload, pricingInput = {}) {
//   const pricingSnapshot = normalizePricingSnapshot({
//     request: pricingPayload?.request || pricingInput || {},
//     result: pricingPayload?.result || {},
//     ruleApplied: pricingPayload?.ruleApplied || null,
//     fxRuleApplied: pricingPayload?.fxRuleApplied || null,
//     debug: pricingPayload?.debug || null,
//   });

//   const fromCurrency = pickCurrency(
//     pricingSnapshot?.request?.fromCurrency,
//     pricingSnapshot?.request?.currency,
//     pricingInput?.fromCurrency,
//     pricingInput?.currency,
//     "CAD"
//   );

//   const toCurrency = pickCurrency(
//     pricingSnapshot?.request?.toCurrency,
//     pricingInput?.toCurrency,
//     fromCurrency
//   );

//   const fee = roundMoney(toFloat(pricingSnapshot?.result?.fee, 0), fromCurrency);
//   const grossFrom = roundMoney(
//     toFloat(pricingSnapshot?.result?.grossFrom, pricingInput?.amount || 0),
//     fromCurrency
//   );
//   const netFrom = roundMoney(
//     toFloat(pricingSnapshot?.result?.netFrom, grossFrom - fee),
//     fromCurrency
//   );

//   const rawNetTo = toFloat(pricingSnapshot?.result?.netTo, NaN);
//   const netTo = Number.isFinite(rawNetTo) ? roundMoney(rawNetTo, toCurrency) : 0;

//   const appliedRate = round2(toFloat(pricingSnapshot?.result?.appliedRate, 0));
//   const marketRate = round2(toFloat(pricingSnapshot?.result?.marketRate, 0));

//   const adminRevenue = buildAdminRevenueBreakdown(pricingSnapshot);

//   return {
//     pricingSnapshot,
//     grossFrom,
//     fee,
//     netFrom,
//     netTo,
//     appliedRate,
//     marketRate,
//     adminRevenue,
//   };
// }

// module.exports = {
//   pickBodyPricingInput,
//   fetchPricingQuoteFromGateway,
//   extractPricingBundle,
// };









"use strict";

const axios = require("axios");
const createError = require("http-errors");

const runtime = require("./runtime");

const logger = runtime.logger;
const INTERNAL_TOKEN = runtime.INTERNAL_TOKEN;
const GATEWAY_URL = runtime.GATEWAY_URL;
const normalizePricingSnapshot = runtime.normalizePricingSnapshot;
const buildTreasuryRevenueBreakdown = runtime.buildTreasuryRevenueBreakdown;

if (typeof buildTreasuryRevenueBreakdown !== "function") {
  throw new Error(
    "Aucun helper de breakdown treasury disponible dans runtime"
  );
}

const {
  toFloat,
  round2,
  roundMoney,
  getGatewayBase,
  normalizeTxTypeValue,
  inferMethodValue,
  pickCurrency,
} = require("./helpers");

function pickBodyPricingInput(reqBody = {}) {
  const amount = toFloat(reqBody.amount ?? reqBody.amountSource, 0);

  const fromCurrency = pickCurrency(
    reqBody.senderCurrencyCode,
    reqBody.currencySource,
    reqBody.currencyCode,
    reqBody.fromCurrency,
    reqBody.senderCurrencySymbol,
    reqBody.currency
  );

  const toCurrency =
    pickCurrency(
      reqBody.localCurrencyCode,
      reqBody.currencyTarget,
      reqBody.toCurrency,
      reqBody.localCurrencySymbol,
      reqBody.receiverCurrency,
      reqBody.destinationCurrency
    ) || fromCurrency;

  const txTypeRaw =
    reqBody.txType ||
    (String(reqBody.action || "").toLowerCase() === "deposit"
      ? "DEPOSIT"
      : String(reqBody.action || "").toLowerCase() === "withdraw"
      ? "WITHDRAW"
      : "TRANSFER");

  return {
    txType: normalizeTxTypeValue(txTypeRaw),
    method: inferMethodValue(reqBody),
    amount,
    fromCurrency,
    toCurrency,
    country: reqBody.country || null,
    fromCountry: reqBody.fromCountry || reqBody.country || null,
    toCountry:
      reqBody.toCountry ||
      reqBody.destinationCountry ||
      reqBody.country ||
      null,
    provider: String(reqBody.provider || "paynoval").toLowerCase(),
    operator: reqBody.operator || null,
  };
}

async function fetchPricingQuoteFromGateway({ authHeader, pricingInput }) {
  const gatewayBase = getGatewayBase(GATEWAY_URL);
  const url = `${gatewayBase}/pricing/quote`;

  const headers = {
    "Content-Type": "application/json",
    ...(authHeader ? { Authorization: authHeader } : {}),
    ...(INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : {}),
  };

  logger?.info?.("[TX-CORE][PRICING_CALL]", {
    url,
    hasAuthHeader: !!authHeader,
    hasInternalToken: !!INTERNAL_TOKEN,
    pricingInput,
  });

  try {
    const response = await axios.post(url, pricingInput, {
      headers,
      timeout: 12000,
    });

    const payload = response?.data || {};
    if (payload.ok === false || payload.success === false) {
      throw createError(
        502,
        payload.error || payload.message || "Erreur pricing gateway"
      );
    }

    return payload;
  } catch (err) {
    const status = err?.response?.status;
    const payloadMessage =
      err?.response?.data?.error ||
      err?.response?.data?.message ||
      err?.message ||
      "Erreur pricing gateway";

    logger?.error?.("[TX-CORE][PRICING_CALL][ERROR]", {
      status: status || 502,
      message: payloadMessage,
      responseData: err?.response?.data || null,
    });

    throw createError(
      status && status >= 400 && status < 600 ? status : 502,
      payloadMessage
    );
  }
}

function extractPricingBundle(pricingPayload, pricingInput = {}) {
  const pricingSnapshot = normalizePricingSnapshot({
    request: pricingPayload?.request || pricingInput || {},
    result: pricingPayload?.result || {},
    ruleApplied: pricingPayload?.ruleApplied || null,
    fxRuleApplied: pricingPayload?.fxRuleApplied || null,
    debug: pricingPayload?.debug || null,
  });

  const fromCurrency = pickCurrency(
    pricingSnapshot?.request?.fromCurrency,
    pricingSnapshot?.request?.currency,
    pricingInput?.fromCurrency,
    pricingInput?.currency,
    "CAD"
  );

  const toCurrency = pickCurrency(
    pricingSnapshot?.request?.toCurrency,
    pricingInput?.toCurrency,
    fromCurrency
  );

  const fee = roundMoney(
    toFloat(pricingSnapshot?.result?.fee, 0),
    fromCurrency
  );

  const grossFrom = roundMoney(
    toFloat(pricingSnapshot?.result?.grossFrom, pricingInput?.amount || 0),
    fromCurrency
  );

  const netFrom = roundMoney(
    toFloat(pricingSnapshot?.result?.netFrom, grossFrom - fee),
    fromCurrency
  );

  const rawNetTo = toFloat(pricingSnapshot?.result?.netTo, NaN);
  const netTo = Number.isFinite(rawNetTo)
    ? roundMoney(rawNetTo, toCurrency)
    : 0;

  const appliedRate = round2(toFloat(pricingSnapshot?.result?.appliedRate, 0));
  const marketRate = round2(toFloat(pricingSnapshot?.result?.marketRate, 0));

  const treasuryRevenue = buildTreasuryRevenueBreakdown(pricingSnapshot);

  return {
    pricingSnapshot,
    grossFrom,
    fee,
    netFrom,
    netTo,
    appliedRate,
    marketRate,
    treasuryRevenue,
  };
}

module.exports = {
  pickBodyPricingInput,
  fetchPricingQuoteFromGateway,
  extractPricingBundle,
};