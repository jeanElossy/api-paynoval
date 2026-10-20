"use strict";

/**
 * Service-control policy — SAME vectors as paynoval-backend
 * (test/fixtures/serviceControlVectors.js). Tx-Core moves the money, the
 * backend serves the app: they must decide identically for the same input.
 * The fingerprints below are the SAME in
 * paynoval-backend/tests/serviceControlPolicy.test.js — change both together.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const policy = require("../../src/services/serviceControl/policy");
const { NOW, VECTORS, FEATURE_MAPPING, VERSION_VECTORS } = require("../fixtures/serviceControlVectors");

const POLICY_SHA256 = "168a2999db6eaf3c73a4c200e9ebd6403c552e708961245921a4b11149eff53b";
const VECTORS_SHA256 = "a862ec9ba9939b7cd1741bc74c591d609d6761a9b6aff5e81a9be3aba2da4afe";

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

for (const v of VECTORS) {
  test(`vector: ${v.name}`, () => {
    const rules = policy.collectRules({ states: v.states, windows: v.windows || [] }, NOW);
    const d = policy.decide({
      rules: v.sticky ? policy.stickyRules(rules) : rules,
      ctx: v.ctx,
      phase: v.phase,
      bypass: v.bypass || null,
      controlStatus: v.controlStatus || "fresh",
      now: NOW,
    });
    assert.equal(d.allowed, v.expect.allowed);
    if (v.expect.code) assert.equal(d.code, v.expect.code);
    if (v.expect.level) assert.equal(d.level, v.expect.level);
    if (v.expect.ruleScope) assert.equal(d.rule.scopeType, v.expect.ruleScope);
  });
}

for (const m of FEATURE_MAPPING) {
  test(`features of ${JSON.stringify(m.op)}`, () => {
    assert.deepEqual(policy.featuresForMoneyOperation(m.op), m.expect);
  });
}

for (const v of VERSION_VECTORS) {
  test(`version: ${v.name}`, () => {
    const gate = policy.resolveVersionGate(v.policy, v.client);
    for (const [k, val] of Object.entries(v.expect)) assert.equal(gate[k], val);
  });
}

test("policy.js and the vectors are byte-identical to the backend copies", () => {
  assert.equal(sha(path.join(__dirname, "..", "..", "src", "services", "serviceControl", "policy.js")), POLICY_SHA256);
  assert.equal(sha(path.join(__dirname, "..", "fixtures", "serviceControlVectors.js")), VECTORS_SHA256);
});

test("store.js is the backend copy too", () => {
  const backend = path.join(__dirname, "..", "..", "..", "paynoval-backend", "services", "serviceControl", "store.js");
  if (!fs.existsSync(backend)) return; // repositories checked out separately: the policy fingerprint still guards
  assert.equal(sha(path.join(__dirname, "..", "..", "src", "services", "serviceControl", "store.js")), sha(backend));
});

test("flows map to the same features as their operation", () => {
  assert.deepEqual(policy.featuresForFlow("PAYNOVAL_INTERNAL_TRANSFER"), ["money.transfer.internal"]);
  assert.deepEqual(policy.featuresForFlow("CARD_TOPUP_TO_PAYNOVAL"), ["money.deposit"]);
  assert.deepEqual(policy.featuresForFlow("PAYNOVAL_TO_MOBILEMONEY_PAYOUT", "WITHDRAW"), ["money.withdraw"]);
  assert.deepEqual(policy.featuresForFlow("PAYNOVAL_TO_CARD_PAYOUT", "TRANSFER"), ["money.transfer.card"]);
  assert.equal(policy.featuresForFlow("UNKNOWN_FLOW").length, 5);
});
