"use strict";

const express = require("express");
const router = express.Router();

const {
  transferBonus,
} = require("../controllers/internalReferralController");

// POST /api/v1/internal/referral/transfer-bonus
router.post("/transfer-bonus", transferBonus);

module.exports = router;