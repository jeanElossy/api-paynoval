"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = (file) => fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");

test("chaque route de risque exige le jeton interne", () => {
  const routes = src("routes/internalAdminTransactions.routes.js");
  const lines = routes.split("\n").filter((l) => l.includes("riskAdmin."));
  assert.equal(lines.length, 6);
  for (const line of lines) assert.match(line, /requireInternalToken, riskAdmin\./);
});

test("une réconciliation illisible répond 503, jamais une liste vide", () => {
  assert.match(src("controllers/internalAdminRisk.controller.js"), /status\(503\)[\s\S]*RECONCILIATION_UNAVAILABLE/);
});

test("une entrée de blocage ne se supprime pas", () => {
  assert.doesNotMatch(src("controllers/internalAdminRisk.controller.js"), /deleteOne|findByIdAndDelete/);
});
