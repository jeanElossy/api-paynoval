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

async function initiateByFlow(req, res, next) {
  try {
    const body = isTruthyObject(req.body) ? req.body : {};

    const funds = norm(body.funds);
    const destination = norm(body.destination);
    const provider = norm(body.provider);
    const method = norm(body.method);
    const txType = norm(body.txType);

    const reqLogger = req.logger || req.log || null;

    const hasInternalRails = funds === "paynoval" && destination === "paynoval";
    const hasInternalProvider = !provider || provider === "paynoval";
    const hasInternalMethod =
      !method || method === "paynoval" || method === "internal";
    const isInternalPaynoval =
      hasInternalRails && hasInternalProvider && hasInternalMethod;

    if (hasInternalRails && (!hasInternalProvider || !hasInternalMethod)) {
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
        userId: req.user?.id || null,
        ip: req.ip || null,
      });

      return initiateInternal(req, res, next);
    }

    const flow = resolveExternalFlow(body);

    if (!flow || typeof flow !== "string") {
      throw createError(400, "Flow transaction non supporté");
    }

    if (flow === "PAYNOVAL_TO_PAYNOVAL" || flow === "PAYNOVAL_INTERNAL_TRANSFER") {
      safeLog(reqLogger, "warn", "[TX FLOW] internal flow resolved as external candidate", {
        flow,
        funds,
        destination,
        provider,
        method,
        userId: req.user?.id || null,
      });

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
        userId: req.user?.id || null,
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
        userId: req.user?.id || null,
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
      userId: req.user?.id || null,
    });

    throw createError(400, "Flow transaction non supporté");
  } catch (err) {
    next(err);
  }
}

module.exports = { initiateByFlow };