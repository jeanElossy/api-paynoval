"use strict";

const { Transaction } = require("../shared/runtime");
const { toFloat } = require("../shared/helpers");

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

    return {
      ok: res.ok,
      status: res.status,
      data: json,
    };
  } finally {
    clearTimeout(timer);
  }
}

function getReferralActorUserId(tx) {
  const candidate = tx?.userId || tx?.sender || null;
  return candidate ? String(candidate) : null;
}

async function getConfirmedReferralStats({ actorUserId, currency }) {
  if (!actorUserId) {
    return {
      confirmedCount: 0,
      confirmedTotal: 0,
      currency: String(currency || "").trim().toUpperCase() || "XOF",
    };
  }

  const normalizedCurrency =
    String(currency || "").trim().toUpperCase() || "XOF";

  const rows = await Transaction.aggregate([
    {
      $match: {
        status: "confirmed",
        flow: { $in: Array.from(BONUS_COUNTABLE_FLOWS) },
        $or: [
          { userId: actorUserId },
          { sender: actorUserId },
        ],
      },
    },
    {
      $group: {
        _id: null,
        confirmedCount: { $sum: 1 },
        confirmedTotal: { $sum: { $ifNull: ["$amount", 0] } },
      },
    },
  ]);

  const row = rows?.[0] || {};

  return {
    confirmedCount: Number(row.confirmedCount || 0),
    confirmedTotal: Number(row.confirmedTotal || 0),
    currency: normalizedCurrency,
  };
}

async function syncReferralAfterConfirmedTx(tx) {
  const baseUrl = getPrincipalReferralBaseUrl();
  const internalToken = getPrincipalInternalToken();

  if (!baseUrl) {
    return {
      ok: false,
      skipped: true,
      reason: "PRINCIPAL_BASE_URL_MISSING",
    };
  }

  if (!internalToken) {
    return {
      ok: false,
      skipped: true,
      reason: "PRINCIPAL_INTERNAL_TOKEN_MISSING",
    };
  }

  const actorUserId = getReferralActorUserId(tx);
  if (!actorUserId) {
    return {
      ok: false,
      skipped: true,
      reason: "REFERRAL_ACTOR_USER_MISSING",
    };
  }

  const triggerTxId = String(tx?._id || "");
  const txReference = String(tx?.reference || "");
  const sourceCurrency =
    String(
      tx?.senderCurrencySymbol ||
        tx?.currency ||
        tx?.localCurrencySymbol ||
        ""
    )
      .trim()
      .toUpperCase() || "XOF";

  const headers = {
    "x-internal-token": internalToken,
  };

  const confirmPayload = {
    userId: actorUserId,
    transaction: {
      id: triggerTxId,
      reference: txReference,
      status: String(tx?.status || "confirmed"),
      amount: Number(toFloat(tx?.amount)),
      currency: sourceCurrency,
      flow: String(tx?.flow || ""),
      confirmedAt: tx?.confirmedAt || new Date(),
    },
  };

  const confirmResp = await postJsonWithTimeout(
    `${baseUrl}/internal/referral/on-transaction-confirm`,
    confirmPayload,
    headers,
    10000
  );

  const stats = await getConfirmedReferralStats({
    actorUserId,
    currency: sourceCurrency,
  });

  const awardPayload = {
    refereeId: actorUserId,
    triggerTxId,
    stats,
  };

  const awardResp = await postJsonWithTimeout(
    `${baseUrl}/internal/referral/award-bonus`,
    awardPayload,
    headers,
    10000
  );

  return {
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
}

module.exports = {
  syncReferralAfterConfirmedTx,
};