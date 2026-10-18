"use strict";

/**
 * Per-account limits are APPLIED (2026-10-18). Before, the back office let an
 * admin "cap" an account and nothing enforced it.
 *
 *   · lower than the policy  ⇒ applies at once;
 *   · higher than the policy ⇒ applies only once approved by ANOTHER person,
 *     for this exact revision;
 *   · other currency ⇒ does not apply (no invented conversion);
 *   · unreadable ⇒ the operation is refused (fail closed).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { readAccountLimits, applyAccountLimits } = require("../../src/services/limits/accountLimits");
const { createLimitService } = require("../../src/services/limits/limitService");
const { DEFAULT_LIMITS } = require("../../src/services/limits/limitCatalog");

const POLICY = { operation: "WITHDRAW", rail: "mobilemoney", currency: "XOF", perTransaction: 500_000, rolling24h: 2_000_000, rolling30d: 10_000_000 };

test("nothing set ⇒ no override", () => {
  assert.equal(readAccountLimits(null, "XOF"), null);
  assert.equal(readAccountLimits({ daily: null, monthly: null, perTransaction: null }, "XOF"), null);
});

test("a LOWER value applies at once, without approval", () => {
  const acc = readAccountLimits({ daily: 100_000, currency: "XOF", revision: 1, updatedBy: "a" }, "XOF");
  const eff = applyAccountLimits(POLICY, acc);
  assert.equal(eff.rolling24h, 100_000);
  assert.equal(eff.sources.rolling24h, "account");
  assert.equal(eff.perTransaction, 500_000);
  assert.equal(eff.elevationPending, false);
});

test("a HIGHER value is ignored until approved by another person", () => {
  const raw = { perTransaction: 900_000, currency: "XOF", revision: 2, updatedBy: "a" };
  const pending = applyAccountLimits(POLICY, readAccountLimits(raw, "XOF"));
  assert.equal(pending.perTransaction, 500_000);
  assert.equal(pending.elevationPending, true);

  const selfApproved = readAccountLimits({ ...raw, approvedBy: "a", approvedAt: new Date(), approvedRevision: 2 }, "XOF");
  assert.equal(applyAccountLimits(POLICY, selfApproved).perTransaction, 500_000, "four eyes: the author cannot approve");

  const stale = readAccountLimits({ ...raw, approvedBy: "b", approvedAt: new Date(), approvedRevision: 1 }, "XOF");
  assert.equal(applyAccountLimits(POLICY, stale).perTransaction, 500_000, "an edit voids the approval");

  const approved = readAccountLimits({ ...raw, approvedBy: "b", approvedAt: new Date(), approvedRevision: 2 }, "XOF");
  const eff = applyAccountLimits(POLICY, approved);
  assert.equal(eff.perTransaction, 900_000);
  assert.equal(eff.sources.perTransaction, "account_elevated");
});

test("an override in another currency does not apply", () => {
  const acc = readAccountLimits({ daily: 10, currency: "EUR", revision: 1 }, "EUR");
  assert.equal(applyAccountLimits(POLICY, acc).rolling24h, 2_000_000);
});

test("missing override currency ⇒ the account currency", () => {
  assert.equal(readAccountLimits({ daily: 10 }, "xof").currency, "XOF");
});

function service(loadAccount, rows = []) {
  return createLimitService({
    now: () => Date.parse("2026-10-18T12:00:00Z"),
    loadAccount,
    policyService: { getActivePolicy: async () => ({ limits: DEFAULT_LIMITS, version: 0, source: "default" }) },
    models: { Transaction: { find: () => ({ select: () => ({ lean: async () => rows }) }) }, CagnotteSettlement: null },
  });
}

test("the engine REFUSES an operation above the account cap", async () => {
  const s = service(async () => readAccountLimits({ perTransaction: 1000, currency: "XOF", revision: 1, updatedBy: "a" }, "XOF"));
  const out = await s.checkLimit({ userId: "u", operation: "WITHDRAW", rail: "mobilemoney", currency: "XOF", amount: 1001 });
  assert.equal(out.allowed, false);
  assert.equal(out.code, "LIMIT_PER_TRANSACTION");
  assert.equal(out.limitSources.perTransaction, "account");
});

test("'Mes plafonds' shows the account cap and its source — the screen and the refusal agree", async () => {
  const s = service(async () => readAccountLimits({ daily: 5000, currency: "XOF", revision: 1, updatedBy: "a" }, "XOF"));
  const d = await s.describeLimits({ userId: "u", currency: "XOF" });
  const w = d.limits.find((l) => l.operation === "WITHDRAW" && l.rail === "mobilemoney");
  assert.equal(w.daily.limit, 5000);
  assert.equal(w.sources.rolling24h, "account");
});

test("unreadable account limits ⇒ the check throws (the AML middleware refuses in 503)", async () => {
  const s = service(async () => { throw new Error("users db down"); });
  await assert.rejects(s.checkLimit({ userId: "u", operation: "WITHDRAW", rail: "mobilemoney", currency: "XOF", amount: 1 }));
});
