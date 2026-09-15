"use strict";

/**
 * Un index DÉCLARÉ peut être « manquant » alors que la base porte déjà un
 * index sur la même clé, d'une autre nature — reste d'un ancien schéma.
 * `createIndex` y échoue. Constaté le 2026-09-15 : `tx_cagnotte_settlements`
 * portait `{userId, idempotencyKey}` SIMPLE, là où le schéma exige l'unicité
 * qui empêche deux règlements pour une même clé d'idempotence (invariant 3).
 *
 * Ces tests visent les fonctions pures ; aucune base.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { diagnostiquerDivergence, commandesConversion } = require("../src/services/indexAudit");

const idx = (key, extra = {}) => ({ key, name: Object.entries(key).map(([k, v]) => `${k}_${v}`).join("_"), ...extra });

test("divergence : aucun index sur la clé ⇒ null, c'est un vrai manque", () => {
  assert.equal(diagnostiquerDivergence({ a: 1 }, { unique: true }, [idx({ _id: 1 }), idx({ b: 1 })]), null);
});

test("divergence : l'ordre des champs compte — {b,a} n'est pas {a,b}", () => {
  assert.equal(diagnostiquerDivergence({ a: 1, b: 1 }, { unique: true }, [idx({ b: 1, a: 1 })]), null);
});

test("divergence : simple en base, unique déclaré ⇒ conversion en unique", () => {
  const d = diagnostiquerDivergence({ userId: 1, idempotencyKey: 1 }, { unique: true, background: true }, [
    idx({ userId: 1, idempotencyKey: 1 }),
  ]);
  assert.deepEqual(d, { nomReel: "userId_1_idempotencyKey_1", conversion: "unique" });
});

test("divergence : simple en base, TTL déclaré sur un champ ⇒ conversion en TTL", () => {
  const d = diagnostiquerDivergence({ startedAt: 1 }, { expireAfterSeconds: 15552000, name: "reconciliation_runs_ttl" }, [
    idx({ startedAt: 1 }),
  ]);
  assert.deepEqual(d, { nomReel: "startedAt_1", conversion: "ttl", expireAfterSeconds: 15552000 });
});

test("divergence : une unicité en base non déclarée ne se RELÂCHE jamais automatiquement", () => {
  const d = diagnostiquerDivergence({ a: 1 }, { expireAfterSeconds: 60 }, [idx({ a: 1 }, { unique: true })]);
  assert.equal(d.conversion, null);
  assert.match(d.raison, /unique présent en base/);
});

test("divergence : un filtre partiel ne s'ajoute pas en place", () => {
  const d = diagnostiquerDivergence({ a: 1 }, { unique: true, partialFilterExpression: { a: { $type: "string" } } }, [
    idx({ a: 1 }),
  ]);
  assert.equal(d.conversion, null);
  assert.match(d.raison, /partiel/);
});

test("divergence : TTL sur une clé composée ⇒ non convertible (MongoDB ne l'accepte pas)", () => {
  const d = diagnostiquerDivergence({ a: 1, b: 1 }, { expireAfterSeconds: 60 }, [idx({ a: 1, b: 1 })]);
  assert.equal(d.conversion, null);
});

test("divergence : entrées absurdes ne lèvent pas", () => {
  assert.equal(diagnostiquerDivergence(null, null, null), null);
  assert.equal(diagnostiquerDivergence({ a: 1 }, null, undefined), null);
});

test("conversion unique : prepareUnique AVANT unique — jamais de fenêtre sans garde", () => {
  const cmds = commandesConversion("tx_cagnotte_settlements", { userId: 1, idempotencyKey: 1 }, { conversion: "unique" });
  assert.deepEqual(cmds, [
    { collMod: "tx_cagnotte_settlements", index: { keyPattern: { userId: 1, idempotencyKey: 1 }, prepareUnique: true } },
    { collMod: "tx_cagnotte_settlements", index: { keyPattern: { userId: 1, idempotencyKey: 1 }, unique: true } },
  ]);
});

test("conversion TTL : une seule commande, la durée déclarée", () => {
  assert.deepEqual(commandesConversion("reconciliation_runs", { startedAt: 1 }, { conversion: "ttl", expireAfterSeconds: 42 }), [
    { collMod: "reconciliation_runs", index: { keyPattern: { startedAt: 1 }, expireAfterSeconds: 42 } },
  ]);
});

test("conversion : un écart non convertible ne produit AUCUNE commande", () => {
  assert.deepEqual(commandesConversion("c", { a: 1 }, { conversion: null, raison: "x" }), []);
  assert.deepEqual(commandesConversion("c", { a: 1 }, null), []);
});

test("script : la conversion passe par collMod, jamais par suppression puis recréation", () => {
  // Supprimer l'index simple pour poser l'unique laisserait la collection
  // sans aucune garde le temps de la construction — et sans aucune si la
  // création échoue sur un doublon.
  const src = fs.readFileSync(path.join(__dirname, "../scripts/ensureIndexes.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/\.dropIndex(es)?\s*\(/.test(code), "ensureIndexes ne doit JAMAIS supprimer d'index");
  assert.ok(/commandesConversion\(/.test(code), "la conversion doit passer par commandesConversion");
  assert.ok(/--convert/.test(code), "la conversion exige un drapeau explicite");
});
