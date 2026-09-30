"use strict";

// The app sends `cardLast4` (never a PAN) since 2026-09-30: the masked card of
// a card deposit/payout is built from it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { maskLast4, maskPan } = require("../src/services/transactions/handlers/flowHelpers");

test("masks the last four digits only", () => {
  assert.equal(maskLast4("4242"), "•••• 4242");
  assert.equal(maskLast4("42"), null);
  assert.equal(maskLast4("4111111111111111"), null);
});

test("maskPan still masks a legacy full number", () => {
  assert.equal(maskPan("4111111111111111"), "411111******1111");
});
