"use strict";

/**
 * Une trésorerie de cagnotte manquante doit se voir AU DÉMARRAGE, avec sa
 * conséquence — pas à la première participation, en 500 (règle B.6).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { diagnoseCagnotteReadiness, announceCagnotteReadiness } = require("../src/utils/cagnotteReadiness");

const OK = {
  CAGNOTTE_FEES_TREASURY_USER_ID: "cccccccccccccccccccccccc",
  FX_MARGIN_TREASURY_USER_ID: "abababababababababababab",
};

test("configuration complète : prêt", () => {
  assert.deepEqual(diagnoseCagnotteReadiness(OK), { ready: true, problems: [] });
});

test("trésorerie absente ou illisible : signalée avec sa conséquence", () => {
  const d = diagnoseCagnotteReadiness({ FX_MARGIN_TREASURY_USER_ID: "pas-un-id" });
  assert.equal(d.ready, false);
  assert.deepEqual(
    d.problems.map((p) => [p.env, p.issue]),
    [
      ["CAGNOTTE_FEES_TREASURY_USER_ID", "absente"],
      ["FX_MARGIN_TREASURY_USER_ID", "illisible (ObjectId attendu)"],
    ]
  );
  assert.ok(d.problems.every((p) => /refusée/.test(p.consequence)));
});

test("liste de devises mal formée : signalée", () => {
  const d = diagnoseCagnotteReadiness({ ...OK, CAGNOTTE_SUPPORTED_CURRENCIES: "XOF,FCFA" });
  assert.equal(d.ready, false);
  assert.equal(d.problems[0].env, "CAGNOTTE_SUPPORTED_CURRENCIES");
});

test("l'annonce journalise un avertissement par problème", () => {
  const lignes = [];
  announceCagnotteReadiness({}, { warn: (m) => lignes.push(m), info: () => {} });
  assert.equal(lignes.length, 2);
  assert.ok(lignes.every((l) => l.includes("conséquence")));
});

test("le serveur appelle réellement l'annonce au démarrage", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  assert.match(src, /announceCagnotteReadiness\(process\.env, logger\)/);
});
