"use strict";

/**
 * AUCUNE DONNÉE PERSONNELLE EN CLAIR DANS LES JOURNAUX DE TX-CORE (2026-10-08)
 *
 * Les deux loggers winston ne masquaient RIEN, et l'AML écrivait l'e-mail de
 * l'utilisateur à chaque décision. Filet à la sortie (loggers + console),
 * correction à la source (identifiants), et le diagnostic reste lisible.
 * Copie conforme de `paynoval-backend/utils/logRedaction.js` — vérifiée ici.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { redactLogString, redactWinstonInfo, installConsoleRedaction } = require("../src/utils/logRedaction");
const { redactSensitive } = require("../src/utils/redactSensitive");

test("e-mail, téléphone E.164, carte (Luhn) masqués", () => {
  assert.equal(redactLogString("a awa@ex.com b"), "a [email] b");
  assert.equal(redactLogString("+2250700000000"), "[phone:…0000]");
  assert.equal(redactLogString("4111 1111 1111 1111"), "[card]");
});

test("identifiants, montants, horodatages restent lisibles", () => {
  for (const s of ["tx 6520ab0000000000000000ff", "1500000 XOF", "ts=1700000000000", "2026-10-08T12:00:00.000Z"]) {
    assert.equal(redactLogString(s), s);
  }
});

test("un info winston est masqué par clé PUIS par valeur", () => {
  const info = redactWinstonInfo(
    { level: "info", message: "pour a@b.co", userId: "64b000000000000000000001", ctx: { to: "+33612345678", password: "x" } },
    redactSensitive
  );
  assert.equal(info.message, "pour [email]");
  assert.equal(info.userId, "64b000000000000000000001");
  assert.equal(info.ctx.to, "[phone:…5678]");
  assert.notEqual(info.ctx.password, "x");
});

test("console : chaque argument masqué, installation unique", () => {
  const out = [];
  const fake = { log: (...a) => out.push(a), info() {}, warn() {}, error() {}, debug() {} };
  assert.equal(installConsoleRedaction(fake), true);
  assert.equal(installConsoleRedaction(fake), false);
  fake.log({ email: "z@z.io" });
  assert.doesNotMatch(JSON.stringify(out), /z@z\.io/);
});

test("les deux loggers et tous les points d'entrée portent le filet", () => {
  const root = path.join(__dirname, "..");
  for (const f of ["src/logger.js", "src/utils/logger.js"]) {
    assert.match(fs.readFileSync(path.join(root, f), "utf8"), /redactPii\(\)/, f);
  }
  for (const f of ["src/server.js", "workers/all.js", "workers/notificationDispatch.js", "workers/referralAward.js", "workers/riskMonitor.js", "workers/settlementMonitor.js"]) {
    assert.match(fs.readFileSync(path.join(root, f), "utf8"), /installConsoleRedaction\(\)/, f);
  }
});

test("l'AML et l'éligibilité ne journalisent plus d'e-mail", () => {
  const root = path.join(__dirname, "..", "src", "middleware");
  const aml = fs.readFileSync(path.join(root, "aml.js"), "utf8");
  const elig = fs.readFileSync(path.join(root, "requireTransactionEligibility.js"), "utf8");
  assert.doesNotMatch(aml, /user:\s*user\??\.email/);
  assert.doesNotMatch(elig, /logger[\s\S]{0,400}?email:\s*(cleanEmail\(|req\.user\?\.email|getRequesterEmail)/);
});

test("copie conforme du module du backend principal", () => {
  const backend = path.join(__dirname, "..", "..", "paynoval-backend", "utils", "logRedaction.js");
  if (!fs.existsSync(backend)) return; // dépôts séparés : vérifié quand les deux sont présents
  const strip = (s) => s.split("\n").slice(30).join("\n");
  assert.equal(strip(fs.readFileSync(backend, "utf8")), strip(fs.readFileSync(path.join(__dirname, "..", "src", "utils", "logRedaction.js"), "utf8")));
});
