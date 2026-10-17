"use strict";

/**
 * Le type déclaré doit suivre le sens de l'argent, et il est enregistré
 * (2026-10-17) — plafonds par opération.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { typeOperationPourSens } = require("../../src/services/transactions/shared/externalTxType");

test("outbound: withdrawal or transfer; inbound: deposit — anything else is refused", () => {
  assert.equal(typeOperationPourSens("WITHDRAW", "outbound"), "WITHDRAW");
  assert.equal(typeOperationPourSens("transfer", "outbound"), "TRANSFER");
  assert.equal(typeOperationPourSens("DEPOSIT", "inbound"), "DEPOSIT");
  for (const [type, sens] of [["DEPOSIT", "outbound"], [null, "outbound"], ["WITHDRAW", "inbound"], ["TRANSFER", "inbound"]]) {
    assert.throws(() => typeOperationPourSens(type, sens), (e) => e.code === "TX_TYPE_FLOW_MISMATCH" && e.status === 400);
  }
});

test("each creation path records the operation type", () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");
  const external = read("src/services/transactions/handlers/initiateExternalTransactions.js");
  assert.match(external, /typeOperationPourSens\(resoudreTypeExterne\(body\), "outbound"\)/);
  assert.match(external, /typeOperationPourSens\(resoudreTypeExterne\(body\), "inbound"\)/);
  assert.equal((external.match(/^\s*operationType,$/gm) || []).length, 2);
  assert.match(read("src/services/transactions/handlers/initiateInternal.js"), /operationType: "TRANSFER"/);
  assert.match(read("src/models/Transaction.js"), /operationType: \{[\s\S]{0,140}immutable: true/);
});
