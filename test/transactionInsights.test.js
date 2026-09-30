"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  aggregateInsights,
  classifyTransaction,
  toMinorUnits,
} = require("../src/services/transactions/insights/transactionInsights");

const ME = "64b000000000000000000001";
const OTHER = "64b000000000000000000002";
const NOW = Date.parse("2026-09-30T12:00:00Z");
const DAY = 24 * 3600 * 1000;

const tx = (over) => ({
  status: "confirmed",
  flow: "PAYNOVAL_INTERNAL_TRANSFER",
  operationKind: "transfer",
  createdAt: new Date(NOW - DAY),
  ...over,
});

test("exact minor units, half up", () => {
  assert.equal(toMinorUnits("10.005", "EUR"), 1001n);
  assert.equal(toMinorUnits("1500", "XOF"), 1500n);
  assert.equal(toMinorUnits("abc", "EUR"), null);
  assert.equal(toMinorUnits(null, "EUR"), null);
});

test("sender side is the debited source amount, receiver side the credited target", () => {
  const t = tx({ sender: ME, receiver: OTHER, amountSource: "100", currencySource: "EUR", amountTarget: "65500", currencyTarget: "XOF" });
  assert.equal(classifyTransaction(t, ME).currency, "EUR");
  assert.equal(classifyTransaction(t, ME).direction, "debit");
  assert.equal(classifyTransaction(t, OTHER).currency, "XOF");
  assert.equal(classifyTransaction(t, OTHER).direction, "credit");
});

test("currencies are never summed together", () => {
  const out = aggregateInsights(
    [
      tx({ sender: ME, receiver: OTHER, amountSource: "10", currencySource: "EUR" }),
      tx({ sender: OTHER, receiver: ME, amountTarget: "5000", currencyTarget: "XOF" }),
    ],
    { userId: ME, range: "30d", now: NOW }
  );
  const eur = out.currencies.find((c) => c.currency === "EUR");
  const xof = out.currencies.find((c) => c.currency === "XOF");
  assert.equal(eur.expense, 10);
  assert.equal(xof.income, 5000);
  assert.equal(eur.income, 0);
});

test("only confirmed transactions count", () => {
  const out = aggregateInsights(
    [
      tx({ status: "pending", sender: ME, amountSource: "10", currencySource: "EUR" }),
      tx({ status: "cancelled", sender: ME, amountSource: "10", currencySource: "EUR" }),
    ],
    { userId: ME, now: NOW }
  );
  assert.equal(out.currencies.length, 0);
});

test("an unreadable amount is excluded and counted, never zero", () => {
  const out = aggregateInsights(
    [tx({ sender: ME, receiver: OTHER, amountSource: null, currencySource: "EUR" })],
    { userId: ME, now: NOW }
  );
  assert.equal(out.currencies.length, 0);
  assert.equal(out.excluded.amount, 1);
});

test("categories and window", () => {
  const out = aggregateInsights(
    [
      tx({ flow: "MOBILEMONEY_COLLECTION_TO_PAYNOVAL", sender: ME, receiver: ME, userId: ME, amountTarget: "2000", currencyTarget: "XOF" }),
      tx({ flow: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT", sender: ME, amountSource: "500", currencySource: "XOF" }),
      tx({ operationKind: "bonus", receiver: ME, amountSource: "100", currencySource: "XOF" }),
      tx({ sender: ME, receiver: OTHER, amountSource: "999", currencySource: "XOF", createdAt: new Date(NOW - 40 * DAY) }),
    ],
    { userId: ME, range: "30d", now: NOW }
  );
  const xof = out.currencies[0];
  assert.deepEqual(
    xof.byCategory.income.map((c) => c.key).sort(),
    ["BONUS", "DEPOSIT"]
  );
  assert.equal(xof.expense, 500); // the 40-day-old transfer is outside 30d
  assert.equal(xof.series.length, 1);
});

test("a transaction of someone else is ignored", () => {
  assert.equal(classifyTransaction(tx({ sender: OTHER, receiver: OTHER }), ME), null);
});

test("handler: owner query, confirmed only, narrow projection, truncation flag", async () => {
  const { createInsightsHandler, INSIGHTS_PROJECTION } = require("../src/services/transactions/handlers/insights");

  let seenQuery = null;
  let seenProjection = null;
  const docs = [
    { sender: ME, receiver: OTHER, status: "confirmed", amountSource: "10", currencySource: "EUR", createdAt: new Date(NOW - DAY) },
    { sender: ME, receiver: OTHER, status: "confirmed", amountSource: "5", currencySource: "EUR", createdAt: new Date(NOW - DAY) },
  ];

  const Transaction = {
    schema: { path: (p) => (["sender", "receiver", "userId"].includes(p) ? {} : null) },
    find(query, projection) {
      seenQuery = query;
      seenProjection = projection;
      const chain = {
        sort: () => chain,
        limit: () => chain,
        lean: () => chain,
        cursor: () => ({
          async *[Symbol.asyncIterator]() {
            yield* docs;
          },
        }),
      };
      return chain;
    },
  };

  const handler = createInsightsHandler({ Transaction, now: () => NOW, maxDocs: 1 });
  let body = null;
  const res = { status() { return this; }, json(b) { body = b; return this; } };
  await handler({ user: { _id: ME }, query: { range: "30d" } }, res, (e) => { throw e; });

  assert.equal(seenQuery.status, "confirmed");
  assert.ok(seenQuery.$or.some((c) => c.sender === ME));
  assert.equal(seenProjection, INSIGHTS_PROJECTION);
  assert.equal(body.success, true);
  assert.equal(body.data.truncated, true);
  assert.equal(body.data.currencies[0].expense, 10);
});
