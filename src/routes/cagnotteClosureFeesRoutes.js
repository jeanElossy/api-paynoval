"use strict";

const express = require("express");
const {
  extractInternalToken,
  matchesAnyToken,
} = require("../utils/internalTokens");
const { body, validationResult } = require("express-validator");
const {
  settleCagnotteClosureFees,
} = require("../controllers/cagnotteClosureFeesSettlementController");

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
  "/closure-fees/settle",
  verifyInternalToken,

  body("reference").exists().isString().trim().isLength({ min: 8, max: 200 }),
  body("idempotencyKey").exists().isString().trim().isLength({ min: 8, max: 200 }),

  body("cagnotteId").exists().isString().trim().notEmpty(),
  body("vaultId").exists().isString().trim().notEmpty(),
  body("initiatedByUserId").exists().isString().trim().notEmpty(),

  /**
   * Plus aucun montant accepté : Tx-Core calcule les frais de clôture sur la
   * position du coffre (règle `CAGNOTTE_CLOSURE`). Un `feeCredit` envoyé par
   * un appelant resté en ancienne version est refusé en 410 par le contrôleur,
   * pas ignoré en silence.
   */
  body("cagnotteName").optional().isString().trim().isLength({ max: 120 }),

  checkValidation,
  settleCagnotteClosureFees
);

module.exports = router;