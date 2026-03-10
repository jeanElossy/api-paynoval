"use strict";

const createError = require("http-errors");

const { initiateInternal } = require("./initiateInternal");
const {
  initiateOutboundExternal,
  initiateInboundExternal,
} = require("./initiateExternalTransactions");
const {
  resolveExternalFlow,
  isOutboundExternalFlow,
  isInboundExternalFlow,
} = require("./flowHelpers");

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function isTruthyObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeLog(logger, level, message, meta = {}) {
  try {
    const payload = isTruthyObject(meta) ? meta : {};
    if (logger && typeof logger[level] === "function") {
      logger[level](message, payload);
      return;
    }
    const line = `${message} ${JSON.stringify(payload)}`;
    if (level === "error") return console.error(line);
    if (level === "warn") return console.warn(line);
    console.log(line);
  } catch {
    console.log(message);
  }
}

function isInternalMethod(method) {
  const m = norm(method);
  return !m || m === "paynoval" || m === "internal";
}

function isInternalProvider(provider) {
  const p = norm(provider);
  return !p || p === "paynoval";
}

function buildDebugBody(body = {}) {
  return {
    funds: body?.funds,
    destination: body?.destination,
    provider: body?.provider,
    method: body?.method,
    txType: body?.txType,
    pricingId: body?.pricingId,
    quoteId: body?.quoteId,
    effectivePricingId: body?.effectivePricingId,
    country: body?.country,
    fromCountry: body?.fromCountry,
    toCountry: body?.toCountry,
    sourceCountry: body?.sourceCountry,
    destinationCountry: body?.destinationCountry,
    toEmail: body?.toEmail,
    securityQuestion: body?.securityQuestion,
    securityAnswer: body?.securityAnswer ? "***" : undefined,
    amount: body?.amount,
    amountSource: body?.amountSource,
    amountTarget: body?.amountTarget,
    currency: body?.currency,
    currencySource: body?.currencySource,
    currencyTarget: body?.currencyTarget,
    meta: body?.meta,
  };
}

async function initiateByFlow(req, res, next) {
  try {
    const body = isTruthyObject(req.body) ? req.body : {};

    const funds = norm(body.funds);
    const destination = norm(body.destination);
    const provider = norm(body.provider);
    const method = norm(body.method);
    const txType = norm(body.txType);

    const reqLogger = req.logger || req.log || null;

    safeLog(reqLogger, "info", "[TX FLOW] initiateByFlow received", {
      body: buildDebugBody(body),
      userId: req.user?.id || req.user?._id || null,
      ip: req.ip || null,
    });

    const hasInternalRails = funds === "paynoval" && destination === "paynoval";
    const hasInternalProvider = isInternalProvider(provider);
    const hasInternalMethod = isInternalMethod(method);

    const isInternalPaynoval =
      hasInternalRails && hasInternalProvider && hasInternalMethod;

    if (hasInternalRails && (!hasInternalProvider || !hasInternalMethod)) {
      safeLog(reqLogger, "warn", "[TX FLOW] ambiguous internal payload", {
        funds,
        destination,
        provider,
        method,
        txType,
        body: buildDebugBody(body),
      });

      throw createError(
        400,
        "Payload ambigu: flow PayNoval interne avec provider/method incompatibles"
      );
    }

    if (isInternalPaynoval) {
      safeLog(reqLogger, "info", "[TX FLOW] internal flow detected", {
        funds,
        destination,
        provider: provider || "paynoval",
        method: method || "internal",
        txType: txType || "transfer",
        quoteId: body?.quoteId || null,
        pricingId: body?.pricingId || null,
        effectivePricingId:
          body?.effectivePricingId || body?.pricingId || body?.quoteId || null,
        userId: req.user?.id || req.user?._id || null,
        ip: req.ip || null,
      });

      return initiateInternal(req, res, next);
    }

    const flow = resolveExternalFlow(body);

    if (!flow || typeof flow !== "string") {
      safeLog(reqLogger, "warn", "[TX FLOW] unresolved flow", {
        funds,
        destination,
        provider,
        method,
        txType,
        body: buildDebugBody(body),
      });

      throw createError(400, "Flow transaction non supporté");
    }

    if (
      flow === "PAYNOVAL_TO_PAYNOVAL" ||
      flow === "PAYNOVAL_INTERNAL_TRANSFER"
    ) {
      safeLog(
        reqLogger,
        "warn",
        "[TX FLOW] internal flow resolved as external candidate",
        {
          flow,
          funds,
          destination,
          provider,
          method,
          userId: req.user?.id || req.user?._id || null,
          body: buildDebugBody(body),
        }
      );

      throw createError(
        400,
        "Flow interne détecté mais payload/mapping incohérent"
      );
    }

    if (isOutboundExternalFlow(flow)) {
      safeLog(reqLogger, "info", "[TX FLOW] outbound external flow detected", {
        flow,
        funds,
        destination,
        provider,
        method,
        txType,
        userId: req.user?.id || req.user?._id || null,
        ip: req.ip || null,
      });

      return initiateOutboundExternal(req, res, next);
    }

    if (isInboundExternalFlow(flow)) {
      safeLog(reqLogger, "info", "[TX FLOW] inbound external flow detected", {
        flow,
        funds,
        destination,
        provider,
        method,
        txType,
        userId: req.user?.id || req.user?._id || null,
        ip: req.ip || null,
      });

      return initiateInboundExternal(req, res, next);
    }

    safeLog(reqLogger, "warn", "[TX FLOW] unsupported flow", {
      flow,
      funds,
      destination,
      provider,
      method,
      txType,
      userId: req.user?.id || req.user?._id || null,
      body: buildDebugBody(body),
    });

    throw createError(400, "Flow transaction non supporté");
  } catch (err) {
    const reqLogger = req.logger || req.log || null;

    safeLog(reqLogger, "error", "[TX FLOW] initiateByFlow failed", {
      message: err?.message,
      status: err?.status || err?.statusCode || 500,
      stack: err?.stack,
      body: buildDebugBody(req.body || {}),
      userId: req.user?.id || req.user?._id || null,
      ip: req.ip || null,
    });

    next(err);
  }
}

module.exports = { initiateByFlow };