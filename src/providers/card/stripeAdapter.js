"use strict";

const axios = require("axios");
const crypto = require("crypto");
const { verifyHmacWebhook } = require("../shared/webhookSecurity");

const PROVIDER = "stripe";

function norm(v) {
  return String(v || "").trim();
}

function upper(v) {
  return norm(v).toUpperCase();
}

function lower(v) {
  return norm(v).toLowerCase();
}

function buildRef(prefix = "STRIPE") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function mapStatus(status) {
  switch (upper(status)) {
    case "SUCCEEDED":
    case "SUCCESS":
    case "COMPLETED":
    case "CAPTURED":
      return "completed";

    case "REQUIRES_ACTION":
    case "PENDING":
    case "PROCESSING":
    case "REQUIRES_CONFIRMATION":
      return "processing";

    case "FAILED":
    case "ERROR":
    case "CANCELED":
    case "CANCELLED":
      return "failed";

    default:
      return "pending";
  }
}

function getConfig() {
  return {
    baseURL: process.env.STRIPE_BASE_URL || "",
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    timeout: Number(process.env.STRIPE_TIMEOUT_MS || 20000),
    mock: String(process.env.STRIPE_MOCK || "true").toLowerCase() === "true",
  };
}

function headers() {
  const cfg = getConfig();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(cfg.secretKey ? { Authorization: `Bearer ${cfg.secretKey}` } : {}),
  };
}

function okResult({ providerReference, externalStatus = "PENDING", message, raw }) {
  return {
    ok: true,
    provider: PROVIDER,
    providerReference: providerReference || buildRef("STRIPE"),
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

  if (cfg.mock || !cfg.baseURL) {
    return okResult({
      providerReference: buildRef("STRIPE_PAYOUT"),
      externalStatus: "PENDING",
      message: "Stripe mock payout accepted",
      raw: { mock: true, input },
    });
  }

  try {
    const payload = {
      reference:
        input.txReference ||
        input.reference ||
        input.idempotencyKey ||
        buildRef("PNV_STRIPE_OUT"),
      amount: Math.round(Number(input.amount || 0) * 100),
      currency: lower(input.currency || "usd"),
      destination: input.cardToken || input.destinationCardToken || null,
      metadata: input.metadata || {},
      description: input.description || "PayNoval card payout",
    };

    const res = await axios.post(`${cfg.baseURL}/transfers`, payload, {
      headers: headers(),
      timeout: cfg.timeout,
    });

    const data = res?.data || {};
    return okResult({
      providerReference: data.providerReference || data.reference || data.id || buildRef("STRIPE_PAYOUT"),
      externalStatus: data.status || "PENDING",
      message: data.message || "Stripe payout accepted",
      raw: data,
    });
  } catch (err) {
    return failResult({
      providerReference: err?.response?.data?.providerReference || err?.response?.data?.id || null,
      externalStatus: err?.response?.data?.status || "FAILED",
      errorCode: err?.response?.data?.code || err.code || "STRIPE_PAYOUT_ERROR",
      errorMessage:
        err?.response?.data?.message || err.message || "Stripe payout failed",
      raw: err?.response?.data || {},
    });
  }
}

async function collect(input = {}) {
  const cfg = getConfig();

  const payload = {
    amount: Math.round(Number(input.amount || 0) * 100),
    currency: lower(input.currency || "usd"),
    paymentMethod: input.paymentMethodId || input.cardToken || null,
    confirm: Boolean(input.confirm ?? true),
    capture: Boolean(input.capture ?? true),
    metadata: {
      txReference:
        input.txReference || input.reference || input.idempotencyKey || buildRef("PNV_STRIPE_IN"),
      ...(input.metadata || {}),
    },
    description: input.description || "PayNoval card topup",
  };

  if (cfg.mock || !cfg.baseURL) {
    return okResult({
      providerReference: buildRef("STRIPE_COLLECT"),
      externalStatus: "REQUIRES_ACTION",
      message: "Stripe mock topup created",
      raw: { mock: true, payload },
    });
  }

  try {
    const res = await axios.post(`${cfg.baseURL}/payment_intents`, payload, {
      headers: headers(),
      timeout: cfg.timeout,
    });
    const data = res?.data || {};
    return okResult({
      providerReference: data.providerReference || data.reference || data.id || buildRef("STRIPE_COLLECT"),
      externalStatus: data.status || "PENDING",
      message: data.message || "Stripe topup initiated",
      raw: data,
    });
  } catch (err) {
    return failResult({
      providerReference: err?.response?.data?.providerReference || err?.response?.data?.id || null,
      externalStatus: err?.response?.data?.status || "FAILED",
      errorCode: err?.response?.data?.code || err.code || "STRIPE_COLLECT_ERROR",
      errorMessage:
        err?.response?.data?.message || err.message || "Stripe topup failed",
      raw: err?.response?.data || {},
    });
  }
}

async function parseWebhook(req = {}) {
  const body = req.body || {};
  const dataObj = body.data?.object || {};
  const eventType = body.type || "";
  const externalStatus =
    dataObj.status ||
    body.status ||
    (eventType === "payment_intent.succeeded" ? "succeeded" : "PENDING");

  const verification = verifyHmacWebhook({
    req,
    secret: process.env.STRIPE_WEBHOOK_SECRET || "",
    signatureHeaders: ["stripe-signature", "x-stripe-signature"],
    timestampHeaders: [],
    algorithm: "sha256",
    toleranceSeconds: Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SEC || 300),
    payloadBuilder: ({ rawBody }) => rawBody,
  });

  return {
    provider: PROVIDER,
    verified: verification.verified,
    verificationReason: verification.reason,
    eventId: body.id || null,
    eventType,
    providerReference: dataObj.id || null,
    txReference:
      dataObj.metadata?.txReference ||
      dataObj.metadata?.txCoreReference ||
      null,
    externalStatus,
    status: mapStatus(externalStatus),
    amount: Number((dataObj.amount_received || dataObj.amount || 0) / 100),
    currency: upper(dataObj.currency || "USD"),
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