"use strict";

const mongoose = require("mongoose");
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

function asObjectId(value) {
  try {
    if (!value) return null;
    return new mongoose.Types.ObjectId(String(value));
  } catch {
    return null;
  }
}

function dedupeMatchConditions(conditions = []) {
  const seen = new Set();
  const out = [];

  for (const item of conditions) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }

  return out;
}

function logReferral(label, payload) {
  try {
    console.log(`[REFERRAL][TX-CORE] ${label} =`, JSON.stringify(payload, null, 2));
  } catch {
    console.log(`[REFERRAL][TX-CORE] ${label} =`, payload);
  }
}

function pickFirstEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (String(value || "").trim()) return String(value).trim();
  }
  return "";
}

function getPrincipalReferralBaseUrl() {
  return normalizeBaseUrl(
    pickFirstEnv(
      "BACKEND_PRINCIPAL_URL",
      "PRINCIPAL_BACKEND_URL",
      "PRINCIPAL_URL",
      "PRINCIPAL_BASE_URL",
      "BACKEND_URL"
    )
  );
}

function getPrincipalInternalToken() {
  return pickFirstEnv(
    "INTERNAL_REFERRAL_TOKEN",
    "PRINCIPAL_INTERNAL_TOKEN",
    "INTERNAL_TOKEN"
  );
}

function getInternalTimeoutMs() {
  const raw = Number(
    pickFirstEnv(
      "REFERRAL_INTERNAL_TIMEOUT_MS",
      "INTERNAL_HTTP_TIMEOUT_MS"
    ) || 10000
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

function buildInternalHeaders(token) {
  return {
    "x-internal-token": token,
  };
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
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

    const data = await readJsonSafe(res);

    const responsePayload = {
      ok: res.ok,
      status: res.status,
      data,
    };

    logReferral("HTTP_POST.response", responsePayload);
    return responsePayload;
  } catch (error) {
    logReferral("HTTP_POST.error", {
      url,
      message: error?.message || "UNKNOWN_ERROR",
      name: error?.name || "",
      stack: error?.stack || "",
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

function buildTxPayload(tx, sourceAmount, targetAmount, sourceCurrency, targetCurrency) {
  return {
    id: String(tx?._id || ""),
    reference: String(tx?.reference || ""),
    status: String(tx?.status || "confirmed"),
    amount: safeNumber(sourceAmount),
    localAmount: safeNumber(targetAmount),
    currency: normalizeCurrency(sourceCurrency),
    localCurrency: normalizeCurrency(targetCurrency),
    currencySource: normalizeCurrency(sourceCurrency),
    currencyTarget: normalizeCurrency(targetCurrency),
    flow: String(tx?.flow || ""),
    confirmedAt: tx?.confirmedAt || new Date(),
  };
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

  const actorUserObjectId = asObjectId(actorUserId);

  const orConditions = dedupeMatchConditions([
    { userId: actorUserId },
    { sender: actorUserId },
    ...(actorUserObjectId
      ? [{ userId: actorUserObjectId }, { sender: actorUserObjectId }]
      : []),
  ]);

  const pipeline = [
    {
      $match: {
        status: "confirmed",
        flow: { $in: Array.from(BONUS_COUNTABLE_FLOWS) },
        $or: orConditions,
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
                $ifNull: ["$amountTarget", { $ifNull: ["$targetAmount", 0] }],
              },
            ],
          },
        },
        targetLargestAmount: {
          $max: {
            $ifNull: [
              "$localAmount",
              {
                $ifNull: ["$amountTarget", { $ifNull: ["$targetAmount", 0] }],
              },
            ],
          },
        },
      },
    },
  ];

  logReferral("getConfirmedReferralStats.query", {
    actorUserId,
    actorUserObjectId: actorUserObjectId ? String(actorUserObjectId) : null,
    sourceCurrency: normalizedSourceCurrency,
    targetCurrency: normalizedTargetCurrency,
    triggerSourceAmount,
    triggerTargetAmount,
    flows: Array.from(BONUS_COUNTABLE_FLOWS),
    pipeline,
  });

  const rows = await Transaction.aggregate(pipeline);
  const row = rows?.[0] || {};

  const normalizedTriggerSourceAmount = safeNumber(triggerSourceAmount);
  const normalizedTriggerTargetAmount = safeNumber(triggerTargetAmount);

  const sourceLargestFromDb = safeNumber(row.sourceLargestAmount);
  const targetLargestFromDb = safeNumber(row.targetLargestAmount);

  const sourceTotalFromDb = safeNumber(row.sourceTotal);
  const targetTotalFromDb = safeNumber(row.targetTotal);
  const confirmedCountFromDb = safeNumber(row.confirmedCount);

  const finalConfirmedCount =
    confirmedCountFromDb > 0
      ? confirmedCountFromDb
      : normalizedTriggerSourceAmount > 0 || normalizedTriggerTargetAmount > 0
      ? 1
      : 0;

  const finalSourceTotal =
    sourceTotalFromDb > 0
      ? sourceTotalFromDb
      : normalizedTriggerSourceAmount > 0
      ? normalizedTriggerSourceAmount
      : 0;

  const finalTargetTotal =
    targetTotalFromDb > 0
      ? targetTotalFromDb
      : normalizedTriggerTargetAmount > 0
      ? normalizedTriggerTargetAmount
      : 0;

  const finalSourceLargest = Math.max(
    sourceLargestFromDb,
    normalizedTriggerSourceAmount
  );

  const finalTargetLargest = Math.max(
    targetLargestFromDb,
    normalizedTriggerTargetAmount
  );

  const finalStats = {
    confirmedCount: finalConfirmedCount,
    source: {
      total: finalSourceTotal,
      largestAmount: finalSourceLargest,
      lastAmount: normalizedTriggerSourceAmount,
      currency: normalizedSourceCurrency,
    },
    target: {
      total: finalTargetTotal,
      largestAmount: finalTargetLargest,
      lastAmount: normalizedTriggerTargetAmount,
      currency: normalizedTargetCurrency,
    },
    confirmedTotal: finalSourceTotal,
    largestConfirmedAmount: finalSourceLargest,
    lastConfirmedAmount: normalizedTriggerSourceAmount,
    currency: normalizedSourceCurrency,
  };

  logReferral("getConfirmedReferralStats.result", finalStats);
  return finalStats;
}

async function callPrincipalReferralEndpoint(baseUrl, path, payload, headers, timeoutMs) {
  const response = await postJsonWithTimeout(
    `${baseUrl}${path}`,
    payload,
    headers,
    timeoutMs
  );

  return {
    ok:
      !!response?.ok &&
      response?.data?.success !== false &&
      response?.data?.ok !== false,
    status: response?.status || 500,
    data: response?.data || null,
  };
}

async function syncReferralAfterConfirmedTx(tx) {
  logReferral("syncReferralAfterConfirmedTx.input_tx", tx);

  if (!tx || typeof tx !== "object") {
    return {
      ok: false,
      skipped: true,
      reason: "TX_OBJECT_REQUIRED",
    };
  }

  const baseUrl = getPrincipalReferralBaseUrl();
  const internalToken = getPrincipalInternalToken();
  const timeoutMs = getInternalTimeoutMs();

  logReferral("syncReferralAfterConfirmedTx.env", {
    baseUrl,
    hasInternalToken: !!internalToken,
    timeoutMs,
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

  if (!triggerTxId && !txReference) {
    const result = {
      ok: false,
      skipped: true,
      reason: "TX_ID_OR_REFERENCE_REQUIRED",
    };
    logReferral("syncReferralAfterConfirmedTx.skip", result);
    return result;
  }

  const triggerSourceAmount = getSourceAmount(tx);
  const triggerTargetAmount = getTargetAmount(tx);

  const sourceCurrency = getSourceCurrency(tx);
  const targetCurrency = getTargetCurrency(tx);

  const headers = buildInternalHeaders(internalToken);
  const txPayload = buildTxPayload(
    tx,
    triggerSourceAmount,
    triggerTargetAmount,
    sourceCurrency,
    targetCurrency
  );

  const confirmPayload = {
    userId: actorUserId,
    transaction: txPayload,
  };

  const stats = await getConfirmedReferralStats({
    actorUserId,
    sourceCurrency,
    targetCurrency,
    triggerSourceAmount,
    triggerTargetAmount,
  });

  const awardPayload = {
    refereeId: actorUserId,
    triggerTxId: String(triggerTxId || txReference),
    transaction: txPayload,
    stats,
  };

  let confirmCall;
  let awardCall;

  try {
    confirmCall = await callPrincipalReferralEndpoint(
      baseUrl,
      "/internal/referral/on-transaction-confirm",
      confirmPayload,
      headers,
      timeoutMs
    );
  } catch (error) {
    confirmCall = {
      ok: false,
      status: 500,
      data: {
        success: false,
        error: error?.message || "CONFIRM_CALL_FAILED",
      },
    };
  }

  try {
    awardCall = await callPrincipalReferralEndpoint(
      baseUrl,
      "/internal/referral/award-bonus",
      awardPayload,
      headers,
      timeoutMs
    );
  } catch (error) {
    awardCall = {
      ok: false,
      status: 500,
      data: {
        success: false,
        error: error?.message || "AWARD_CALL_FAILED",
      },
    };
  }

  const result = {
    ok: !!confirmCall?.ok && !!awardCall?.ok,
    actorUserId,
    triggerTxId: String(triggerTxId || txReference),
    stats,
    confirmCall,
    awardCall,
  };

  logReferral("syncReferralAfterConfirmedTx.result", result);
  return result;
}

module.exports = {
  syncReferralAfterConfirmedTx,
  getConfirmedReferralStats,
};