// File: routes/internalAdminTransactions.routes.js

"use strict";

const crypto = require("crypto");
const express = require("express");
const createError = require("http-errors");

const {
  listInternalAdminTransactions,
  getInternalAdminTransactionById,
} = require("../controllers/internalAdminTransactions.controller");

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

  if (left.length !== right.length) return false;

  return crypto.timingSafeEqual(left, right);
}

/**
 * Sécurité interne.
 * Seul le backend principal doit appeler ces routes.
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
 * GET /api/v1/internal/admin/transactions
 */
router.get(
  "/internal/admin/transactions",
  requireInternalToken,
  listInternalAdminTransactions
);

/**
 * GET /api/v1/internal/admin/transactions/:id
 */
router.get(
  "/internal/admin/transactions/:id",
  requireInternalToken,
  getInternalAdminTransactionById
);

module.exports = router;