"use strict";

/**
 * Staff 2FA on Tx-Core admin actions (2026-10-18). Same rule file as the
 * backend (byte-identical), applied by requireRole and authz. Fixed dates.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { staffTwoFactorVerdict } = require("../src/services/staffTwoFactor");

test("verdicts", () => {
  const enforceFrom = new Date("2026-10-25T00:00:00Z");
  assert.equal(staffTwoFactorVerdict({ role: "admin", twoFaEnabled: false, now: Date.parse("2026-10-20T00:00:00Z"), enforceFrom }), "grace");
  assert.equal(staffTwoFactorVerdict({ role: "admin", twoFaEnabled: false, now: Date.parse("2026-10-26T00:00:00Z"), enforceFrom }), "blocked");
  assert.equal(staffTwoFactorVerdict({ role: "user", twoFaEnabled: false, now: 0, enforceFrom }), "not_staff");
});

test("requireRole refuses an admin without 2FA past the date", () => {
  const old = process.env.STAFF_2FA_ENFORCE_FROM;
  process.env.STAFF_2FA_ENFORCE_FROM = "2000-01-01T00:00:00Z";
  try {
    const requireRole = require("../src/middleware/requireRole");
    const res = { statusCode: 200, body: null, setHeader() {}, status(s) { this.statusCode = s; return this; }, json(b) { this.body = b; return this; } };
    let passed = false;
    requireRole(["admin"])({ user: { role: "admin", twoFaEnabled: false } }, res, () => { passed = true; });
    assert.equal(passed, false);
    assert.equal(res.body.code, "STAFF_2FA_REQUIRED");
  } finally {
    if (old === undefined) delete process.env.STAFF_2FA_ENFORCE_FROM;
    else process.env.STAFF_2FA_ENFORCE_FROM = old;
  }
});

test("the rule file is the backend's, byte for byte", () => {
  const backend = path.join(__dirname, "..", "..", "paynoval-backend", "services", "staffTwoFactor.js");
  if (!fs.existsSync(backend)) return;
  assert.equal(fs.readFileSync(path.join(__dirname, "..", "src", "services", "staffTwoFactor.js"), "utf8"), fs.readFileSync(backend, "utf8"));
});

test("req.user carries the 2FA flag", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "middleware", "authMiddleware.js"), "utf8");
  assert.match(src, /twoFaEnabled: userDoc\.twoFaEnabled === true/);
});
