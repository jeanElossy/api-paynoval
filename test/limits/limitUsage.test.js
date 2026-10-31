"use strict";

/**
 * Plafonds — cumul utilisé (2026-10-17), `services/limits/limitUsage.js`.
 *
 * Chaque test vise un défaut du cumul précédent (`services/aml.js`) :
 * opérations échouées comptées, argent reçu compté, dépôts et retraits mêlés.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeUsage, operationsOfTransaction, loadUsageRows } = require("../../src/services/limits/limitUsage");

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

const withdraw = (amount, h, extra = {}) => ({
  flow: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  operationType: "WITHDRAW",
  status: "confirmed",
  amountSource: amount,
  currencySource: "XOF",
  createdAt: hoursAgo(h),
  ...extra,
});

const usage = (rows, operation = "WITHDRAW", rail = "mobilemoney", currency = "XOF") =>
  computeUsage(rows, { operation, rail, currency, now: NOW });

test("failed, cancelled and refunded operations do not count — their money came back", () => {
  const rows = [
    withdraw(10_000, 1),
    withdraw(50_000, 2, { status: "failed" }),
    withdraw(50_000, 3, { status: "cancelled" }),
    withdraw(50_000, 4, { status: "refunded" }),
    withdraw(5_000, 5, { status: "processing" }),
    withdraw(5_000, 6, { status: "pending" }),
  ];
  assert.equal(usage(rows).used24h, 20_000);
});

test("deposits, withdrawals and transfers have separate counters", () => {
  const rows = [
    withdraw(10_000, 1),
    { ...withdraw(70_000, 1), flow: "MOBILEMONEY_COLLECTION_TO_PAYNOVAL", operationType: "DEPOSIT" },
    { ...withdraw(30_000, 1), operationType: "TRANSFER" },
  ];
  assert.equal(usage(rows, "WITHDRAW").used24h, 10_000);
  assert.equal(usage(rows, "DEPOSIT").used24h, 70_000);
  assert.equal(usage(rows, "TRANSFER").used24h, 30_000);
});

test("rail and currency are separate too", () => {
  const rows = [withdraw(10_000, 1), { ...withdraw(99, 1), currencySource: "EUR" }, { ...withdraw(500, 1), flow: "PAYNOVAL_TO_CARD_PAYOUT" }];
  assert.equal(usage(rows).used24h, 10_000);
  assert.equal(usage(rows, "WITHDRAW", "card").used24h, 500);
});

test("24 h and 30 days are rolling windows, with the time the oldest leaves", () => {
  const rows = [withdraw(1_000, 1), withdraw(2_000, 30), withdraw(4_000, 24 * 29), withdraw(8_000, 24 * 31)];
  const u = usage(rows);
  assert.equal(u.used24h, 1_000);
  assert.equal(u.used30d, 7_000);
  assert.equal(u.oldest24hAt, hoursAgo(1));
  assert.equal(u.oldest30dAt, hoursAgo(24 * 29));
});

test("a legacy payout without a recorded type counts as withdrawal AND transfer (never under-counted)", () => {
  assert.deepEqual(operationsOfTransaction({ flow: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT" }), ["WITHDRAW", "TRANSFER"]);
  assert.deepEqual(operationsOfTransaction({ flow: "MOBILEMONEY_COLLECTION_TO_PAYNOVAL" }), ["DEPOSIT"]);
  assert.deepEqual(operationsOfTransaction({ flow: "PAYNOVAL_INTERNAL_TRANSFER" }), ["TRANSFER"]);
  const legacy = { ...withdraw(3_000, 1), operationType: null };
  assert.equal(usage([legacy], "WITHDRAW").used24h, 3_000);
  assert.equal(usage([legacy], "TRANSFER").used24h, 3_000);
});

test("Decimal128 amounts are read; an unreadable amount throws (never zero)", () => {
  const dec = { toString: () => "1234.50" };
  assert.equal(usage([withdraw(dec, 1)]).used24h, 1234.5);
  assert.throws(() => usage([withdraw("abc", 1)]), (e) => e.code === "LIMIT_USAGE_UNREADABLE");
});

test("one indexed query on the initiating account — never on the receiver", async () => {
  const calls = [];
  const Transaction = {
    find(q) {
      calls.push(q);
      return { select: () => ({ lean: async () => [withdraw(1, 1)] }) };
    },
  };
  const rows = await loadUsageRows({ userId: "u1", now: NOW, Transaction });
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ["context", "createdAt", "userId"]);
  assert.equal(calls[0].userId, "u1");
  // Seul l'historique de départ d'un compte de démonstration est écarté.
  assert.deepEqual(calls[0].context, { $ne: "sandbox_seed" });
});

test("pot contributions count as PayNoval transfers", async () => {
  const Transaction = { find: () => ({ select: () => ({ lean: async () => [] }) }) };
  const CagnotteSettlement = {
    find: () => ({
      select: () => ({
        lean: async () => [{ status: "confirmed", source: { amount: 2_500, currency: "XOF" }, createdAt: hoursAgo(2) }],
      }),
    }),
  };
  const rows = await loadUsageRows({ userId: "u1", now: NOW, Transaction, CagnotteSettlement });
  assert.equal(usage(rows, "TRANSFER", "paynoval").used24h, 2_500);
});
