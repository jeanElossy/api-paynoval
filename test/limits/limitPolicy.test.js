"use strict";

/**
 * Plafonds — règles pures (2026-10-17), `services/limits/limitPolicy.js`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_LIMITS, DEFAULT_POLICY_PROVENANCE, OPERATIONS, RAILS_BY_OPERATION } = require("../../src/services/limits/limitCatalog");
const {
  LIMIT_CODES,
  describeLimitRefusal,
  evaluateLimit,
  resolveLimit,
  validatePolicy,
} = require("../../src/services/limits/limitPolicy");
const { AML_SINGLE_TX_LIMITS, AML_DAILY_LIMITS } = require("../../src/tools/amlLimits");

const limit = { operation: "WITHDRAW", rail: "mobilemoney", currency: "XOF", perTransaction: 750_000, rolling24h: 2_000_000, rolling30d: 10_000_000 };

test("the defaults are valid and cover every operation × rail of V1", () => {
  assert.deepEqual(validatePolicy(DEFAULT_LIMITS), []);
  for (const op of OPERATIONS) for (const rail of RAILS_BY_OPERATION[op]) assert.ok(DEFAULT_LIMITS[op][rail].XOF);
});

test("the defaults keep the historical AML figures; 30 days is announced as provisional", () => {
  assert.equal(DEFAULT_LIMITS.WITHDRAW.mobilemoney.XOF.perTransaction, AML_SINGLE_TX_LIMITS.mobilemoney.XOF);
  assert.equal(DEFAULT_LIMITS.TRANSFER.card.EUR.rolling24h, AML_DAILY_LIMITS.card.EUR);
  assert.match(DEFAULT_POLICY_PROVENANCE.rolling30d, /PROVISIONAL/);
});

test("an incoherent policy is refused", () => {
  const bad = JSON.parse(JSON.stringify(DEFAULT_LIMITS));
  bad.DEPOSIT.mobilemoney.XOF.rolling24h = 1; // below the per-operation limit
  bad.WITHDRAW.bank = { XOF: { perTransaction: 1, rolling24h: 1, rolling30d: 1 } };
  delete bad.TRANSFER.card;
  const errors = validatePolicy(bad);
  assert.ok(errors.some((e) => e.includes("24 h est inférieur")));
  assert.ok(errors.some((e) => e.includes("hors périmètre")));
  assert.ok(errors.some((e) => e.includes("TRANSFER/card")));
});

test("no limit for the operation ⇒ refused, never guessed", () => {
  assert.throws(() => resolveLimit(DEFAULT_LIMITS, { operation: "DEPOSIT", rail: "paynoval", currency: "XOF" }), (e) => e.code === LIMIT_CODES.UNDEFINED);
  assert.throws(() => resolveLimit(DEFAULT_LIMITS, { operation: "WITHDRAW", rail: "mobilemoney", currency: "ZZZ" }), (e) => e.code === LIMIT_CODES.UNDEFINED);
  assert.throws(() => resolveLimit(DEFAULT_LIMITS, { operation: null, rail: "card", currency: "EUR" }), (e) => e.code === LIMIT_CODES.UNDEFINED);
});

test("per operation, then 24 h, then 30 days — with what remains and when it frees up", () => {
  assert.equal(evaluateLimit(limit, { used24h: 0, used30d: 0 }, 750_000).allowed, true);

  const big = evaluateLimit(limit, { used24h: 0, used30d: 0 }, 750_001);
  assert.equal(big.code, LIMIT_CODES.PER_TRANSACTION);
  assert.equal(big.remaining, 750_000);

  const day = evaluateLimit(limit, { used24h: 1_800_000, used30d: 1_800_000, oldest24hAt: "2026-10-17T08:00:00.000Z" }, 300_000);
  assert.equal(day.code, LIMIT_CODES.ROLLING_24H);
  assert.equal(day.remaining, 200_000);
  assert.equal(day.releasesAt, "2026-10-18T08:00:00.000Z");
  assert.equal(day.view.availableNow, 200_000);

  const month = evaluateLimit(limit, { used24h: 0, used30d: 9_900_000, oldest30dAt: "2026-10-01T00:00:00.000Z" }, 200_000);
  assert.equal(month.code, LIMIT_CODES.ROLLING_30D);
  assert.equal(month.remaining, 100_000);
});

test("an unreadable amount is refused", () => {
  assert.equal(evaluateLimit(limit, {}, "abc").allowed, false);
  assert.equal(evaluateLimit(limit, {}, -5).allowed, false);
});

test("the refusal says which limit, what remains and when", () => {
  const day = evaluateLimit(limit, { used24h: 1_800_000, used30d: 1_800_000, oldest24hAt: "2026-10-17T08:00:00.000Z" }, 300_000);
  const msg = describeLimitRefusal(day, "F CFA");
  assert.match(msg, /24 heures/);
  assert.match(msg, /200 000 F CFA/);
  assert.match(msg, /18 octobre/);
});
