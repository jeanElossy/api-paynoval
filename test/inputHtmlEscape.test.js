"use strict";

/**
 * Équivalent exact de xss-clean (2026-11-11). Vecteurs produits par xss-clean
 * 0.1.4 AVANT son retrait : si ce test échoue, des données ou des mots de passe
 * seraient transformés autrement qu'avant. Les trois copies du middleware
 * (Tx-Core, backend, passerelle) doivent rester identiques à l'octet près.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const inputHtmlEscape = require("../src/middleware/inputHtmlEscape");
const vectors = require("./fixtures/inputHtmlEscapeVectors.json");

test("clean : même sortie que xss-clean sur chaque vecteur", () => {
  for (const v of vectors.clean) assert.deepEqual(inputHtmlEscape.clean(v.input), v.output, JSON.stringify(v.input));
});

test("middleware : mêmes affectations que xss-clean", () => {
  for (const v of vectors.middleware) {
    const req = JSON.parse(JSON.stringify(v.input));
    let called = false;
    inputHtmlEscape()(req, {}, () => {
      called = true;
    });
    assert.equal(called, true);
    assert.deepEqual({ body: req.body ?? null, query: req.query ?? null, params: req.params ?? null }, v.output);
  }
});

test("xss-clean et axios-retry ne sont plus ni requis ni déclarés", () => {
  const ROOT = path.join(__dirname, "..");
  const server = fs.readFileSync(path.join(ROOT, "src/server.js"), "utf8");
  const active = server.split("\n").filter((l) => !/^\s*\/\//.test(l));
  assert.ok(!active.some((l) => /require\(["']xss-clean["']\)/.test(l)), "xss-clean encore requis");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["xss-clean"], undefined);
  assert.equal(pkg.dependencies["axios-retry"], undefined);
});

const WORKSPACE = path.join(__dirname, "..", "..");
const COPIES = ["paynoval-backend/middleware/inputHtmlEscape.js", "api-gateway/api-gateway/src/middlewares/inputHtmlEscape.js"];
const present = COPIES.filter((rel) => fs.existsSync(path.join(WORKSPACE, rel)));

test("les copies des autres services sont identiques à l'octet près", { skip: present.length === 0 }, () => {
  const mine = fs.readFileSync(path.join(__dirname, "..", "src", "middleware", "inputHtmlEscape.js"));
  for (const rel of present) assert.ok(fs.readFileSync(path.join(WORKSPACE, rel)).equals(mine), rel);
});
