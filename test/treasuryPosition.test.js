"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPosition, currenciesOf, readAmount, systemTypeOf } = require("../src/services/treasury/treasuryPosition");

const NOW = Date.UTC(2026, 9, 31, 12);

const system = (systemType, balances, isActive = true) => ({ systemType, balances, isActive });

const base = {
  currency: "XOF",
  pending: [],
  lastDay: [],
  today: 0,
  series: [],
  moves: [],
  now: NOW,
};

const fees = "treasury:FEES_TREASURY:u1:XOF";

test("a position holds one currency: others are never added in", () => {
  const out = buildPosition({
    ...base,
    systems: [system("FEES_TREASURY", { XOF: "1000", EUR: "999999" }), system("FX_MARGIN_TREASURY", { XOF: "500" })],
  });

  assert.equal(out.totals.available, 1500);
  assert.deepEqual(out.currencies, ["EUR", "XOF"]);
});

test("reserved money comes from pending ledger entries, and counts in the position", () => {
  const out = buildPosition({
    ...base,
    systems: [system("FEES_TREASURY", { XOF: "1000" })],
    pending: [{ _id: fees, amount: 200 }],
  });

  assert.equal(out.accounts.find((a) => a.systemType === "FEES_TREASURY").reserved, 200);
  assert.equal(out.totals.reserved, 200);
  assert.equal(out.totals.position, 1200);
});

test("an unreadable balance gives no total instead of a wrong one", () => {
  const out = buildPosition({ ...base, systems: [system("FEES_TREASURY", { XOF: "n/a" })] });

  assert.equal(out.totals.available, null);
  assert.equal(out.totals.position, null);
  assert.equal(out.accounts.find((a) => a.systemType === "FEES_TREASURY").state, "unreadable");
});

test("a treasury that is missing is said so, never shown as zero", () => {
  const out = buildPosition({ ...base, systems: [] });
  assert.ok(out.accounts.every((account) => account.state === "missing" && account.available === null));
  assert.equal(out.totals.position, null);
});

test("simulation treasuries stay out", () => {
  const out = buildPosition({
    ...base,
    systems: [system("SANDBOX_FEES_TREASURY", { XOF: "5000" }), system("FEES_TREASURY", { XOF: "10" })],
  });
  assert.equal(out.accounts.some((a) => a.systemType === "SANDBOX_FEES_TREASURY"), false);
});

test("the series has 30 days, and a day without entries is a real zero", () => {
  const out = buildPosition({ ...base, systems: [], series: [{ day: "2026-10-31", net: 42 }] });

  assert.equal(out.series.length, 30);
  assert.deepEqual(out.series[29], { day: "2026-10-31", net: 42 });
  assert.equal(out.series[0].net, 0);
});

test("the account state follows the books", () => {
  const out = buildPosition({
    ...base,
    systems: [system("FEES_TREASURY", { XOF: "0" }), system("FX_MARGIN_TREASURY", { XOF: "9" }, false)],
  });
  assert.equal(out.accounts.find((a) => a.systemType === "FEES_TREASURY").state, "empty");
  assert.equal(out.accounts.find((a) => a.systemType === "FX_MARGIN_TREASURY").state, "inactive");
});

test("helpers", () => {
  assert.equal(readAmount(undefined), 0);
  assert.equal(readAmount("x"), null);
  assert.equal(systemTypeOf(fees), "FEES_TREASURY");
  assert.equal(systemTypeOf("user_wallet:u1:XOF"), null);
  assert.deepEqual(currenciesOf([{ balances: new Map([["cad", 1]]) }]), ["CAD"]);
});
