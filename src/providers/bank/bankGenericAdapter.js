"use strict";

const axios = require("axios");
const crypto = require("crypto");
const { verifyHmacWebhook } = require("../../services/transactions/shared/webhookSecurity");

const PROVIDER = "bank_generic";

function norm(v) {
  return String(v || "").trim();
}

function upper(v) {
  return norm(v).toUpperCase();
}

function buildRef(prefix = "BANK") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function mapStatus(status) {
  switch (upper(status)) {
    case "SUCCESS":
    case "SUCCEEDED":
    case "COMPLETED":
    case "SETTLED":
      return "completed";
    case "PENDING":
    case "PROCESSING":
    case "IN_PROGRESS":
    case "INITIATED":
      return "processing";
    case "FAILED":
    case "ERROR":
    case "REJECTED":
    case "RETURNED":
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
    baseURL: process.env.BANK_GENERIC_BASE_URL || "",
    apiKey: process.env.BANK_GENERIC_API_KEY || "",
    timeout: Number(process.env.BANK_GENERIC_TIMEOUT_MS || 20000),
    mock: String(process.env.BANK_GENERIC_MOCK || "true").toLowerCase() === "true",
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
    providerReference: providerReference || buildRef("BANK"),
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
      buildRef("PNV_BANK_OUT"),
    amount: Number(input.amount || 0),
    currency: upper(input.currency || "CAD"),
    beneficiary: {
      name: input.recipient?.name || input.bankAccountName || null,
      iban: input.recipient?.iban || input.iban || null,
      accountNumber: input.recipient?.accountNumber || input.accountNumber || null,
      bankCode: input.recipient?.bankCode || input.bankCode || null,
      swift: input.recipient?.swift || input.swift || null,
      country: input.recipient?.country || input.country || null,
    },
    description: input.description || "PayNoval bank payout",
    metadata: input.metadata || {},
  };

  if (cfg.mock || !cfg.baseURL) {
    return okResult({
      providerReference: buildRef("BANK_PAYOUT"),
      externalStatus: "PENDING",
      message: "Bank mock payout accepted",
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
        data.providerReference || data.reference || data.id || buildRef("BANK_PAYOUT"),
      externalStatus: data.status || "PENDING",
      message: data.message || "Bank payout accepted",
      raw: data,
    });
  } catch (err) {
    return failResult({
      providerReference: err?.response?.data?.providerReference || null,
      externalStatus: err?.response?.data?.status || "FAILED",
      errorCode: err?.response?.data?.code || err.code || "BANK_PAYOUT_ERROR",
      errorMessage: err?.response?.data?.message || err.message || "Bank payout failed",
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
      buildRef("PNV_BANK_IN"),
    amount: Number(input.amount || 0),
    currency: upper(input.currency || "CAD"),
    debtor: {
      name: input.sender?.name || input.bankAccountName || null,
      iban: input.sender?.iban || input.iban || null,
      accountNumber: input.sender?.accountNumber || input.accountNumber || null,
      bankCode: input.sender?.bankCode || input.bankCode || null,
      swift: input.sender?.swift || input.swift || null,
      country: input.sender?.country || input.country || null,
    },
    description: input.description || "PayNoval bank collection",
    metadata: input.metadata || {},
  };

  if (cfg.mock || !cfg.baseURL) {
    return okResult({
      providerReference: buildRef("BANK_COLLECT"),
      externalStatus: "PENDING",
      message: "Bank mock collection initiated",
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
        data.providerReference || data.reference || data.id || buildRef("BANK_COLLECT"),
      externalStatus: data.status || "PENDING",
      message: data.message || "Bank collection initiated",
      raw: data,
    });
  } catch (err) {
    return failResult({
      providerReference: err?.response?.data?.providerReference || null,
      externalStatus: err?.response?.data?.status || "FAILED",
      errorCode: err?.response?.data?.code || err.code || "BANK_COLLECT_ERROR",
      errorMessage:
        err?.response?.data?.message || err.message || "Bank collection failed",
      raw: err?.response?.data || {},
    });
  }
}

async function parseWebhook(req = {}) {
  const body = req.body || {};

  const verification = verifyHmacWebhook({
    req,
    secret: process.env.BANK_GENERIC_WEBHOOK_SECRET || "",
    signatureHeaders: ["x-bank-signature", "x-signature"],
    timestampHeaders: ["x-bank-timestamp", "x-timestamp"],
    algorithm: "sha256",
    toleranceSeconds: Number(process.env.BANK_GENERIC_WEBHOOK_TOLERANCE_SEC || 300),
  });

  const externalStatus =
    body.status ||
    body.transferStatus ||
    body.transactionStatus ||
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
      body.endToEndId ||
      body.metadata?.txReference ||
      body.metadata?.txCoreReference ||
      null,
    externalStatus,
    status: mapStatus(externalStatus),
    amount: Number(body.amount || body.value || 0),
    currency: upper(body.currency || "CAD"),
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