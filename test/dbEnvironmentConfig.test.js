"use strict";

/**
 * LA CONFIGURATION DE CE DÉPÔT VISE DES BASES MARQUÉES
 * ============================================================================
 *
 * Le 2026-09-03, les trois bases Atlas ont été copiées vers des noms suffixés
 * « -test » et `DB_ENV_STRICT=true` a été activée dans les trois `.env`. En
 * mode strict, la garde `src/utils/dbEnvironmentGuard.js` REFUSE de démarrer si la
 * base visée ne porte aucun marqueur d'environnement reconnaissable.
 *
 * Conséquence : une URI remise vers une base sans marqueur ne provoque plus un
 * démarrage silencieux sur les mauvaises données — elle empêche le démarrage.
 * Autant l'apprendre ici. Ce test ÉCHOUE si l'on réintroduit la faute.
 *
 * Il ne lit que le NOM de la base. Jamais l'identifiant, jamais le secret
 * (règle B.4).
 *
 * Origine : le 2026-08-27, une campagne de charge a tourné contre l'Atlas de
 * production parce que rien, dans une chaîne de connexion, ne distinguait un
 * environnement de l'autre (défaut A1 de `RESTE_A_FAIRE.md`).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const garde = require("../src/utils/dbEnvironmentGuard");
const cheminEnv = path.join(__dirname, "..", ".env");

const uris = fs.existsSync(cheminEnv)
  ? fs
      .readFileSync(cheminEnv, "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_]*MONGO[A-Z_]*=/.test(l))
      .map((l) => ({ cle: l.split("=")[0], uri: l.slice(l.indexOf("=") + 1).trim() }))
  : [];

test("le .env déclare au moins une base de données", (t) => {
  if (!fs.existsSync(cheminEnv)) return t.skip("aucun .env dans cet environnement");
  assert.ok(uris.length > 0, "aucune variable MONGO_* trouvée dans le .env");
});

for (const { cle, uri } of uris) {
  test(`${cle} vise une base portant un marqueur d'environnement`, () => {
    const infos = garde.describeUri(uri);
    assert.ok(infos && infos.base, `${cle} : nom de base illisible dans l'URI`);
    assert.notEqual(
      garde.classifyDatabaseName(infos.base),
      "inconnu",
      `${cle} vise « ${infos.base} », qui ne porte aucun marqueur ` +
        "(-test, -dev, -staging, -sandbox, -prod…). Avec DB_ENV_STRICT=true, " +
        "ce service REFUSERA de démarrer."
    );
  });
}

test("les marqueurs de production sont bien reconnus comme tels", () => {
  assert.equal(garde.classifyDatabaseName("paynoval-prod"), "production");
  assert.equal(garde.classifyDatabaseName("paynoval-test"), "test");
  assert.equal(garde.classifyDatabaseName("paynoval"), "inconnu");
});
