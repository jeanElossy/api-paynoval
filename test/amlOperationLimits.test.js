"use strict";

/**
 * AML limits gain an OPERATION dimension (transfer to a third party, own
 * withdrawal, top-up) on top of the rail — without changing any amount until
 * compliance sets them.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const limits = require("../src/tools/amlLimits");

test("operations are recognised from the declared type or action", () => {
  assert.equal(limits.normalizeAmlOperation("TRANSFER"), "transfer");
  assert.equal(limits.normalizeAmlOperation("send"), "transfer");
  assert.equal(limits.normalizeAmlOperation("withdraw"), "withdraw");
  assert.equal(limits.normalizeAmlOperation("DEPOSIT"), "deposit");
  assert.equal(limits.normalizeAmlOperation(""), null);
});

test("without an override, every operation gets the rail limit (no behaviour change)", () => {
  for (const op of [undefined, "transfer", "withdraw", "deposit"]) {
    assert.equal(limits.getSingleTxLimit("mobilemoney", "XOF", op), limits.AML_SINGLE_TX_LIMITS.mobilemoney.XOF);
    assert.equal(limits.getDailyLimit("card", "EUR", op), limits.AML_DAILY_LIMITS.card.EUR);
  }
});

test("an override applies to its operation only, and never masks a missing rail", () => {
  limits.AML_SINGLE_TX_OPERATION_LIMITS.transfer.mobilemoney = { XOF: 500_000 };
  try {
    assert.equal(limits.getSingleTxLimit("mobilemoney", "XOF", "transfer"), 500_000);
    assert.equal(limits.getSingleTxLimit("mobilemoney", "XOF", "withdraw"), limits.AML_SINGLE_TX_LIMITS.mobilemoney.XOF);
    assert.throws(() => limits.getSingleTxLimit("bank", "XOF", "transfer"), /inconnu/);
  } finally {
    delete limits.AML_SINGLE_TX_OPERATION_LIMITS.transfer.mobilemoney;
  }
});
