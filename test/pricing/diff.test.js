"use strict";

/**
 * ── Déplacé depuis l'API Gateway le 2026-09-10 ──────────────────────────────
 *
 * Ce test suit le code qu'il protège. Le laisser dans la passerelle en aurait
 * fait un test de code MORT : il aurait continué à passer, en donnant
 * l'impression de couvrir la tarification, pendant que la tarification réelle
 * — celle de Tx-Core — n'aurait été couverte par rien.
 *
 * C'est exactement le défaut trouvé le 2026-09-09 sur le chemin de l'argent des
 * cagnottes : un garde-fou qui ne couvre qu'un dépôt sur deux protège la moitié
 * du chemin en donnant l'impression de le protéger entièrement.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeRuleDiff } = require("../../src/services/pricing/diff");

const before = {
  name: "Transfert CI",
  active: true,
  priority: 0,
  scope: { txType: "TRANSFER", method: "MOBILEMONEY", fromCurrency: "EUR", toCurrency: "XOF" },
  amountRange: { min: 0, max: null },
  fee: { mode: "PERCENT", fixed: 0, percent: 1, minFee: null, maxFee: null },
  fx: { mode: "MARKUP_PERCENT", markupPercent: 1.5, notes: "" },
};

test("ne signale rien quand rien ne change", () => {
  assert.deepEqual(computeRuleDiff(before, { ...before }), []);
});

test("signale une modification de pourcentage de frais", () => {
  const after = { ...before, fee: { ...before.fee, percent: 2 } };
  assert.deepEqual(computeRuleDiff(before, after), [
    { path: "fee.percent", before: 1, after: 2 },
  ]);
});

test("signale plusieurs modifications, triées par chemin", () => {
  const after = {
    ...before,
    active: false,
    fx: { ...before.fx, markupPercent: 3 },
  };

  assert.deepEqual(computeRuleDiff(before, after), [
    { path: "active", before: true, after: false },
    { path: "fx.markupPercent", before: 1.5, after: 3 },
  ]);
});

test("distingue null et 0 : un plafond retiré n'est pas un plafond à zéro", () => {
  const after = { ...before, fee: { ...before.fee, maxFee: 0 } };
  assert.deepEqual(computeRuleDiff(before, after), [
    { path: "fee.maxFee", before: null, after: 0 },
  ]);
});

test("pour une création, tout champ renseigné apparaît avec un avant à null", () => {
  const diff = computeRuleDiff(null, {
    name: "Nouvelle règle",
    fee: { mode: "FIXED", fixed: 500 },
  });

  assert.deepEqual(diff, [
    { path: "fee.fixed", before: null, after: 500 },
    { path: "fee.mode", before: null, after: "FIXED" },
    { path: "name", before: null, after: "Nouvelle règle" },
  ]);
});

test("compare les dates par leur valeur, pas par leur référence", () => {
  const a = { startsAt: new Date("2026-09-01T00:00:00Z") };
  const b = { startsAt: "2026-09-01T00:00:00.000Z" };
  assert.deepEqual(computeRuleDiff(a, b), []);
});

test("compare les listes comme des ensembles ordonnés", () => {
  const a = { operators: ["wave", "orange"] };
  const b = { operators: ["wave", "mtn"] };

  assert.deepEqual(computeRuleDiff(a, b), [
    { path: "operators", before: ["wave", "orange"], after: ["wave", "mtn"] },
  ]);
});

test("ignore les champs techniques que l'opérateur ne pilote pas", () => {
  const a = { name: "R", _id: "x", createdAt: "2026-01-01", updatedAt: "2026-01-01", currentVersion: 3 };
  const b = { name: "R", _id: "y", createdAt: "2026-02-02", updatedAt: "2026-02-02", currentVersion: 4 };

  assert.deepEqual(computeRuleDiff(a, b), []);
});
