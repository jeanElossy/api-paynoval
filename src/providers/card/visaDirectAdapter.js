"use strict";

const axios = require("axios");
const crypto = require("crypto");
const { verifyHmacWebhook } = require("../../services/transactions/shared/webhookSecurity");

const PROVIDER = "visa_direct";

function norm(v) {
  return String(v || "").trim();
}

function upper(v) {
  return norm(v).toUpperCase();
}

function buildRef(prefix = "VISA_DIRECT") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function mapStatus(status) {
  switch (upper(status)) {
    case "SUCCESS":
    case "SUCCEEDED":
    case "COMPLETED":
    case "APPROVED":
    case "SETTLED":
      return "completed";

    case "PENDING":
    case "PROCESSING":
    case "IN_PROGRESS":
    case "INITIATED":
      return "processing";

    case "FAILED":
    case "ERROR":
    case "DECLINED":
    case "REJECTED":
      return "failed";

    case "CANCELLED":
    case "CANCELED":
    case "VOIDED":
      return "cancelled";

    default:
      return "pending";
  }
}

function getConfig() {
  return {
    baseURL: process.env.VISA_DIRECT_BASE_URL || "",
    apiKey: process.env.VISA_DIRECT_API_KEY || "",
    timeout: Number(process.env.VISA_DIRECT_TIMEOUT_MS || 20000),
    mock: String(process.env.VISA_DIRECT_MOCK || "true").toLowerCase() === "true",
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
    providerReference: providerReference || buildRef("VISA_DIRECT"),
    externalStatus,
    status: mapStatus(externalStatus),
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
    status: mapStatus(externalStatus),
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
      buildRef("PNV_VISA_OUT"),
    amount: Number(input.amount || 0),
    currency: upper(input.currency || "USD"),
    recipient: {
      pan: input.recipient?.pan || input.pan || null,
      expiryMonth: input.recipient?.expiryMonth || input.expiryMonth || null,
      expiryYear: input.recipient?.expiryYear || input.expiryYear || null,
      name: input.recipient?.name || input.cardHolderName || null,
    },
    description: input.description || "PayNoval Visa Direct payout",
    metadata: input.metadata || {},
  };

  if (cfg.mock || !cfg.baseURL) {
    return okResult({
      providerReference: buildRef("VISA_PAYOUT"),
      externalStatus: "PENDING",
      message: "Visa Direct mock payout accepted",
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
        data.providerReference || data.reference || data.id || buildRef("VISA_PAYOUT"),
      externalStatus: data.status || "PENDING",
      message: data.message || "Visa Direct payout accepted",
      raw: data,
    });
  } catch (err) {
    return failResult({
      providerReference: err?.response?.data?.providerReference || null,
      externalStatus: err?.response?.data?.status || "FAILED",
      errorCode: err?.response?.data?.code || err.code || "VISA_PAYOUT_ERROR",
      errorMessage:
        err?.response?.data?.message || err.message || "Visa Direct payout failed",
      raw: err?.response?.data || {},
    });
  }
}

async function collect(input = {}) {
  const cfg = getConfig();

  if (String(process.env.VISA_DIRECT_COLLECT_ENABLED || "false").toLowerCase() !== "true") {
    return failResult({
      errorCode: "UNSUPPORTED_OPERATION",
      errorMessage: "Visa Direct collect not enabled for this provider",
      raw: { input },
    });
  }

  const payload = {
    reference:
      input.txReference ||
      input.reference ||
      input.idempotencyKey ||
      buildRef("PNV_VISA_IN"),
    amount: Number(input.amount || 0),
    currency: upper(input.currency || "USD"),
    source: {
      pan: input.sender?.pan || input.pan || null,
      expiryMonth: input.sender?.expiryMonth || input.expiryMonth || null,
      expiryYear: input.sender?.expiryYear || input.expiryYear || null,
      name: input.sender?.name || input.cardHolderName || null,
    },
    description: input.description || "PayNoval Visa Direct collect",
    metadata: input.metadata || {},
  };

  if (cfg.mock || !cfg.baseURL) {
    return okResult({
      providerReference: buildRef("VISA_COLLECT"),
      externalStatus: "PENDING",
      message: "Visa Direct mock collect initiated",
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
        data.providerReference || data.reference || data.id || buildRef("VISA_COLLECT"),
      externalStatus: data.status || "PENDING",
      message: data.message || "Visa Direct collect initiated",
      raw: data,
    });
  } catch (err) {
    return failResult({
      providerReference: err?.response?.data?.providerReference || null,
      externalStatus: err?.response?.data?.status || "FAILED",
      errorCode: err?.response?.data?.code || err.code || "VISA_COLLECT_ERROR",
      errorMessage:
        err?.response?.data?.message || err.message || "Visa Direct collect failed",
      raw: err?.response?.data || {},
    });
  }
}

async function parseWebhook(req = {}) {
  const body = req.body || {};

  const verification = verifyHmacWebhook({
    req,
    secret: process.env.VISA_DIRECT_WEBHOOK_SECRET || "",
    signatureHeaders: ["x-visa-signature", "x-signature"],
    timestampHeaders: ["x-visa-timestamp", "x-timestamp"],
    algorithm: "sha256",
    toleranceSeconds: Number(process.env.VISA_DIRECT_WEBHOOK_TOLERANCE_SEC || 300),
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
    status: mapStatus(externalStatus),
    amount: Number(body.amount || body.value || 0),
    currency: upper(body.currency || "USD"),
    raw: body,
  };
}

module.exports = {
  provider: PROVIDER,
  payout,
  collect,
  parseWebhook,
  mapStatus,
};