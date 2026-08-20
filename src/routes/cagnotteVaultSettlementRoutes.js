"use strict";

const express = require("express");
const {
  extractInternalToken,
  matchesAnyToken,
} = require("../utils/internalTokens");
const { body, validationResult } = require("express-validator");
const {
  settleCagnotteVaultWithdrawal,
} = require("../controllers/cagnotteVaultWithdrawalSettlementController");

const router = express.Router();

function verifyInternalToken(req, res, next) {
  const expected = String(
    process.env.TX_CORE_INTERNAL_TOKEN ||
      process.env.INTERNAL_TX_TOKEN ||
      process.env.INTERNAL_TOKEN ||
      ""
  ).trim();

  /**
   * ⚠️ La comparaison était un `!==` simple : le temps de réponse variait avec
   * la longueur du préfixe commun, ce qui rend le jeton devinable caractère par
   * caractère par une mesure statistique. `matchesAnyToken` (utils/internalTokens)
   * compare en temps constant, et c'est la MÊME implémentation que le reste du
   * service — le dépôt comptait quatre façons différentes de répondre à « ce
   * jeton est-il valide ? », ce qui garantissait qu'elles divergeraient.
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
      errors: errors.array(),
    });
  }
  return next();
}

router.post(
  "/vault-withdrawals/settle",
  verifyInternalToken,

  body("reference")
    .exists()
    .isString()
    .trim()
    .isLength({ min: 8, max: 200 }),

  body("idempotencyKey")
    .exists()
    .isString()
    .trim()
    .isLength({ min: 8, max: 200 }),

  body("userId")
    .exists()
    .isString()
    .trim()
    .notEmpty(),

  body("vaultId")
    .exists()
    .isString()
    .trim()
    .notEmpty(),

  body("cagnotteId")
    .exists()
    .isString()
    .trim()
    .notEmpty(),

  body("mode")
    .exists()
    .isString()
    .trim()
    .isIn(["full", "partial"]),

  body("credit.amount")
    .exists()
    .isFloat({ gt: 0 })
    .toFloat(),

  body("credit.currency")
    .exists()
    .isString()
    .trim()
    .isLength({ min: 3, max: 4 }),

  body("treasuryUserId")
    .optional()
    .isString()
    .trim()
    .notEmpty(),

  body("treasurySystemType")
    .optional()
    .isString()
    .trim()
    .notEmpty(),

  body("treasuryLabel")
    .optional()
    .isString()
    .trim(),

  body("cagnotteName")
    .optional()
    .isString()
    .trim(),

  body("feeDebit.amount")
    .optional()
    .isFloat({ min: 0 })
    .toFloat(),

  body("feeDebit.currency")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 3, max: 4 }),

  body("feeDebit.baseAmount")
    .optional()
    .isFloat({ min: 0 })
    .toFloat(),

  body("feeDebit.baseCurrencyCode")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 3, max: 4 }),

  body("meta")
    .optional()
    .isObject(),

  checkValidation,
  settleCagnotteVaultWithdrawal
);

module.exports = router;