"use strict";

/**
 * Plafonds — ce que l'écran annonce est ce que le serveur applique
 * (2026-10-17), `services/limits/limitService.js`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLimitService } = require("../../src/services/limits/limitService");
const { DEFAULT_LIMITS } = require("../../src/services/limits/limitCatalog");

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const rows = [
  { flow: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT", operationType: "WITHDRAW", status: "confirmed", amountSource: 1_900_000, currencySource: "XOF", createdAt: new Date(NOW - 3600e3).toISOString() },
  { flow: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT", operationType: "WITHDRAW", status: "failed", amountSource: 9_000_000, currencySource: "XOF", createdAt: new Date(NOW - 3600e3).toISOString() },
];

const service = createLimitService({
  now: () => NOW,
  policyService: { getActivePolicy: async () => ({ limits: DEFAULT_LIMITS, version: 0, source: "default" }) },
  models: {
    Transaction: { find: () => ({ select: () => ({ lean: async () => rows }) }) },
    CagnotteSettlement: null,
  },
});

test("the screen and the refusal agree on what remains", async () => {
  const described = await service.describeLimits({ userId: "u1", currency: "XOF" });
  const withdrawMm = described.limits.find((l) => l.operation === "WITHDRAW" && l.rail === "mobilemoney");
  assert.equal(withdrawMm.daily.remaining, 100_000);
  assert.equal(withdrawMm.availableNow, 100_000);

  const ok = await service.checkLimit({ userId: "u1", operation: "withdraw", rail: "mobilemoney", currency: "XOF", amount: 100_000 });
  assert.equal(ok.allowed, true);
  const refused = await service.checkLimit({ userId: "u1", operation: "WITHDRAW", rail: "mobilemoney", currency: "XOF", amount: 100_001 });
  assert.equal(refused.code, "LIMIT_ROLLING_24H");
  assert.equal(refused.remaining, withdrawMm.daily.remaining);
});

test("deposits are not consumed by withdrawals", async () => {
  const deposit = await service.checkLimit({ userId: "u1", operation: "DEPOSIT", rail: "mobilemoney", currency: "XOF", amount: 750_000 });
  assert.equal(deposit.allowed, true);
});

test("a PayNoval → PayNoval call without a type is a transfer; an external one without a type is refused", async () => {
  assert.equal((await service.checkLimit({ userId: "u1", operation: null, rail: "paynoval", currency: "XOF", amount: 1 })).allowed, true);
  await assert.rejects(service.checkLimit({ userId: "u1", operation: null, rail: "card", currency: "XOF", amount: 1 }), (e) => e.code === "LIMIT_UNDEFINED");
});

test("a currency is required to describe limits", async () => {
  await assert.rejects(service.describeLimits({ userId: "u1", currency: "F CFA" }), (e) => e.code === "LIMIT_UNDEFINED");
});
