// File: routes/internalCancelRefund.routes.js

"use strict";

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

/**
 * Comparaison à temps constant — UNE SEULE implémentation pour tout le service.
 *
 * Il en existait trois jusqu'au 2026-09-03, et les deux copies locales
 * retournaient tôt sur une différence de longueur :
 *
 *     if (left.length !== right.length) return false;   // ← la fuite
 *
 * Ce retour anticipé rend le temps de réponse dépendant de la LONGUEUR du
 * secret attendu : un appelant non authentifié peut la mesurer statistiquement,
 * ce qui réduit d'autant l'espace à explorer. `utils/internalTokens.js` complète
 * les tampons par des zéros AVANT de comparer, puis vérifie l'égalité des
 * longueurs — l'ordre est ce qui fait la propriété.
 *
 * Même geste que `requireRole.js` côté passerelle : un doublon divergent sur un
 * chemin d'autorisation finit toujours par diverger du mauvais côté.
 */
const { timingSafeEqualStr } = require("../utils/internalTokens");

function safeCompare(a, b) {
  return timingSafeEqualStr(a, b);
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