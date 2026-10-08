"use strict";

/**
 * Les plafonds AML portent sur le RAIL, jamais sur l'opérateur (2026-10-08).
 *
 * Défaut gardé : le plafond était cherché avec `body.provider` (« wave »,
 * « orange »…), absent de la table des rails : `AML_UNKNOWN_RAIL`, donc tout
 * dépôt / retrait mobile money refusé « pour cette devise » — et un cumul
 * journalier par opérateur (750 000 XOF par opérateur et par jour).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { resolveAmlRail } = require("../src/middleware/aml");
const { getSingleTxLimit } = require("../src/tools/amlLimits");

const req = (body, extra = {}) => ({ body, ...extra });

test("le rail est le côté externe du couple funds / destination", () => {
  assert.equal(resolveAmlRail(req({ funds: "mobilemoney", destination: "paynoval", provider: "wave" })), "mobilemoney");
  assert.equal(resolveAmlRail(req({ funds: "paynoval", destination: "mobilemoney", provider: "orange" })), "mobilemoney");
  assert.equal(resolveAmlRail(req({ funds: "paynoval", destination: "visa_direct", provider: "visa_direct" })), "visa_direct");
  assert.equal(resolveAmlRail(req({ funds: "paynoval", destination: "paynoval" })), "paynoval");
});

test("sans funds/destination (cagnotte), l'ancien calcul s'applique", () => {
  assert.equal(resolveAmlRail(req({}, { routedProvider: "paynoval" })), "paynoval");
});

test("⚠️ un dépôt Wave trouve son plafond ; l'opérateur seul n'en a pas", () => {
  const rail = resolveAmlRail(req({ funds: "mobilemoney", destination: "paynoval", provider: "wave" }));
  assert.ok(getSingleTxLimit(rail, "XOF", "DEPOSIT") > 0);
  assert.throws(() => getSingleTxLimit("wave", "XOF", "DEPOSIT"));
});

test("un rail inconnu reste refusé", () => {
  const rail = resolveAmlRail(req({ funds: "paynoval", destination: "bank" }));
  assert.throws(() => getSingleTxLimit(rail, "XOF", "WITHDRAW"));
});

test("plafonds, cumul journalier et score de risque utilisent le rail", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/middleware/aml.js"), "utf8");
  assert.doesNotMatch(src, /getSingleTxLimit\(provider/);
  assert.doesNotMatch(src, /getDailyLimit\(provider/);
  assert.doesNotMatch(src, /getUserTransactionsStats\(userId, provider/);
  assert.match(src, /getUserTransactionsStats\(userId, amlRail, currencyCode\)/);
});
