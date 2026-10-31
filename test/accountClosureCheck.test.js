"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { closureBlockers } = require("../src/services/accounts/closureCheck");

test("an empty account has nothing tying it down", () => {
  const wallets = [{ currency: "XOF", amount: "0", availableAmount: "0", reservedAmount: "0.00" }];
  assert.deepEqual(closureBlockers({ wallets, inFlightCount: 0 }), []);
});

test("money anywhere in a wallet blocks, reserved money included", () => {
  for (const field of ["amount", "availableAmount", "reservedAmount"]) {
    const [blocker] = closureBlockers({ wallets: [{ currency: "CAD", [field]: "0.01" }] });
    assert.deepEqual(blocker, { code: "WALLET_NOT_EMPTY", currency: "CAD" });
  }
});

test("a negative balance blocks too", () => {
  assert.equal(closureBlockers({ wallets: [{ currency: "EUR", amount: "-5" }] })[0].code, "WALLET_NOT_EMPTY");
});

test("a balance that cannot be read blocks instead of counting as zero", () => {
  assert.equal(closureBlockers({ wallets: [{ currency: "EUR", amount: "n/a" }] })[0].code, "WALLET_UNREADABLE");
});

test("a transfer still moving blocks, and an unreadable count too", () => {
  assert.equal(closureBlockers({ inFlightCount: 2 })[0].code, "TRANSACTIONS_IN_FLIGHT");
  assert.equal(closureBlockers({ inFlightCount: undefined })[0].code, "IN_FLIGHT_UNREADABLE");
});
