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

/* ------------------------------------------------- governance (2026-10-20) */

function withEnforcement(iso, fn) {
  const old = process.env.STAFF_2FA_ENFORCE_FROM;
  process.env.STAFF_2FA_ENFORCE_FROM = iso;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.STAFF_2FA_ENFORCE_FROM;
    else process.env.STAFF_2FA_ENFORCE_FROM = old;
  }
}

test("limit policy governance refuses a staff account without 2FA past the date", () => {
  const { assertLimitStaff } = require("../src/services/limits/limitPolicyService");
  withEnforcement("2000-01-01T00:00:00Z", () => {
    assert.throws(() => assertLimitStaff({ _id: "a", role: "compliance", twoFaEnabled: false }), (e) => e.code === "STAFF_2FA_REQUIRED" && e.status === 403);
    assert.doesNotThrow(() => assertLimitStaff({ _id: "a", role: "compliance", twoFaEnabled: true }));
  });
  withEnforcement("2999-01-01T00:00:00Z", () => {
    assert.doesNotThrow(() => assertLimitStaff({ _id: "a", role: "admin", twoFaEnabled: false }), "grace period: allowed");
  });
});

test("pricing governance refuses a staff account without 2FA past the date", () => {
  const { assertStaffRole } = require("../src/services/pricing/governanceRules");
  withEnforcement("2000-01-01T00:00:00Z", () => {
    assert.throws(() => assertStaffRole({ _id: "a", role: "admin", twoFaEnabled: false }), (e) => e.code === "STAFF_2FA_REQUIRED" && e.status === 403);
    assert.doesNotThrow(() => assertStaffRole({ _id: "a", role: "superadmin", twoFaEnabled: true }));
    // A role refusal stays a role refusal.
    assert.throws(() => assertStaffRole({ _id: "a", role: "support", twoFaEnabled: false }), (e) => e.code !== "STAFF_2FA_REQUIRED");
  });
});

test("the pricing controller relays the machine code of a 4xx", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "controllers", "pricing", "pricingChangeRequestsController.js"), "utf8");
  assert.match(src, /err\?\.code \|\| null/);
});
