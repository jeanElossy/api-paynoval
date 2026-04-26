// File: routes/internalCancelRefund.routes.js

"use strict";

const crypto = require("crypto");
const express = require("express");
const createError = require("http-errors");

const {
  adminCancelRefundController,
} = require("../controllers/adminCancelRefund.controller");

const router = express.Router();

function getExpectedInternalToken() {
  return String(
    process.env.TX_CORE_INTERNAL_TOKEN ||
      process.env.INTERNAL_API_TOKEN ||
      process.env.PAYNOVAL_INTERNAL_TOKEN ||
      ""
  ).trim();
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

/**
 * Sécurité interne tx-core.
 *
 * Le backend principal doit appeler cet endpoint avec :
 * x-internal-token: <TX_CORE_INTERNAL_TOKEN>
 */
function requireInternalToken(req, _res, next) {
  const expectedToken = getExpectedInternalToken();

  if (!expectedToken) {
    return next(
      createError(
        500,
        "TX_CORE_INTERNAL_TOKEN manquant dans la configuration tx-core"
      )
    );
  }

  const receivedToken = String(
    req.headers["x-internal-token"] ||
      req.headers["x-paynoval-internal-token"] ||
      req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
      ""
  ).trim();

  if (!receivedToken || !safeCompare(receivedToken, expectedToken)) {
    return next(createError(401, "Token interne invalide"));
  }

  return next();
}

/**
 * POST /api/v1/internal/transactions/:transactionId/cancel-refund
 */
router.post(
  "/internal/transactions/:transactionId/cancel-refund",
  requireInternalToken,
  adminCancelRefundController
);

module.exports = router;