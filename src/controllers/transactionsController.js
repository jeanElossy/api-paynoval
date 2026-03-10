"use strict";

const { listInternal } = require("../services/transactions/handlers/listInternal");
const { getTransactionController } = require("../services/transactions/handlers/getTransaction");
const { initiateInternal } = require("../services/transactions/handlers/initiateInternal");
const { initiateByFlow } = require("../services/transactions/handlers/initiateByFlow");
const {
  initiateOutboundExternal,
  initiateInboundExternal,
} = require("../services/transactions/handlers/initiateExternalTransactions");
const { confirmController } = require("../services/transactions/handlers/confirmTransaction");
const { cancelController } = require("../services/transactions/handlers/cancelTransaction");
const {
  refundController,
  validateController,
  reassignController,
  archiveController,
  relaunchController,
} = require("../services/transactions/handlers/adminActions");
const {
  settleExternalTransactionWebhook,
} = require("../services/transactions/handlers/providerWebhookTransactions");

function safeLog(level, message, meta = {}) {
  try {
    const line = `${message} ${JSON.stringify(meta || {})}`;
    if (level === "error") return console.error(line);
    if (level === "warn") return console.warn(line);
    console.log(line);
  } catch {
    console.log(message);
  }
}

function wrapController(name, handler) {
  return async (req, res, next) => {
    try {
      safeLog("info", `[TX Controller] ${name} called`, {
        params: req?.params || {},
        query: req?.query || {},
        body: req?.body || {},
        userId: req?.user?.id || req?.user?._id || null,
        ip: req?.ip || null,
      });

      return await handler(req, res, next);
    } catch (err) {
      safeLog("error", `[TX Controller] ${name} failed`, {
        message: err?.message,
        status: err?.status || err?.statusCode || err?.response?.status || 500,
        stack: err?.stack,
        params: req?.params || {},
        query: req?.query || {},
        body: req?.body || {},
        userId: req?.user?.id || req?.user?._id || null,
        ip: req?.ip || null,
      });
      return next(err);
    }
  };
}

exports.listInternal = wrapController("listInternal", listInternal);
exports.getTransactionController = wrapController(
  "getTransactionController",
  getTransactionController
);

exports.initiateInternal = wrapController("initiateInternal", initiateInternal);
exports.initiateByFlow = wrapController("initiateByFlow", initiateByFlow);
exports.initiateOutboundExternal = wrapController(
  "initiateOutboundExternal",
  initiateOutboundExternal
);
exports.initiateInboundExternal = wrapController(
  "initiateInboundExternal",
  initiateInboundExternal
);

exports.confirmController = wrapController("confirmController", confirmController);
exports.cancelController = wrapController("cancelController", cancelController);

exports.refundController = wrapController("refundController", refundController);
exports.validateController = wrapController("validateController", validateController);
exports.reassignController = wrapController("reassignController", reassignController);
exports.archiveController = wrapController("archiveController", archiveController);
exports.relaunchController = wrapController("relaunchController", relaunchController);

exports.settleExternalTransactionWebhook = wrapController(
  "settleExternalTransactionWebhook",
  settleExternalTransactionWebhook
);