"use strict";

const express = require("express");
const { body, validationResult } = require("express-validator");
const { settleCagnotteParticipation } = require("../controllers/cagnotteSettlementController");

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
  "/participation/settle",
  verifyInternalToken,
  body("reference").exists().isString().trim().isLength({ min: 8, max: 200 }),
  body("idempotencyKey").exists().isString().trim().isLength({ min: 8, max: 200 }),
  body("userId").exists().isString().trim().notEmpty(),
  body("adminUserId").exists().isString().trim().notEmpty(),
  body("payer.amount").exists().isFloat({ gt: 0 }).toFloat(),
  body("payer.currency").exists().isString().trim().isLength({ min: 3, max: 4 }),
  body("feeCredit.amount").optional().isFloat({ min: 0 }).toFloat(),
  body("feeCredit.currency").optional().isString().trim().isLength({ min: 3, max: 4 }),
  checkValidation,
  settleCagnotteParticipation
);

module.exports = router;