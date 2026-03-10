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
    const provider = String(body.provider || "").trim().toLowerCase();
    const method = String(body.method || "").trim().toLowerCase();

    const isInternalPaynoval =
      funds === "paynoval" &&
      destination === "paynoval" &&
      (!provider || provider === "paynoval") &&
      (!method || method === "paynoval");

    if (isInternalPaynoval) {
      console.log("[TX FLOW] Internal PayNoval -> PayNoval detected");
      return initiateInternal(req, res, next);
    }

    const flow = resolveExternalFlow(body);

    if (isOutboundExternalFlow(flow)) {
      console.log("[TX FLOW] External flow detected:", flow);
      return initiateOutboundExternal(req, res, next);
    }

    if (isInboundExternalFlow(flow)) {
      console.log("[TX FLOW] External flow detected:", flow);
      return initiateInboundExternal(req, res, next);
    }

    throw createError(400, "Flow transaction non supporté");
  } catch (err) {
    next(err);
  }
}

module.exports = { initiateByFlow };