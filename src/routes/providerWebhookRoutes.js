"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const { providerWebhookController } = require("../controllers/providerWebhookController");
const config = require("../config");

const router = express.Router();

function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || "").trim(), "utf8");
  const bb = Buffer.from(String(b || "").trim(), "utf8");
  if (!aa.length || !bb.length || aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function getInternalTokens() {
  const legacy = String(process.env.INTERNAL_TOKEN || config.internalToken || "").trim();

  const gateway = String(
    process.env.GATEWAY_INTERNAL_TOKEN || config?.internalTokens?.gateway || legacy
  ).trim();

  const principal = String(
    process.env.PRINCIPAL_INTERNAL_TOKEN ||
      process.env.INTERNAL_REFERRAL_TOKEN ||
      config?.internalTokens?.principal ||
      legacy
  ).trim();

  return { legacy, gateway, principal };
}

function getHeaderInternalToken(req) {
  const raw = req.headers["x-internal-token"] || "";
  return Array.isArray(raw) ? raw[0] : raw;
}

function isTrustedInternalCall(req) {
  const got = String(getHeaderInternalToken(req) || "").trim();
  if (!got) return false;

  const { gateway, principal, legacy } = getInternalTokens();
  const expected = [gateway, principal, legacy]
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  if (!expected.length) return false;

  return expected.some((exp) => timingSafeEqualStr(got, exp));
}

function buildWebhookRateKey(req) {
  const provider = String(req.params?.provider || req.body?.provider || "unknown").trim();
  const rail = String(req.params?.rail || req.body?.rail || "unknown").trim();

  const forwardedFor = req.headers["x-forwarded-for"];
  const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const ip =
    String(forwardedIp || "")
      .split(",")[0]
      .trim() || req.ip || "unknown-ip";

  return `${ip}:${rail}:${provider}`;
}

/**
 * Rate limit dédié webhook provider
 * - plus souple que le global
 * - JSON propre
 * - skip pour trusted internal calls
 */
const providerWebhookLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: Number(process.env.PROVIDER_WEBHOOK_RATE_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: buildWebhookRateKey,
  skip: (req) => isTrustedInternalCall(req),
  message: {
    success: false,
    error: "Trop de webhooks reçus, réessayez plus tard.",
  },
  handler: (_req, res, _next, options) => {
    return res.status(options.statusCode).json({
      success: false,
      error: "Trop de webhooks reçus, réessayez plus tard.",
    });
  },
});

router.use(providerWebhookLimiter);

/**
 * Route explicite recommandée
 * POST /webhooks/providers/:rail/:provider
 */
router.post("/:rail/:provider", providerWebhookController);

/**
 * Route courte si le rail peut être inféré
 * POST /webhooks/providers/:provider
 */
router.post("/:provider", providerWebhookController);

module.exports = router;