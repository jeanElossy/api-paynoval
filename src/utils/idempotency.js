// File: utils/idempotency.js
"use strict";

const crypto = require("crypto");

function sha256Hex(v) {
  return crypto.createHash("sha256").update(String(v || ""), "utf8").digest("hex");
}

/**
 * Derive a deterministic idempotencyKey if client doesn't provide one.
 * Important: keep stable keys only.
 */
function buildIdempotencyKeyFromBody({ senderId, toEmail, amount, currencySource, currencyTarget, country, destination, funds }) {
  const raw = [
    senderId || "",
    String(toEmail || "").trim().toLowerCase(),
    String(amount ?? "").trim(),
    String(currencySource || "").trim().toUpperCase(),
    String(currencyTarget || "").trim().toUpperCase(),
    String(country || "").trim().toUpperCase(),
    String(destination || "").trim().toLowerCase(),
    String(funds || "").trim().toLowerCase(),
  ].join("|");

  return sha256Hex(raw);
}

function pickIdempotencyKey(req) {
  const h =
    req.headers["idempotency-key"] ||
    req.headers["x-idempotency-key"] ||
    req.headers["x-request-id"] ||
    null;

  const bodyKey = req.body?.idempotencyKey || req.body?.metadata?.idempotencyKey || null;
  const k = String(bodyKey || h || "").trim();
  return k || null;
}

module.exports = {
  buildIdempotencyKeyFromBody,
  pickIdempotencyKey,
};
