"use strict";

/**
 * Contrôle des failles des dépendances (2026-11-11) — une règle, cinq dépôts.
 * Chaque test échoue si l'on réintroduit la faute qu'il garde (règle B.5).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateAudit, MAX_EXCEPTION_DAYS } = require("../scripts/audit-gate.cjs");

const adv = (pkg, severity, ghsa) => ({
  [pkg]: { severity, via: [{ source: 1, name: pkg, title: `faille ${pkg}`, url: `https://github.com/advisories/${ghsa}`, severity }] },
});
const report = (...entries) => ({ vulnerabilities: Object.assign({}, ...entries) });
const TODAY = "2026-11-11";

test("critique ou haute : bloque, même dans l'outillage", () => {
  const all = report(adv("mongoose", "critical", "GHSA-gg4r-jv3p-qx3c"), adv("sharp", "high", "GHSA-f88m-g3jw-g9cj"));
  const prod = report(adv("mongoose", "critical", "GHSA-gg4r-jv3p-qx3c"));
  const v = evaluateAudit({ all, prod, today: TODAY });
  assert.deepEqual(v.blocking.map((a) => a.pkg).sort(), ["mongoose", "sharp"]);
});

test("moyenne : bloque dans le code livré, signalée dans l'outillage ; faible : signalée", () => {
  const all = report(adv("glob", "moderate", "GHSA-3g3m-2fjr-6pw4"), adv("eslint-x", "moderate", "GHSA-aaaa-bbbb-cccc"), adv("deepmerge", "low", "GHSA-gcqx-w48m-w2h4"));
  const prod = report(adv("glob", "moderate", "GHSA-3g3m-2fjr-6pw4"), adv("deepmerge", "low", "GHSA-gcqx-w48m-w2h4"));
  const v = evaluateAudit({ all, prod, today: TODAY });
  assert.deepEqual(v.blocking.map((a) => a.pkg), ["glob"]);
  assert.deepEqual(v.reported.map((a) => a.pkg).sort(), ["deepmerge", "eslint-x"]);
});

test("une exception valide et en cours lève le blocage ; expirée, elle bloque de nouveau", () => {
  const all = report(adv("query-string", "high", "GHSA-w573-4hg7-7wgq"));
  const prod = all;
  const exception = { id: "GHSA-w573-4hg7-7wgq", reason: "correctif = SDK 58", mitigation: "liste blanche des liens", expires: "2027-02-28" };
  assert.equal(evaluateAudit({ all, prod, exceptions: [exception], today: TODAY }).blocking.length, 0);
  const late = evaluateAudit({ all, prod, exceptions: [exception], today: "2027-03-01" });
  assert.equal(late.blocking.length, 1);
  assert.equal(late.blocking[0].expiredException, "2027-02-28");
});

test("une exception mal écrite ou trop longue bloque", () => {
  const all = report(adv("x", "high", "GHSA-aaaa-bbbb-cccc"));
  for (const bad of [
    { id: "GHSA-aaaa-bbbb-cccc", mitigation: "m", expires: "2027-01-01" }, // sans justification
    { id: "GHSA-aaaa-bbbb-cccc", reason: "r", expires: "2027-01-01" }, // sans mesure compensatoire
    { id: "GHSA-aaaa-bbbb-cccc", reason: "r", mitigation: "m" }, // sans date
    { id: "pas-un-ghsa", reason: "r", mitigation: "m", expires: "2027-01-01" },
    { id: "GHSA-aaaa-bbbb-cccc", reason: "r", mitigation: "m", expires: "2028-01-01" }, // > 180 jours
  ]) {
    const v = evaluateAudit({ all, prod: all, exceptions: [bad], today: TODAY });
    assert.ok(v.errors.length === 1, JSON.stringify(bad));
    assert.equal(v.blocking.length, 1, JSON.stringify(bad));
  }
  assert.equal(MAX_EXCEPTION_DAYS, 180);
});

test("une exception qui ne sert plus est signalée", () => {
  const v = evaluateAudit({
    all: report(),
    prod: report(),
    exceptions: [{ id: "GHSA-aaaa-bbbb-cccc", reason: "r", mitigation: "m", expires: "2027-01-01" }],
    today: TODAY,
  });
  assert.deepEqual(v.unused, ["GHSA-AAAA-BBBB-CCCC"]);
});

const fs = require("fs");
const path = require("path");

/**
 * Même fichier dans les cinq dépôts : une règle, pas cinq variantes qui
 * divergent. Vérifié là où les dépôts voisins sont présents (le poste de
 * travail) ; en intégration continue, seul ce dépôt est extrait.
 */
const COPIES = [
  "paynoval-backend/scripts/audit-gate.cjs",
  "api-gateway/api-gateway/scripts/audit-gate.cjs",
  "web_paynoval/scripts/audit-gate.cjs",
  "payNoval-master/scripts/audit-gate.cjs",
];
const WORKSPACE = path.join(__dirname, "..", "..");
const present = COPIES.filter((rel) => fs.existsSync(path.join(WORKSPACE, rel)));

test("les copies des autres dépôts sont identiques à l'octet près", { skip: present.length === 0 }, () => {
  const mine = fs.readFileSync(path.join(__dirname, "..", "scripts", "audit-gate.cjs"));
  for (const rel of present) {
    assert.ok(fs.readFileSync(path.join(WORKSPACE, rel)).equals(mine), rel);
  }
});
