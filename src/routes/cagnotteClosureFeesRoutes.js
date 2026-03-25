"use strict";

const express = require("express");
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

  const got = String(req.headers["x-internal-token"] || "").trim();

  if (!expected) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_INTERNAL_TOKEN non configuré.",
    });
  }

  if (!got || got !== expected) {
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

  body("treasuryUserId").optional().isString().trim().notEmpty(),
  body("treasurySystemType").optional().isString().trim().notEmpty(),
  body("treasuryLabel").optional().isString().trim(),

  body("feeCredit.amount").exists().isFloat({ gt: 0 }).toFloat(),
  body("feeCredit.currency").exists().isString().trim().isLength({ min: 3, max: 4 }),

  body("feeCredit.baseAmount").optional().isFloat({ min: 0 }).toFloat(),
  body("feeCredit.baseCurrencyCode")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 3, max: 4 }),

  body("meta").optional().isObject(),

  checkValidation,
  settleCagnotteClosureFees
);

module.exports = router;