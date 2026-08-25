"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");

const { findUseBeforeDeclaration } = require("./helpers-moduleScope");

/**
 * Verrouille le défaut qui a fait boucler un déploiement : un bloc inséré
 * au-dessus de `const logger = require("./logger")` le référençait, et le module
 * levait `ReferenceError: Cannot access 'logger' before initialization` au
 * chargement.
 *
 * `node --check` ne l'attrape pas, et `src/server.js` démarre un serveur au
 * `require` — on ne peut donc pas le charger ici. D'où l'analyse statique.
 */

const ROOT = path.join(__dirname, "..");

function parse(file) {
  const src = fs.readFileSync(file, "utf8");

  const ast = acorn.parse(src, {
    ecmaVersion: 2023,
    sourceType: "script",
    allowReturnOutsideFunction: true,
  });

  return { ast, lines: src.split("\n") };
}

function scan(rel) {
  const { ast, lines } = parse(path.join(ROOT, rel));
  return findUseBeforeDeclaration(ast, lines);
}

/* -------------------------------------------------------------------------- */
/* L'analyseur lui-même — il doit détecter, et ne pas sur-détecter            */
/* -------------------------------------------------------------------------- */

function analyzeSource(src) {
  const ast = acorn.parse(src, { ecmaVersion: 2023, sourceType: "script" });
  return findUseBeforeDeclaration(ast, src.split("\n"));
}

test("l'analyseur détecte le défaut exact qui a cassé le déploiement", () => {
  const offences = analyzeSource(`
    const readiness = createReadiness({
      required: ["tx"],
      logger,
    });
    const logger = require("./logger");
  `);

  assert.equal(offences.length, 1);
  assert.equal(offences[0].name, "logger");
});

test("un corps de fonction est DIFFÉRÉ — aucun signalement", () => {
  // C'est la distinction qui sépare un vrai défaut d'un faux positif : ici
  // `logger` n'est lu qu'à l'appel de `handler`, bien après le chargement.
  const offences = analyzeSource(`
    const handler = () => logger.info("ok");
    const logger = require("./logger");
  `);

  assert.deepEqual(offences, []);
});

test("l'ordre correct ne déclenche rien", () => {
  const offences = analyzeSource(`
    const logger = require("./logger");
    const readiness = build({ logger });
  `);

  assert.deepEqual(offences, []);
});

test("une clé d'objet homonyme n'est pas une lecture", () => {
  const offences = analyzeSource(`
    const conf = { logger: null };
    const logger = require("./logger");
  `);

  assert.deepEqual(offences, []);
});

/* -------------------------------------------------------------------------- */
/* Les fichiers réels                                                         */
/* -------------------------------------------------------------------------- */

test("src/server.js n'a aucun usage avant déclaration", () => {
  const offences = scan("src/server.js");

  assert.deepEqual(
    offences,
    [],
    "usages fautifs :\n" +
      offences.map((o) => `  ${o.name} lu ligne ${o.usedAt}, déclaré ligne ${o.declaredAt}`).join("\n")
  );
});

test("les services n'ont aucun usage avant déclaration", () => {
  const dir = path.join(ROOT, "src/services");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));

  for (const f of files) {
    assert.deepEqual(scan(path.join("src/services", f)), [], `dans src/services/${f}`);
  }
});
