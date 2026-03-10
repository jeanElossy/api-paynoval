"use strict";

const axios = require("axios");
const crypto = require("crypto");
const { verifyHmacWebhook } = require("../../services/transactions/shared/webhookSecurity");

const PROVIDER = "orange";

function norm(v) {
  return String(v || "").trim();
}

function upper(v) {
  return norm(v).toUpperCase();
}

function buildRef(prefix = "ORANGE") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function canonicalStatus(status) {
  switch (upper(status)) {
    case "SUCCESS":
    case "SUCCEEDED":
    case "COMPLETED":
    case "PAID":
    case "OK":
      return "completed";
    case "PENDING":
    case "PROCESSING":
    case "IN_PROGRESS":
    case "INITIATED":
    case "ACCEPTED":
      return "processing";
    case "FAILED":
    case "ERROR":
    case "REJECTED":
    case "DECLINED":
      return "failed";
    case "CANCELLED":
    case "CANCELED":
    case "VOIDED":
    case "EXPIRED":
      return "cancelled";
    default:
      return "pending";
  }
}

function getConfig() {
  return {
    baseURL: process.env.ORANGE_BASE_URL || "",
    apiKey: process.env.ORANGE_API_KEY || "",
    timeout: Number(process.env.ORANGE_TIMEOUT_MS || 15000),
    mock: String(process.env.ORANGE_MOCK || "true").toLowerCase() === "true",
  };
}

function headers() {
  const cfg = getConfig();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
  };
}

function okResult({ providerReference, externalStatus = "PENDING", message, raw }) {
  return {
    ok: true,
    provider: PROVIDER,
    providerReference: providerReference || buildRef("ORANGE"),
    externalStatus,
    status: canonicalStatus(externalStatus),
    message: message || "Accepted by provider",
    raw: raw || {},
  };
}

function failResult({
  providerReference = null,
  externalStatus = "FAILED",
  errorCode = "PROVIDER_ERROR",
  errorMessage = "Provider request failed",
  raw = {},
}) {
  return {
    ok: false,
    provider: PROVIDER,
    providerReference,
    externalStatus,
    status: canonicalStatus(externalStatus),
    errorCode,
    errorMessage,
    raw,
  };
}

async function payout(input = {}) {
  const cfg = getConfig();
  const payload = {
    reference:
      input.txReference ||
      input.reference ||
      input.idempotencyKey ||
      buildRef("PNV_ORANGE_OUT"),
    amount: Number(input.amount || 0),
    currency: upper(input.currency || "XOF"),
    phoneNumber: input.recipient?.phone || input.phone || null,
    recipientName: input.recipient?.name || null,
    description: input.description || "PayNoval Orange payout",
    metadata: input.metadata || {},
  };

  if (cfg.mock || !cfg.baseURL) {
    return okResult({
      providerReference: buildRef("ORANGE_PAYOUT"),
      externalStatus: "PENDING",
      message: "Orange mock payout accepted",
      raw: { mock: true, payload },
    });
  }

  try {
    const res = await axios.post(`${cfg.baseURL}/payouts`, payload, {
      headers: headers(),
      timeout: cfg.timeout,
    });
    const data = res?.data || {};
    return okResult({
      providerReference:
        data.providerReference || data.reference || data.id || buildRef("ORANGE_PAYOUT"),
      externalStatus: data.status || "PENDING",
      message: data.message || "Orange payout accepted",
      raw: data,
    });
  } catch (err) {
    return failResult({
      providerReference: err?.response?.data?.providerReference || null,
      externalStatus: err?.response?.data?.status || "FAILED",
      errorCode: err?.response?.data?.code || err.code || "ORANGE_PAYOUT_ERROR",
      errorMessage:
        err?.response?.data?.message || err.message || "Orange payout failed",
      raw: err?.response?.data || {},
    });
  }
}

async function collect(input = {}) {
  const cfg = getConfig();
  const payload = {
    reference:
      input.txReference ||
      input.reference ||
      input.idempotencyKey ||
      buildRef("PNV_ORANGE_IN"),
    amount: Number(input.amount || 0),
    currency: upper(input.currency || "XOF"),
    phoneNumber: input.sender?.phone || input.phone || null,
    customerName: input.sender?.name || null,
    description: input.description || "PayNoval Orange collection",
    metadata: input.metadata || {},
  };

  if (cfg.mock || !cfg.baseURL) {
    return okResult({
      providerReference: buildRef("ORANGE_COLLECT"),
      externalStatus: "PENDING",
      message: "Orange mock collection initiated",
      raw: { mock: true, payload },
    });
  }

  try {
    const res = await axios.post(`${cfg.baseURL}/collections`, payload, {
      headers: headers(),
      timeout: cfg.timeout,
    });
    const data = res?.data || {};
    return okResult({
      providerReference:
        data.providerReference || data.reference || data.id || buildRef("ORANGE_COLLECT"),
      externalStatus: data.status || "PENDING",
      message: data.message || "Orange collection initiated",
      raw: data,
    });
  } catch (err) {
    return failResult({
      providerReference: err?.response?.data?.providerReference || null,
      externalStatus: err?.response?.data?.status || "FAILED",
      errorCode: err?.response?.data?.code || err.code || "ORANGE_COLLECT_ERROR",
      errorMessage:
        err?.response?.data?.message || err.message || "Orange collection failed",
      raw: err?.response?.data || {},
    });
  }
}

async function parseWebhook(req = {}) {
  const body = req.body || {};

  const verification = verifyHmacWebhook({
    req,
    secret: process.env.ORANGE_WEBHOOK_SECRET || "",
    signatureHeaders: ["x-orange-signature", "x-signature"],
    timestampHeaders: ["x-orange-timestamp", "x-timestamp"],
    algorithm: "sha256",
    toleranceSeconds: Number(process.env.ORANGE_WEBHOOK_TOLERANCE_SEC || 300),
  });

  const externalStatus =
    body.status ||
    body.transactionStatus ||
    body.eventStatus ||
    body.state ||
    "PENDING";

  return {
    provider: PROVIDER,
    verified: verification.verified,
    verificationReason: verification.reason,
    eventId: body.eventId || body.id || body.reference || null,
    eventType: body.type || body.eventType || body.event || null,
    providerReference:
      body.providerReference || body.reference || body.transactionId || body.id || null,
    txReference:
      body.txReference ||
      body.clientReference ||
      body.merchantReference ||
      body.metadata?.txReference ||
      body.metadata?.txCoreReference ||
      null,
    externalStatus,
    status: canonicalStatus(externalStatus),
    amount: Number(body.amount || body.value || 0),
    currency: upper(body.currency || "XOF"),
    raw: body,
  };
}

module.exports = {
  provider: PROVIDER,
  payout,
  collect,
  parseWebhook,
  mapStatus: canonicalStatus,
};