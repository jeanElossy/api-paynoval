"use strict";

/**
 * Socle de l'idempotence de l'API (motif Stripe).
 *
 * L'empreinte de requête est le point délicat : elle doit être STABLE — deux
 * corps équivalents écrits dans un ordre différent donnent la même empreinte —
 * et SENSIBLE — un montant qui change donne une empreinte différente. Sans la
 * première propriété, un rejeu légitime serait pris pour une réutilisation
 * abusive de la clé. Sans la seconde, deux virements différents partageant une
 * clé se confondraient, et le second serait déclaré effectué sans l'être.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractIdempotencyKey,
  isValidIdempotencyKey,
  buildScope,
  computeRequestFingerprint,
  stableStringify,
} = require("../src/utils/idempotencyKeys");

/* -- extraction ---------------------------------------------------------- */

test("la clé est lue depuis l'en-tête, quelle que soit la casse", () => {
  assert.equal(extractIdempotencyKey({ headers: { "Idempotency-Key": "abc12345" } }), "abc12345");
  assert.equal(extractIdempotencyKey({ headers: { "idempotency-key": "abc12345" } }), "abc12345");
  assert.equal(extractIdempotencyKey({ headers: { "X-Idempotency-Key": "abc12345" } }), "abc12345");
});

test("le corps reste accepté en repli, l'en-tête restant prioritaire", () => {
  assert.equal(extractIdempotencyKey({ headers: {}, body: { idempotencyKey: "depuis-corps" } }), "depuis-corps");

  assert.equal(
    extractIdempotencyKey({
      headers: { "idempotency-key": "depuis-entete" },
      body: { idempotencyKey: "depuis-corps" },
    }),
    "depuis-entete"
  );
});

test("aucune clé => chaîne vide, jamais une erreur", () => {
  assert.equal(extractIdempotencyKey({ headers: {} }), "");
  assert.equal(extractIdempotencyKey({}), "");
});

/* -- validation ---------------------------------------------------------- */

test("une clé trop courte est refusée : elle collisionnerait trop facilement", () => {
  assert.equal(isValidIdempotencyKey("abc"), false);
  assert.equal(isValidIdempotencyKey(""), false);
  assert.equal(isValidIdempotencyKey("12345678"), true);
});

test("une clé trop longue ou aux caractères exotiques est refusée", () => {
  assert.equal(isValidIdempotencyKey("a".repeat(256)), false);
  assert.equal(isValidIdempotencyKey("clé avec espace"), false);
  assert.equal(isValidIdempotencyKey("cle/avec/slash"), false);
  assert.equal(isValidIdempotencyKey("550e8400-e29b-41d4-a716-446655440000"), true);
});

/* -- portee -------------------------------------------------------------- */

test("la portée isole par utilisateur ET par endpoint", () => {
  const a = buildScope({ userId: "u1", method: "POST", path: "/transactions/initiate" });
  const b = buildScope({ userId: "u2", method: "POST", path: "/transactions/initiate" });
  const c = buildScope({ userId: "u1", method: "POST", path: "/transactions/cancel" });

  assert.notEqual(a, b, "deux utilisateurs ne doivent pas partager une clé");
  assert.notEqual(a, c, "une clé consommée sur initiate ne vaut pas sur cancel");
});

/* -- empreinte ----------------------------------------------------------- */

test("l'ordre des champs ne change pas l'empreinte", () => {
  const f1 = computeRequestFingerprint({
    method: "POST",
    path: "/x",
    body: { amount: 100, currency: "XOF", to: "a@b.c" },
  });

  const f2 = computeRequestFingerprint({
    method: "POST",
    path: "/x",
    body: { to: "a@b.c", currency: "XOF", amount: 100 },
  });

  assert.equal(f1, f2);
});

test("un montant différent change l'empreinte", () => {
  const base = { method: "POST", path: "/x", body: { amount: 100, to: "a@b.c" } };
  const autre = { method: "POST", path: "/x", body: { amount: 100000, to: "a@b.c" } };

  assert.notEqual(computeRequestFingerprint(base), computeRequestFingerprint(autre));
});

test("un destinataire différent change l'empreinte", () => {
  const base = { method: "POST", path: "/x", body: { amount: 100, to: "a@b.c" } };
  const autre = { method: "POST", path: "/x", body: { amount: 100, to: "z@b.c" } };

  assert.notEqual(computeRequestFingerprint(base), computeRequestFingerprint(autre));
});

test("la stabilité vaut aussi pour les objets imbriqués", () => {
  const f1 = computeRequestFingerprint({
    method: "POST", path: "/x",
    body: { meta: { b: 2, a: 1 }, list: [1, { y: 2, x: 1 }] },
  });

  const f2 = computeRequestFingerprint({
    method: "POST", path: "/x",
    body: { list: [1, { x: 1, y: 2 }], meta: { a: 1, b: 2 } },
  });

  assert.equal(f1, f2);
});

test("l'ordre d'un tableau, lui, est signifiant", () => {
  const f1 = computeRequestFingerprint({ method: "POST", path: "/x", body: { l: [1, 2] } });
  const f2 = computeRequestFingerprint({ method: "POST", path: "/x", body: { l: [2, 1] } });

  assert.notEqual(f1, f2, "[1,2] et [2,1] ne décrivent pas la même intention");
});

test("la sérialisation stable trie les clés", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableStringify(null), "null");
  assert.equal(stableStringify(undefined), "null");
});
