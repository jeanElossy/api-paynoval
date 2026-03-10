"use strict";

const createError = require("http-errors");
const logger = require("../logger");

const { getProviderAdapter } = require("../providers/providerSelector");
const {
  settleExternalTransactionWebhook,
} = require("./externalSettlementController");

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function cleanValue(v) {
  if (Array.isArray(v)) return v[0] ?? "";
  return v;
}

function pickProvider(req) {
  return norm(
    cleanValue(req.params?.provider) ||
      cleanValue(req.query?.provider) ||
      cleanValue(req.headers?.["x-provider"]) ||
      cleanValue(req.body?.provider) ||
      cleanValue(req.body?.metadata?.provider) ||
      ""
  );
}

function pickRail(req) {
  return norm(
    cleanValue(req.params?.rail) ||
      cleanValue(req.query?.rail) ||
      cleanValue(req.headers?.["x-rail"]) ||
      cleanValue(req.body?.rail) ||
      cleanValue(req.body?.metadata?.rail) ||
      ""
  );
}

function inferRailFromProvider(provider) {
  const p = norm(provider);

  if (["wave", "orange", "mtn", "moov", "flutterwave"].includes(p)) {
    return "mobilemoney";
  }

  if (["stripe", "visa_direct", "visadirect", "visa-direct"].includes(p)) {
    return "card";
  }

  if (
    ["bank", "bank_generic", "bankgeneric", "bank-transfer", "bank_transfer"].includes(p)
  ) {
    return "bank";
  }

  return "";
}

function canonicalProviderStatus(status) {
  const s = norm(status);

  if (
    [
      "success",
      "successful",
      "completed",
      "confirmed",
      "paid",
      "settled",
      "captured",
      "succeeded",
      "approved",
      "ok",
    ].includes(s)
  ) {
    return "SUCCESS";
  }

  if (
    [
      "failed",
      "failure",
      "error",
      "cancelled",
      "canceled",
      "expired",
      "rejected",
      "reversed",
      "declined",
      "voided",
    ].includes(s)
  ) {
    return "FAILED";
  }

  return "PROCESSING";
}

function pickTransactionId(parsed, raw) {
  return (
    parsed?.transactionId ||
    raw?.transactionId ||
    raw?.txCoreTransactionId ||
    raw?.metadata?.txCoreTransactionId ||
    null
  );
}

function pickReference(parsed, raw) {
  return (
    parsed?.txReference ||
    raw?.reference ||
    raw?.txReference ||
    raw?.merchantReference ||
    raw?.clientReference ||
    raw?.metadata?.txReference ||
    raw?.metadata?.txCoreReference ||
    null
  );
}

function pickProviderReference(parsed, raw) {
  return (
    parsed?.providerReference ||
    raw?.providerReference ||
    raw?.externalReference ||
    raw?.provider_ref ||
    raw?.reference ||
    null
  );
}

function pickEventId(parsed, raw) {
  return (
    parsed?.eventId ||
    raw?.eventId ||
    raw?.event_id ||
    raw?.id ||
    raw?.webhookId ||
    null
  );
}

function pickEventType(parsed, raw) {
  return (
    parsed?.eventType ||
    raw?.eventType ||
    raw?.type ||
    raw?.event ||
    null
  );
}

function buildSettlementPayload(parsed, req, rail, provider) {
  const raw = parsed?.raw && typeof parsed.raw === "object" ? parsed.raw : req.body || {};

  const normalizedStatus = canonicalProviderStatus(
    parsed?.externalStatus ||
      parsed?.status ||
      raw?.status ||
      raw?.providerStatus ||
      raw?.event ||
      raw?.state
  );

  return {
    transactionId: pickTransactionId(parsed, raw),
    reference: pickReference(parsed, raw),
    providerReference: pickProviderReference(parsed, raw),

    provider:
      provider ||
      parsed?.provider ||
      raw?.provider ||
      raw?.metadata?.provider ||
      null,

    rail:
      rail ||
      raw?.rail ||
      raw?.metadata?.rail ||
      null,

    eventId: pickEventId(parsed, raw),
    eventType: pickEventType(parsed, raw),

    providerStatus: normalizedStatus,
    status: normalizedStatus,

    amount:
      parsed?.amount ??
      raw?.amount ??
      raw?.value ??
      null,

    currency:
      parsed?.currency ||
      raw?.currency ||
      null,

    reason:
      raw?.reason ||
      raw?.error ||
      raw?.message ||
      parsed?.verificationReason ||
      null,

    verified: Boolean(parsed?.verified),
    verificationReason: parsed?.verificationReason || null,

    raw,
  };
}

async function providerWebhookController(req, res, next) {
  try {
    const provider = pickProvider(req);
    if (!provider) {
      throw createError(400, "Provider webhook manquant");
    }

    const rail = pickRail(req) || inferRailFromProvider(provider);
    if (!rail) {
      throw createError(400, `Rail introuvable pour provider ${provider}`);
    }

    let adapter;
    try {
      adapter = getProviderAdapter({ rail, provider });
    } catch (_err) {
      throw createError(
        400,
        `Adapter webhook introuvable pour rail=${rail} provider=${provider}`
      );
    }

    if (!adapter || typeof adapter.parseWebhook !== "function") {
      throw createError(
        400,
        `Adapter webhook introuvable pour rail=${rail} provider=${provider}`
      );
    }

    const parsed = await adapter.parseWebhook(req);

    if (!parsed || typeof parsed !== "object") {
      throw createError(400, "Webhook provider invalide ou vide");
    }

    if (parsed.verified === false) {
      logger.warn("[providerWebhook] signature invalide", {
        provider,
        rail,
        reason: parsed?.verificationReason || "BAD_SIGNATURE",
        ip: req.ip,
        path: req.originalUrl,
      });

      throw createError(401, `Signature webhook invalide (${provider})`);
    }

    const settlementPayload = buildSettlementPayload(parsed, req, rail, provider);

    logger.info("[providerWebhook] webhook normalisé", {
      provider,
      rail,
      eventId: settlementPayload.eventId,
      reference: settlementPayload.reference,
      providerReference: settlementPayload.providerReference,
      providerStatus: settlementPayload.providerStatus,
      verified: settlementPayload.verified,
    });

    req.body = settlementPayload;

    return settleExternalTransactionWebhook(req, res, next);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  providerWebhookController,
};