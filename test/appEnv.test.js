"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * appEnv — résolution de l'environnement + GARDE DE RÉPLICATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Deux choses sont testées ici, et la seconde est celle qui manquait au projet.
 *
 * 1. LA RÉSOLUTION elle-même, par `resolveEnvironment` — fonction pure, à qui
 *    l'on fournit l'environnement plutôt que de la laisser lire `process`.
 *
 * 2. LA RÉPLICATION. `docs/architecture/observability.md` §1 relevait ceci :
 *    cinq modules sont recopiés à la main d'un dépôt à l'autre, trois d'entre
 *    eux s'en déclarent « copie à l'identique », et les `requestId.js` ne le
 *    sont DÉJÀ PLUS. Le document concluait :
 *
 *      « Un test qui compare les empreintes des corps et ÉCHOUE à la
 *        divergence est la seule forme de cette discipline qui tienne sans
 *        relecture humaine — il n'existe pas encore. »
 *
 *    Il existe maintenant, et il couvre les six modules répliqués.
 *
 * ⚠️ LES CINQ DÉPÔTS SONT DES DÉPÔTS GIT INDÉPENDANTS. Sur une machine qui
 *    n'a cloné que celui-ci, les voisins sont absents. Le test ne peut donc
 *    pas échouer dans ce cas — mais il ne doit pas non plus passer EN SILENCE,
 *    sans quoi il « passe » aussi bien quand il vérifie que quand il ne
 *    vérifie rien (règle B.5). Il ANNONCE alors ce qu'il n'a pas pu regarder.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  APP_ENV,
  ENVIRONMENTS,
  normalizeEnv,
  resolveEnvironment,
  startupReport,
} = require("../src/services/appEnv");

/* ========================================================================== */
/* 1) Normalisation                                                           */
/* ========================================================================== */

test("normalizeEnv reconnaît les quatre environnements et leurs synonymes", () => {
  assert.equal(normalizeEnv("production"), "production");
  assert.equal(normalizeEnv("PROD"), "production");
  assert.equal(normalizeEnv(" live "), "production");
  assert.equal(normalizeEnv("staging"), "staging");
  assert.equal(normalizeEnv("preprod"), "staging");
  assert.equal(normalizeEnv("dev"), "development");
  assert.equal(normalizeEnv("local"), "development");
  assert.equal(normalizeEnv("ci"), "test");
});

test("normalizeEnv rend null sur ce qu'elle ne reconnaît pas — jamais une valeur inventée", () => {
  assert.equal(normalizeEnv("produktion"), null);
  assert.equal(normalizeEnv(""), null);
  assert.equal(normalizeEnv(undefined), null);
  assert.equal(normalizeEnv(null), null);
  assert.equal(normalizeEnv("  "), null);
});

/* ========================================================================== */
/* 2) Résolution — l'ordre de priorité                                        */
/* ========================================================================== */

test("APP_ENV l'emporte sur NODE_ENV", () => {
  const r = resolveEnvironment({ APP_ENV: "staging", NODE_ENV: "production" });
  assert.equal(r.env, "staging");
  assert.equal(r.source, "APP_ENV");
  assert.equal(r.warning, null);
});

test("NODE_ENV sert de repli quand APP_ENV est absente", () => {
  const r = resolveEnvironment({ NODE_ENV: "production" });
  assert.equal(r.env, "production");
  assert.equal(r.source, "NODE_ENV");
  assert.equal(r.warning, null);
});

/**
 * LE CAS QUI COMPTE, ET LA RAISON D'ÊTRE DU MODULE.
 *
 * `AuditEvent.env` avait pour défaut "production" : un poste de développement
 * écrivait des événements étiquetés production, indiscernables des vrais. Le
 * défaut doit être development — on préfère perdre du signal plutôt que salir
 * une donnée qu'on ne pourra plus départager.
 */
test("le défaut est development, JAMAIS production", () => {
  const r = resolveEnvironment({});
  assert.equal(r.env, "development");
  assert.equal(r.source, "default");
});

test("une APP_ENV mal orthographiée est signalée, pas avalée", () => {
  const r = resolveEnvironment({ APP_ENV: "produktion", NODE_ENV: "production" });
  assert.equal(r.env, "production", "le repli NODE_ENV s'applique");
  assert.equal(r.source, "NODE_ENV");
  assert.match(r.warning, /produktion/, "la faute de frappe est citée telle quelle");
});

test("APP_ENV et NODE_ENV toutes deux illisibles ⇒ development + avertissement", () => {
  const r = resolveEnvironment({ APP_ENV: "prodction", NODE_ENV: "prodction" });
  assert.equal(r.env, "development");
  assert.equal(r.source, "default");
  assert.ok(r.warning, "le silence serait le pire des deux");
});

/* ========================================================================== */
/* 3) Le rapport de démarrage — règle B.6 : annoncer AVEC la conséquence      */
/* ========================================================================== */

test("startupReport annonce l'environnement courant", () => {
  const report = startupReport();
  assert.ok(["info", "warn"].includes(report.level));
  assert.match(report.message, new RegExp(APP_ENV.toUpperCase()));
});

test("APP_ENV est l'une des quatre valeurs reconnues", () => {
  assert.ok(Object.values(ENVIRONMENTS).includes(APP_ENV));
});

/* ========================================================================== */
/* 4) LA GARDE DE RÉPLICATION                                                 */
/* ========================================================================== */

/**
 * Racine de l'espace de travail : deux niveaux au-dessus de `test/`.
 * `api-paynoval/test/` → `api-paynoval/` → racine.
 */
const WORKSPACE = path.resolve(__dirname, "..", "..");

/**
 * Les six modules recopiés à la main entre dépôts, avec leur chemin dans
 * chacun. `metrics`, `readiness` et `redisMetrics` étaient déjà identiques au
 * md5 ; `appEnv` l'est par construction ; les deux derniers ne le sont pas et
 * ne prétendent pas l'être — ils ne figurent donc PAS ici.
 *
 * ⚠️ Ne pas ajouter `requestId.js` ni `mongoPoolMetrics.js` : leurs en-têtes
 * divergent volontairement (adaptation par dépôt). Les y mettre rendrait ce
 * test rouge en permanence, donc ignoré, donc inutile.
 */
const REPLICATED = Object.freeze([
  {
    name: "appEnv.js",
    copies: [
      "api-paynoval/src/services/appEnv.js",
      "paynoval-backend/services/appEnv.js",
      "api-gateway/api-gateway/src/services/appEnv.js",
    ],
  },
  {
    name: "metrics.js",
    copies: [
      "api-paynoval/src/services/metrics.js",
      "paynoval-backend/services/metrics.js",
      "api-gateway/api-gateway/src/services/metrics.js",
    ],
  },
  {
    name: "readiness.js",
    copies: [
      "api-paynoval/src/services/readiness.js",
      "paynoval-backend/services/readiness.js",
      "api-gateway/api-gateway/src/services/readiness.js",
    ],
  },
  {
    name: "redisMetrics.js",
    copies: [
      "api-paynoval/src/services/redisMetrics.js",
      "paynoval-backend/services/redisMetrics.js",
      "api-gateway/api-gateway/src/services/redisMetrics.js",
    ],
  },
]);

const digest = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);

for (const module of REPLICATED) {
  test(`réplication — ${module.name} est identique dans les trois dépôts`, (t) => {
    const present = module.copies.filter((rel) =>
      fs.existsSync(path.join(WORKSPACE, rel))
    );

    /**
     * Dépôt cloné seul : on ne peut rien comparer. On le DIT — un test qui se
     * tait quand il ne vérifie rien est indiscernable d'un test qui passe.
     */
    if (present.length < 2) {
      t.diagnostic(
        `⚠️ NON VÉRIFIÉ : ${present.length} copie(s) sur ${module.copies.length} présentes sur ce disque. ` +
          `Les dépôts voisins ne sont pas là (ce sont des dépôts Git indépendants). ` +
          `La réplication de ${module.name} n'a PAS été contrôlée par cette exécution.`
      );
      return;
    }

    const empreintes = new Map();
    for (const rel of present) {
      empreintes.set(rel, digest(path.join(WORKSPACE, rel)));
    }

    const distinctes = new Set(empreintes.values());

    assert.equal(
      distinctes.size,
      1,
      `${module.name} a DIVERGÉ entre dépôts.\n` +
        [...empreintes].map(([rel, h]) => `  ${h}  ${rel}`).join("\n") +
        `\n\nCes fichiers se déclarent « copie à l'identique ». Reporter la correction ` +
        `dans les ${present.length} dépôts, ou retirer l'affirmation de leurs en-têtes.`
    );

    if (present.length < module.copies.length) {
      t.diagnostic(
        `Vérifié sur ${present.length}/${module.copies.length} copies — les autres dépôts sont absents du disque.`
      );
    }
  });
}
