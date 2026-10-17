"use strict";

/**
 * GET /api/v1/limits — les plafonds du client connecté (2026-10-17).
 */

const express = require("express");
const rateLimit = require("express-rate-limit");
const { query } = require("express-validator");

const { protect } = require("../middleware/authMiddleware");
const requestValidator = require("../middleware/requestValidator");
const { getMyLimits } = require("../controllers/limitsController");

const router = express.Router();

const limiteurLecture = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const id = req.user?._id || req.user?.id;
    return id ? `u:${String(id)}` : `ip:${req.ip || "inconnu"}`;
  },
  message: { success: false, code: "RATE_LIMITED", error: "Trop de demandes. Réessayez dans un instant." },
});

router.get(
  "/",
  protect,
  limiteurLecture,
  query("currency").isString().trim().toUpperCase().matches(/^[A-Z]{3}$/).withMessage("Devise ISO 4217 requise."),
  requestValidator,
  getMyLimits
);

module.exports = router;
