// "use strict";

// const { Transaction } = require("./transactions/shared/runtime");
// const { toFloat } = require("./transactions/shared/helpers");

// const INTERNAL_FLOW = "PAYNOVAL_INTERNAL_TRANSFER";
// const OUTBOUND_EXTERNAL_FLOWS = new Set([
//   "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
//   "PAYNOVAL_TO_BANK_PAYOUT",
//   "PAYNOVAL_TO_CARD_PAYOUT",
// ]);
// const INBOUND_EXTERNAL_FLOWS = new Set([
//   "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
//   "BANK_TRANSFER_TO_PAYNOVAL",
//   "CARD_TOPUP_TO_PAYNOVAL",
// ]);

// const BONUS_COUNTABLE_FLOWS = new Set([
//   INTERNAL_FLOW,
//   ...OUTBOUND_EXTERNAL_FLOWS,
//   ...INBOUND_EXTERNAL_FLOWS,
// ]);

// function normalizeBaseUrl(value) {
//   return String(value || "").trim().replace(/\/+$/, "");
// }

// function getPrincipalReferralBaseUrl() {
//   return normalizeBaseUrl(
//     process.env.BACKEND_PRINCIPAL_URL ||
//       process.env.PRINCIPAL_BACKEND_URL ||
//       process.env.PRINCIPAL_URL ||
//       process.env.PRINCIPAL_BASE_URL ||
//       process.env.BACKEND_URL ||
//       ""
//   );
// }

// function getPrincipalInternalToken() {
//   return (
//     process.env.INTERNAL_REFERRAL_TOKEN ||
//     process.env.PRINCIPAL_INTERNAL_TOKEN ||
//     process.env.INTERNAL_TOKEN ||
//     ""
//   );
// }

// async function postJsonWithTimeout(url, payload, headers = {}, timeoutMs = 10000) {
//   const controller = new AbortController();
//   const timer = setTimeout(() => controller.abort(), timeoutMs);

//   try {
//     const res = await fetch(url, {
//       method: "POST",
//       headers: {
//         "content-type": "application/json",
//         ...headers,
//       },
//       body: JSON.stringify(payload || {}),
//       signal: controller.signal,
//     });

//     const text = await res.text();
//     let json = null;

//     try {
//       json = text ? JSON.parse(text) : null;
//     } catch {
//       json = { raw: text };
//     }

//     return {
//       ok: res.ok,
//       status: res.status,
//       data: json,
//     };
//   } finally {
//     clearTimeout(timer);
//   }
// }

// function getReferralActorUserId(tx) {
//   const candidate = tx?.userId || tx?.sender || null;
//   return candidate ? String(candidate) : null;
// }

// async function getConfirmedReferralStats({ actorUserId, currency }) {
//   if (!actorUserId) {
//     return {
//       confirmedCount: 0,
//       confirmedTotal: 0,
//       currency: String(currency || "").trim().toUpperCase() || "XOF",
//     };
//   }

//   const normalizedCurrency =
//     String(currency || "").trim().toUpperCase() || "XOF";

//   const rows = await Transaction.aggregate([
//     {
//       $match: {
//         status: "confirmed",
//         flow: { $in: Array.from(BONUS_COUNTABLE_FLOWS) },
//         $or: [
//           { userId: actorUserId },
//           { sender: actorUserId },
//         ],
//       },
//     },
//     {
//       $group: {
//         _id: null,
//         confirmedCount: { $sum: 1 },
//         confirmedTotal: { $sum: { $ifNull: ["$amount", 0] } },
//       },
//     },
//   ]);

//   const row = rows?.[0] || {};

//   return {
//     confirmedCount: Number(row.confirmedCount || 0),
//     confirmedTotal: Number(row.confirmedTotal || 0),
//     currency: normalizedCurrency,
//   };
// }

// async function syncReferralAfterConfirmedTx(tx) {
//   const baseUrl = getPrincipalReferralBaseUrl();
//   const internalToken = getPrincipalInternalToken();

//   if (!baseUrl) {
//     return {
//       ok: false,
//       skipped: true,
//       reason: "PRINCIPAL_BASE_URL_MISSING",
//     };
//   }

//   if (!internalToken) {
//     return {
//       ok: false,
//       skipped: true,
//       reason: "PRINCIPAL_INTERNAL_TOKEN_MISSING",
//     };
//   }

//   const actorUserId = getReferralActorUserId(tx);
//   if (!actorUserId) {
//     return {
//       ok: false,
//       skipped: true,
//       reason: "REFERRAL_ACTOR_USER_MISSING",
//     };
//   }

//   const triggerTxId = String(tx?._id || "");
//   const txReference = String(tx?.reference || "");
//   const sourceCurrency =
//     String(
//       tx?.senderCurrencySymbol ||
//         tx?.currency ||
//         tx?.localCurrencySymbol ||
//         ""
//     )
//       .trim()
//       .toUpperCase() || "XOF";

//   const headers = {
//     "x-internal-token": internalToken,
//   };

//   const confirmPayload = {
//     userId: actorUserId,
//     transaction: {
//       id: triggerTxId,
//       reference: txReference,
//       status: String(tx?.status || "confirmed"),
//       amount: Number(toFloat(tx?.amount)),
//       currency: sourceCurrency,
//       flow: String(tx?.flow || ""),
//       confirmedAt: tx?.confirmedAt || new Date(),
//     },
//   };

//   const confirmResp = await postJsonWithTimeout(
//     `${baseUrl}/internal/referral/on-transaction-confirm`,
//     confirmPayload,
//     headers,
//     10000
//   );

//   const stats = await getConfirmedReferralStats({
//     actorUserId,
//     currency: sourceCurrency,
//   });

//   const awardPayload = {
//     refereeId: actorUserId,
//     triggerTxId,
//     stats,
//   };

//   const awardResp = await postJsonWithTimeout(
//     `${baseUrl}/internal/referral/award-bonus`,
//     awardPayload,
//     headers,
//     10000
//   );

//   return {
//     ok: confirmResp.ok && awardResp.ok,
//     actorUserId,
//     stats,
//     confirmCall: {
//       ok: confirmResp.ok,
//       status: confirmResp.status,
//       data: confirmResp.data,
//     },
//     awardCall: {
//       ok: awardResp.ok,
//       status: awardResp.status,
//       data: awardResp.data,
//     },
//   };
// }

// module.exports = {
//   syncReferralAfterConfirmedTx,
// };








"use strict";

const { Transaction } = require("./transactions/shared/runtime");
const { toFloat } = require("./transactions/shared/helpers");

const INTERNAL_FLOW = "PAYNOVAL_INTERNAL_TRANSFER";
const OUTBOUND_EXTERNAL_FLOWS = new Set([
  "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  "PAYNOVAL_TO_BANK_PAYOUT",
  "PAYNOVAL_TO_CARD_PAYOUT",
]);
const INBOUND_EXTERNAL_FLOWS = new Set([
  "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
  "BANK_TRANSFER_TO_PAYNOVAL",
  "CARD_TOPUP_TO_PAYNOVAL",
]);

const BONUS_COUNTABLE_FLOWS = new Set([
  INTERNAL_FLOW,
  ...OUTBOUND_EXTERNAL_FLOWS,
  ...INBOUND_EXTERNAL_FLOWS,
]);

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeCurrency(value, fallback = "XOF") {
  const code = String(value || fallback).trim().toUpperCase();
  return code || fallback;
}

function safeNumber(value) {
  const n =
    typeof value === "number"
      ? value
      : parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function logReferral(label, payload) {
  try {
    console.log(`[REFERRAL][TX-CORE] ${label} =`, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.log(`[REFERRAL][TX-CORE] ${label} =`, payload);
  }
}

function getPrincipalReferralBaseUrl() {
  return normalizeBaseUrl(
    process.env.BACKEND_PRINCIPAL_URL ||
      process.env.PRINCIPAL_BACKEND_URL ||
      process.env.PRINCIPAL_URL ||
      process.env.PRINCIPAL_BASE_URL ||
      process.env.BACKEND_URL ||
      ""
  );
}

function getPrincipalInternalToken() {
  return (
    process.env.INTERNAL_REFERRAL_TOKEN ||
    process.env.PRINCIPAL_INTERNAL_TOKEN ||
    process.env.INTERNAL_TOKEN ||
    ""
  );
}

async function postJsonWithTimeout(url, payload, headers = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    logReferral("HTTP_POST.url", url);
    logReferral("HTTP_POST.payload", payload);
    logReferral("HTTP_POST.headers", {
      ...headers,
      "x-internal-token": headers?.["x-internal-token"] ? "***masked***" : undefined,
    });
    logReferral("HTTP_POST.timeoutMs", timeoutMs);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });

    const text = await res.text();
    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    const responsePayload = {
      ok: res.ok,
      status: res.status,
      data: json,
    };

    logReferral("HTTP_POST.response", responsePayload);

    return responsePayload;
  } catch (error) {
    logReferral("HTTP_POST.error", {
      message: error?.message || "UNKNOWN_ERROR",
      name: error?.name || "",
      stack: error?.stack || "",
      url,
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getReferralActorUserId(tx) {
  const candidate = tx?.userId || tx?.sender || null;
  return candidate ? String(candidate) : null;
}

function getSourceAmount(tx) {
  return safeNumber(toFloat(tx?.amount));
}

function getTargetAmount(tx) {
  return safeNumber(
    toFloat(tx?.localAmount ?? tx?.amountTarget ?? tx?.targetAmount ?? 0)
  );
}

function getSourceCurrency(tx) {
  return normalizeCurrency(
    tx?.senderCurrencySymbol ||
      tx?.currencySource ||
      tx?.currency ||
      "XOF"
  );
}

function getTargetCurrency(tx) {
  return normalizeCurrency(
    tx?.localCurrencySymbol ||
      tx?.currencyTarget ||
      tx?.targetCurrency ||
      tx?.receiverCurrencySymbol ||
      tx?.beneficiaryCurrencySymbol ||
      getSourceCurrency(tx)
  );
}

async function getConfirmedReferralStats({
  actorUserId,
  sourceCurrency,
  targetCurrency,
  triggerSourceAmount = 0,
  triggerTargetAmount = 0,
}) {
  if (!actorUserId) {
    const emptyStats = {
      confirmedCount: 0,

      source: {
        total: 0,
        largestAmount: 0,
        lastAmount: safeNumber(triggerSourceAmount),
        currency: normalizeCurrency(sourceCurrency),
      },

      target: {
        total: 0,
        largestAmount: 0,
        lastAmount: safeNumber(triggerTargetAmount),
        currency: normalizeCurrency(targetCurrency),
      },

      confirmedTotal: 0,
      largestConfirmedAmount: 0,
      lastConfirmedAmount: safeNumber(triggerSourceAmount),
      currency: normalizeCurrency(sourceCurrency),
    };

    logReferral("getConfirmedReferralStats.actor_missing", {
      actorUserId,
      sourceCurrency,
      targetCurrency,
      triggerSourceAmount,
      triggerTargetAmount,
      stats: emptyStats,
    });

    return emptyStats;
  }

  const normalizedSourceCurrency = normalizeCurrency(sourceCurrency);
  const normalizedTargetCurrency = normalizeCurrency(targetCurrency);

  const pipeline = [
    {
      $match: {
        status: "confirmed",
        flow: { $in: Array.from(BONUS_COUNTABLE_FLOWS) },
        $or: [{ userId: actorUserId }, { sender: actorUserId }],
      },
    },
    {
      $group: {
        _id: null,
        confirmedCount: { $sum: 1 },

        sourceTotal: { $sum: { $ifNull: ["$amount", 0] } },
        sourceLargestAmount: { $max: { $ifNull: ["$amount", 0] } },

        targetTotal: {
          $sum: {
            $ifNull: [
              "$localAmount",
              {
                $ifNull: [
                  "$amountTarget",
                  { $ifNull: ["$targetAmount", 0] }
                ]
              }
            ]
          }
        },
        targetLargestAmount: {
          $max: {
            $ifNull: [
              "$localAmount",
              {
                $ifNull: [
                  "$amountTarget",
                  { $ifNull: ["$targetAmount", 0] }
                ]
              }
            ]
          }
        },
      },
    },
  ];

  logReferral("getConfirmedReferralStats.query", {
    actorUserId,
    sourceCurrency: normalizedSourceCurrency,
    targetCurrency: normalizedTargetCurrency,
    triggerSourceAmount,
    triggerTargetAmount,
    flows: Array.from(BONUS_COUNTABLE_FLOWS),
    pipeline,
  });

  const rows = await Transaction.aggregate(pipeline);
  logReferral("getConfirmedReferralStats.aggregate_rows", rows);

  const row = rows?.[0] || {};

  const normalizedTriggerSourceAmount = safeNumber(triggerSourceAmount);
  const normalizedTriggerTargetAmount = safeNumber(triggerTargetAmount);

  const sourceLargestFromDb = safeNumber(row.sourceLargestAmount);
  const targetLargestFromDb = safeNumber(row.targetLargestAmount);

  const sourceTotal = safeNumber(row.sourceTotal);
  const targetTotal = safeNumber(row.targetTotal);

  const finalStats = {
    confirmedCount: safeNumber(row.confirmedCount),

    source: {
      total: sourceTotal,
      largestAmount: Math.max(sourceLargestFromDb, normalizedTriggerSourceAmount),
      lastAmount: normalizedTriggerSourceAmount,
      currency: normalizedSourceCurrency,
    },

    target: {
      total: targetTotal,
      largestAmount: Math.max(targetLargestFromDb, normalizedTriggerTargetAmount),
      lastAmount: normalizedTriggerTargetAmount,
      currency: normalizedTargetCurrency,
    },

    confirmedTotal: sourceTotal,
    largestConfirmedAmount: Math.max(
      sourceLargestFromDb,
      normalizedTriggerSourceAmount
    ),
    lastConfirmedAmount: normalizedTriggerSourceAmount,
    currency: normalizedSourceCurrency,
  };

  logReferral("getConfirmedReferralStats.result", finalStats);

  return finalStats;
}

async function syncReferralAfterConfirmedTx(tx) {
  logReferral("syncReferralAfterConfirmedTx.input_tx", tx);

  const baseUrl = getPrincipalReferralBaseUrl();
  const internalToken = getPrincipalInternalToken();

  logReferral("syncReferralAfterConfirmedTx.env", {
    baseUrl,
    hasInternalToken: !!internalToken,
  });

  if (!baseUrl) {
    const result = {
      ok: false,
      skipped: true,
      reason: "PRINCIPAL_BASE_URL_MISSING",
    };
    logReferral("syncReferralAfterConfirmedTx.skip", result);
    return result;
  }

  if (!internalToken) {
    const result = {
      ok: false,
      skipped: true,
      reason: "PRINCIPAL_INTERNAL_TOKEN_MISSING",
    };
    logReferral("syncReferralAfterConfirmedTx.skip", result);
    return result;
  }

  const actorUserId = getReferralActorUserId(tx);
  if (!actorUserId) {
    const result = {
      ok: false,
      skipped: true,
      reason: "REFERRAL_ACTOR_USER_MISSING",
    };
    logReferral("syncReferralAfterConfirmedTx.skip", result);
    return result;
  }

  const triggerTxId = String(tx?._id || "");
  const txReference = String(tx?.reference || "");

  const triggerSourceAmount = getSourceAmount(tx);
  const triggerTargetAmount = getTargetAmount(tx);

  const sourceCurrency = getSourceCurrency(tx);
  const targetCurrency = getTargetCurrency(tx);

  const headers = {
    "x-internal-token": internalToken,
  };

  const confirmPayload = {
    userId: actorUserId,
    transaction: {
      id: triggerTxId,
      reference: txReference,
      status: String(tx?.status || "confirmed"),
      amount: triggerSourceAmount,
      localAmount: triggerTargetAmount,
      currency: sourceCurrency,
      localCurrency: targetCurrency,
      currencySource: sourceCurrency,
      currencyTarget: targetCurrency,
      flow: String(tx?.flow || ""),
      confirmedAt: tx?.confirmedAt || new Date(),
    },
  };

  logReferral("confirmPayload", confirmPayload);

  const confirmResp = await postJsonWithTimeout(
    `${baseUrl}/internal/referral/on-transaction-confirm`,
    confirmPayload,
    headers,
    10000
  );

  logReferral("confirmResp", confirmResp);
  logReferral("confirmResp.data", confirmResp?.data);

  const stats = await getConfirmedReferralStats({
    actorUserId,
    sourceCurrency,
    targetCurrency,
    triggerSourceAmount,
    triggerTargetAmount,
  });

  logReferral("stats", stats);

  const awardPayload = {
    refereeId: actorUserId,
    triggerTxId,
    transaction: {
      id: triggerTxId,
      reference: txReference,
      status: String(tx?.status || "confirmed"),
      amount: triggerSourceAmount,
      localAmount: triggerTargetAmount,
      currency: sourceCurrency,
      localCurrency: targetCurrency,
      currencySource: sourceCurrency,
      currencyTarget: targetCurrency,
      flow: String(tx?.flow || ""),
      confirmedAt: tx?.confirmedAt || new Date(),
    },
    stats,
  };

  logReferral("awardPayload", awardPayload);

  const awardResp = await postJsonWithTimeout(
    `${baseUrl}/internal/referral/award-bonus`,
    awardPayload,
    headers,
    10000
  );

  logReferral("awardResp", awardResp);
  logReferral("awardResp.data", awardResp?.data);

  const result = {
    ok: confirmResp.ok && awardResp.ok,
    actorUserId,
    stats,
    confirmCall: {
      ok: confirmResp.ok,
      status: confirmResp.status,
      data: confirmResp.data,
    },
    awardCall: {
      ok: awardResp.ok,
      status: awardResp.status,
      data: awardResp.data,
    },
  };

  logReferral("syncReferralAfterConfirmedTx.result", result);

  return result;
}

module.exports = {
  syncReferralAfterConfirmedTx,
};