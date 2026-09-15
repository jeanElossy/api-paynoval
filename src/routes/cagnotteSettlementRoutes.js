"use strict";

/**
 * Routes internes de participation à une cagnotte (appelées par le backend
 * principal seul, jeton interne en temps constant).
 *
 *   POST /participation/quote      devis figé — passe par l'AML existant
 *   POST /participation/settle     règlement d'un devis
 *   POST /participation/refund     contre-écriture au taux d'origine
 *   POST /vaults/open              position du coffre, devise figée
 *   GET  /vaults/:vaultId/position lecture pour la réconciliation
 */

const express = require("express");
const {
  extractInternalToken,
  matchesAnyToken,
} = require("../utils/internalTokens");
const { body, param, validationResult } = require("express-validator");
const amlMiddleware = require("../middleware/aml");
const {
  attachCagnotteParticipant,
  quoteCagnotteParticipation,
  settleCagnotteParticipation,
  refundCagnotteParticipation,
  openCagnotteVaultPosition,
  getCagnotteVaultPosition,
} = require("../controllers/cagnotteSettlementController");

const router = express.Router();

function verifyInternalToken(req, res, next) {
  const expected = String(
    process.env.TX_CORE_INTERNAL_TOKEN ||
      process.env.INTERNAL_TX_TOKEN ||
      process.env.INTERNAL_TOKEN ||
      ""
  ).trim();

  /**
   * Comparaison en temps constant via `utils/internalTokens` — la MÊME
   * implémentation que le reste du service.
   */
  const got = extractInternalToken(req);

  if (!expected) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_INTERNAL_TOKEN non configuré.",
    });
  }

  if (!matchesAnyToken(got, [expected])) {
    return res.status(401).json({
      success: false,
      error: "Non autorisé.",
    });
  }

  return next();
}

function checkValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      code: "VALIDATION_ERROR",
      errors: errors.array(),
    });
  }
  return next();
}

const currencyField = (name) =>
  body(name).exists().isString().trim().isLength({ min: 3, max: 3 }).isAlpha().toUpperCase();

const idField = (name) => body(name).exists().isString().trim().isLength({ min: 1, max: 64 });

router.post(
  "/participation/quote",
  verifyInternalToken,
  body("userId").exists().isMongoId(),
  idField("cagnotteId"),
  idField("vaultId"),
  currencyField("cagnotteCurrency"),
  body("amount").exists().isFloat({ gt: 0 }).toFloat(),
  checkValidation,
  attachCagnotteParticipant,
  amlMiddleware,
  quoteCagnotteParticipation
);

router.post(
  "/participation/settle",
  verifyInternalToken,
  body("quoteId").optional().isString().trim().isLength({ min: 8, max: 64 }),
  body("reference").exists().isString().trim().isLength({ min: 8, max: 200 }),
  body("idempotencyKey").exists().isString().trim().isLength({ min: 8, max: 200 }),
  body("userId").exists().isMongoId(),
  idField("cagnotteId"),
  idField("vaultId"),
  body("cagnotteCurrency").optional().isString().trim().isLength({ min: 3, max: 3 }).toUpperCase(),
  body("goalCap").optional({ nullable: true }).isFloat({ gt: 0 }).toFloat(),
  body("replayOnly").optional().isBoolean().toBoolean(),
  checkValidation,
  settleCagnotteParticipation
);

router.post(
  "/participation/refund",
  verifyInternalToken,
  body("reference").exists().isString().trim().isLength({ min: 8, max: 200 }),
  body("idempotencyKey").exists().isString().trim().isLength({ min: 8, max: 200 }),
  body("participationReference").exists().isString().trim().isLength({ min: 8, max: 200 }),
  body("initiatedByUserId").exists().isString().trim().isLength({ min: 1, max: 64 }),
  body("amount").optional({ nullable: true }).isFloat({ gt: 0 }).toFloat(),
  body("reason").optional().isString().trim().isLength({ max: 500 }),
  checkValidation,
  refundCagnotteParticipation
);

router.post(
  "/vaults/open",
  verifyInternalToken,
  idField("vaultId"),
  idField("cagnotteId"),
  currencyField("currency"),
  checkValidation,
  openCagnotteVaultPosition
);

router.get(
  "/vaults/:vaultId/position",
  verifyInternalToken,
  param("vaultId").isString().trim().isLength({ min: 1, max: 64 }),
  checkValidation,
  getCagnotteVaultPosition
);

module.exports = router;
