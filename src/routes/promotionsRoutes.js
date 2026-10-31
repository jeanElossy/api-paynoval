"use strict";

/** POST /api/v1/promotions/preview — the discount a client would get. */

const express = require("express");
const rateLimit = require("express-rate-limit");

const { protect } = require("../middleware/authMiddleware");
const { previewPromotion } = require("../services/promotions/promotionRedemption");

const router = express.Router();

// Guessing codes must stay slow.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const id = req.user?._id || req.user?.id;
    return id ? `u:${String(id)}` : `ip:${req.ip || "inconnu"}`;
  },
});

router.post("/preview", protect, limiter, async (req, res) => {
  try {
    const data = await previewPromotion({
      code: req.body?.code,
      userId: String(req.user._id || req.user.id),
      fee: Number(req.body?.fee),
      currency: req.body?.currency,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      code: err.code || "PROMO_UNAVAILABLE",
      message: err.status ? err.message : "Vérification du code indisponible, réessayez.",
    });
  }
});

module.exports = router;
