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

function requireInternalToken(req, _res, next) {
  const expectedToken = getExpectedInternalToken();

  const receivedToken = String(
    req.headers["x-internal-token"] ||
      req.headers["x-paynoval-internal-token"] ||
      req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
      ""
  ).trim();

  console.log(
    "[TX-CORE][INTERNAL ADMIN TX][AUTH] Vérification token",
    JSON.stringify({
      path: req.originalUrl,
      method: req.method,
      expectedTokenPresent: !!expectedToken,
      expectedTokenLength: expectedToken.length,
      receivedTokenPresent: !!receivedToken,
      receivedTokenLength: receivedToken.length,
    })
  );

  if (!expectedToken) {
    return next(
      createError(
        500,
        "TX_CORE_INTERNAL_TOKEN manquant dans la configuration tx-core"
      )
    );
  }

  if (!receivedToken || !safeCompare(receivedToken, expectedToken)) {
    console.warn(
      "[TX-CORE][INTERNAL ADMIN TX][AUTH] Token interne invalide",
      JSON.stringify({
        path: req.originalUrl,
        method: req.method,
        receivedTokenPresent: !!receivedToken,
        receivedTokenLength: receivedToken.length,
      })
    );

    return next(createError(401, "Token interne invalide"));
  }

  console.log(
    "[TX-CORE][INTERNAL ADMIN TX][AUTH] Token interne OK",
    JSON.stringify({
      path: req.originalUrl,
      method: req.method,
    })
  );

  return next();
}

router.get(
  "/internal/admin/transactions",
  requireInternalToken,
  listInternalAdminTransactions
);

router.get(
  "/internal/admin/transactions/:id",
  requireInternalToken,
  getInternalAdminTransactionById
);

module.exports = router;