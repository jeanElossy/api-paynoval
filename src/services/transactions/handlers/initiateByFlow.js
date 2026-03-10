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

async function initiateByFlow(req, res, next) {
  try {
    const body = req.body || {};
    const funds = String(body.funds || "").trim().toLowerCase();
    const destination = String(body.destination || "").trim().toLowerCase();

    if (funds === "paynoval" && destination === "paynoval") {
      return initiateInternal(req, res, next);
    }

    const flow = resolveExternalFlow(body);

    if (isOutboundExternalFlow(flow)) {
      return initiateOutboundExternal(req, res, next);
    }

    if (isInboundExternalFlow(flow)) {
      return initiateInboundExternal(req, res, next);
    }

    throw createError(400, "Flow transaction non supporté");
  } catch (err) {
    next(err);
  }
}

module.exports = { initiateByFlow };