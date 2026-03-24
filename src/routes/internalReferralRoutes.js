"use strict";

const express = require("express");
const router = express.Router();

const {
  transferBonus,
} = require("../controllers/internalReferralController");

router.post("/transfer-bonus", transferBonus);

module.exports = router;