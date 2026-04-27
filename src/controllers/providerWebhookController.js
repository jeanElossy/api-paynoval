// "use strict";

// const createError = require("http-errors");
// const logger = require("../logger");

// const { getProviderAdapter } = require("../providers/providerSelector");
// const {
//   settleExternalTransactionWebhook,
// } = require("./externalSettlementController");

// function norm(v) {
//   return String(v || "").trim().toLowerCase();
// }

// function cleanValue(v) {
//   if (Array.isArray(v)) return v[0] ?? "";
//   return v;
// }

// function pickProvider(req) {
//   return norm(
//     cleanValue(req.params?.provider) ||
//       cleanValue(req.query?.provider) ||
//       cleanValue(req.headers?.["x-provider"]) ||
//       cleanValue(req.body?.provider) ||
//       cleanValue(req.body?.metadata?.provider) ||
//       ""
//   );
// }

// function pickRail(req) {
//   return norm(
//     cleanValue(req.params?.rail) ||
//       cleanValue(req.query?.rail) ||
//       cleanValue(req.headers?.["x-rail"]) ||
//       cleanValue(req.body?.rail) ||
//       cleanValue(req.body?.metadata?.rail) ||
//       ""
//   );
// }

// function inferRailFromProvider(provider) {
//   const p = norm(provider);

//   if (["wave", "orange", "mtn", "moov", "flutterwave"].includes(p)) {
//     return "mobilemoney";
//   }

//   if (["stripe", "visa_direct", "visadirect", "visa-direct"].includes(p)) {
//     return "card";
//   }

//   if (
//     ["bank", "bank_generic", "bankgeneric", "bank-transfer", "bank_transfer"].includes(p)
//   ) {
//     return "bank";
//   }

//   return "";
// }

// function canonicalProviderStatus(status) {
//   const s = norm(status);

//   if (
//     [
//       "success",
//       "successful",
//       "completed",
//       "confirmed",
//       "paid",
//       "settled",
//       "captured",
//       "succeeded",
//       "approved",
//       "ok",
//     ].includes(s)
//   ) {
//     return "SUCCESS";
//   }

//   if (
//     [
//       "failed",
//       "failure",
//       "error",
//       "cancelled",
//       "canceled",
//       "expired",
//       "rejected",
//       "reversed",
//       "declined",
//       "voided",
//     ].includes(s)
//   ) {
//     return "FAILED";
//   }

//   return "PROCESSING";
// }

// function pickTransactionId(parsed, raw) {
//   return (
//     parsed?.transactionId ||
//     raw?.transactionId ||
//     raw?.txCoreTransactionId ||
//     raw?.metadata?.txCoreTransactionId ||
//     null
//   );
// }

// function pickReference(parsed, raw) {
//   return (
//     parsed?.txReference ||
//     raw?.reference ||
//     raw?.txReference ||
//     raw?.merchantReference ||
//     raw?.clientReference ||
//     raw?.metadata?.txReference ||
//     raw?.metadata?.txCoreReference ||
//     null
//   );
// }

// function pickProviderReference(parsed, raw) {
//   return (
//     parsed?.providerReference ||
//     raw?.providerReference ||
//     raw?.externalReference ||
//     raw?.provider_ref ||
//     raw?.reference ||
//     null
//   );
// }

// function pickEventId(parsed, raw) {
//   return (
//     parsed?.eventId ||
//     raw?.eventId ||
//     raw?.event_id ||
//     raw?.id ||
//     raw?.webhookId ||
//     null
//   );
// }

// function pickEventType(parsed, raw) {
//   return (
//     parsed?.eventType ||
//     raw?.eventType ||
//     raw?.type ||
//     raw?.event ||
//     null
//   );
// }

// function buildSettlementPayload(parsed, req, rail, provider) {
//   const raw = parsed?.raw && typeof parsed.raw === "object" ? parsed.raw : req.body || {};

//   const normalizedStatus = canonicalProviderStatus(
//     parsed?.externalStatus ||
//       parsed?.status ||
//       raw?.status ||
//       raw?.providerStatus ||
//       raw?.event ||
//       raw?.state
//   );

//   return {
//     transactionId: pickTransactionId(parsed, raw),
//     reference: pickReference(parsed, raw),
//     providerReference: pickProviderReference(parsed, raw),

//     provider:
//       provider ||
//       parsed?.provider ||
//       raw?.provider ||
//       raw?.metadata?.provider ||
//       null,

//     rail:
//       rail ||
//       raw?.rail ||
//       raw?.metadata?.rail ||
//       null,

//     eventId: pickEventId(parsed, raw),
//     eventType: pickEventType(parsed, raw),

//     providerStatus: normalizedStatus,
//     status: normalizedStatus,

//     amount:
//       parsed?.amount ??
//       raw?.amount ??
//       raw?.value ??
//       null,

//     currency:
//       parsed?.currency ||
//       raw?.currency ||
//       null,

//     reason:
//       raw?.reason ||
//       raw?.error ||
//       raw?.message ||
//       parsed?.verificationReason ||
//       null,

//     verified: Boolean(parsed?.verified),
//     verificationReason: parsed?.verificationReason || null,

//     raw,
//   };
// }

// async function providerWebhookController(req, res, next) {
//   try {
//     const provider = pickProvider(req);
//     if (!provider) {
//       throw createError(400, "Provider webhook manquant");
//     }

//     const rail = pickRail(req) || inferRailFromProvider(provider);
//     if (!rail) {
//       throw createError(400, `Rail introuvable pour provider ${provider}`);
//     }

//     let adapter;
//     try {
//       adapter = getProviderAdapter({ rail, provider });
//     } catch (_err) {
//       throw createError(
//         400,
//         `Adapter webhook introuvable pour rail=${rail} provider=${provider}`
//       );
//     }

//     if (!adapter || typeof adapter.parseWebhook !== "function") {
//       throw createError(
//         400,
//         `Adapter webhook introuvable pour rail=${rail} provider=${provider}`
//       );
//     }

//     const parsed = await adapter.parseWebhook(req);

//     if (!parsed || typeof parsed !== "object") {
//       throw createError(400, "Webhook provider invalide ou vide");
//     }

//     if (parsed.verified === false) {
//       logger.warn("[providerWebhook] signature invalide", {
//         provider,
//         rail,
//         reason: parsed?.verificationReason || "BAD_SIGNATURE",
//         ip: req.ip,
//         path: req.originalUrl,
//       });

//       throw createError(401, `Signature webhook invalide (${provider})`);
//     }

//     const settlementPayload = buildSettlementPayload(parsed, req, rail, provider);

//     logger.info("[providerWebhook] webhook normalisé", {
//       provider,
//       rail,
//       eventId: settlementPayload.eventId,
//       reference: settlementPayload.reference,
//       providerReference: settlementPayload.providerReference,
//       providerStatus: settlementPayload.providerStatus,
//       verified: settlementPayload.verified,
//     });

//     req.body = settlementPayload;

//     return settleExternalTransactionWebhook(req, res, next);
//   } catch (err) {
//     return next(err);
//   }
// }

// module.exports = {
//   providerWebhookController,
// };






// File: src/controllers/providerWebhookController.js
"use strict";

const createError = require("http-errors");
const logger = require("../logger");

const { getProviderAdapter } = require("../providers/providerSelector");
const {
  settleExternalTransactionWebhook,
} = require("./externalSettlementController");

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanValue(value) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value;
}

function pickNested(obj, paths = []) {
  for (const path of paths) {
    const parts = String(path || "").split(".").filter(Boolean);
    let cursor = obj;

    for (const part of parts) {
      if (!cursor || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }

      cursor = cursor[part];
    }

    if (cursor !== undefined && cursor !== null && String(cursor).trim()) {
      return cursor;
    }
  }

  return null;
}

function pickProvider(req) {
  return norm(
    cleanValue(req.params?.provider) ||
      cleanValue(req.query?.provider) ||
      cleanValue(req.headers?.["x-provider"]) ||
      cleanValue(req.body?.provider) ||
      cleanValue(req.body?.metadata?.provider) ||
      cleanValue(req.body?.data?.provider) ||
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
      cleanValue(req.body?.data?.rail) ||
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
    [
      "bank",
      "bank_generic",
      "bankgeneric",
      "bank-transfer",
      "bank_transfer",
    ].includes(p)
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
    parsed?.txCoreTransactionId ||
    parsed?.metadata?.txCoreTransactionId ||
    parsed?.data?.transactionId ||
    parsed?.data?.txCoreTransactionId ||
    raw?.transactionId ||
    raw?.txCoreTransactionId ||
    raw?.metadata?.txCoreTransactionId ||
    raw?.data?.transactionId ||
    raw?.data?.txCoreTransactionId ||
    null
  );
}

function pickReference(parsed, raw) {
  return (
    parsed?.txReference ||
    parsed?.reference ||
    parsed?.merchantReference ||
    parsed?.clientReference ||
    parsed?.metadata?.txReference ||
    parsed?.metadata?.txCoreReference ||
    parsed?.data?.reference ||
    parsed?.data?.txReference ||
    raw?.reference ||
    raw?.txReference ||
    raw?.merchantReference ||
    raw?.clientReference ||
    raw?.metadata?.txReference ||
    raw?.metadata?.txCoreReference ||
    raw?.data?.reference ||
    raw?.data?.txReference ||
    null
  );
}

function pickProviderReference(parsed, raw) {
  return (
    parsed?.providerReference ||
    parsed?.externalReference ||
    parsed?.provider_ref ||
    parsed?.providerRef ||
    parsed?.data?.providerReference ||
    parsed?.data?.externalReference ||
    raw?.providerReference ||
    raw?.externalReference ||
    raw?.provider_ref ||
    raw?.providerRef ||
    raw?.data?.providerReference ||
    raw?.data?.externalReference ||
    raw?.reference ||
    null
  );
}

function pickEventId(parsed, raw) {
  return (
    parsed?.eventId ||
    parsed?.event_id ||
    parsed?.webhookId ||
    parsed?.id ||
    parsed?.data?.eventId ||
    parsed?.data?.id ||
    raw?.eventId ||
    raw?.event_id ||
    raw?.id ||
    raw?.webhookId ||
    raw?.data?.eventId ||
    raw?.data?.id ||
    null
  );
}

function pickEventType(parsed, raw) {
  return (
    parsed?.eventType ||
    parsed?.event_type ||
    parsed?.type ||
    parsed?.event ||
    parsed?.data?.eventType ||
    parsed?.data?.type ||
    raw?.eventType ||
    raw?.event_type ||
    raw?.type ||
    raw?.event ||
    raw?.data?.eventType ||
    raw?.data?.type ||
    null
  );
}

function buildSettlementPayload(parsed, req, rail, provider) {
  const raw =
    parsed?.raw && typeof parsed.raw === "object" ? parsed.raw : req.body || {};

  const rawStatus =
    parsed?.externalStatus ||
    parsed?.status ||
    parsed?.providerStatus ||
    parsed?.event ||
    parsed?.state ||
    parsed?.data?.status ||
    parsed?.data?.state ||
    raw?.status ||
    raw?.providerStatus ||
    raw?.event ||
    raw?.state ||
    raw?.data?.status ||
    raw?.data?.state ||
    pickNested(raw, ["payment.status", "transaction.status"]);

  const normalizedStatus = canonicalProviderStatus(rawStatus);

  return {
    transactionId: pickTransactionId(parsed, raw),
    reference: pickReference(parsed, raw),
    providerReference: pickProviderReference(parsed, raw),

    provider:
      provider ||
      parsed?.provider ||
      parsed?.metadata?.provider ||
      parsed?.data?.provider ||
      raw?.provider ||
      raw?.metadata?.provider ||
      raw?.data?.provider ||
      null,

    rail:
      rail ||
      parsed?.rail ||
      parsed?.metadata?.rail ||
      parsed?.data?.rail ||
      raw?.rail ||
      raw?.metadata?.rail ||
      raw?.data?.rail ||
      null,

    eventId: pickEventId(parsed, raw),
    eventType: pickEventType(parsed, raw),

    providerStatus: normalizedStatus,
    status: normalizedStatus,

    amount:
      parsed?.amount ??
      parsed?.value ??
      parsed?.data?.amount ??
      raw?.amount ??
      raw?.value ??
      raw?.data?.amount ??
      null,

    currency:
      parsed?.currency ||
      parsed?.data?.currency ||
      raw?.currency ||
      raw?.data?.currency ||
      null,

    reason:
      parsed?.reason ||
      parsed?.error ||
      parsed?.message ||
      raw?.reason ||
      raw?.error ||
      raw?.message ||
      raw?.data?.reason ||
      raw?.data?.error ||
      raw?.data?.message ||
      parsed?.verificationReason ||
      null,

    verified: parsed?.verified !== false,
    verificationReason: parsed?.verificationReason || null,

    raw,
  };
}

function assertSettlementHasIdentifier(payload = {}) {
  if (payload.transactionId || payload.reference || payload.providerReference) {
    return;
  }

  throw createError(
    400,
    "Webhook provider sans identifiant transaction exploitable"
  );
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

    assertSettlementHasIdentifier(settlementPayload);

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
  providerWebhookTransaction: providerWebhookController,
};