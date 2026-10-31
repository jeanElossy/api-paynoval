"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { readSessionRefusal } = require("../src/middleware/sessionRevocation");

const SID = "64ab64ab64ab64ab64ab64ab";
const NOW = Date.parse("2026-10-30T12:00:00Z");
const databaseWith = (session) => ({
  collection: () => ({ findOne: async () => session }),
});

test("un client sans révocation passe sans lire de session", async () => {
  const refusal = await readSessionRefusal({ user: { role: "user" }, decoded: {}, database: null });
  assert.equal(refusal, null);
});

test("un jeton antérieur à la déconnexion forcée est refusé", async () => {
  const refusal = await readSessionRefusal({
    user: { role: "user", tokensInvalidBefore: new Date(NOW) },
    decoded: { iat: NOW / 1000 - 60 },
    database: null,
  });
  assert.equal(refusal.status, 401);
});

test("un jeton du personnel sans session est refusé", async () => {
  const refusal = await readSessionRefusal({ user: { role: "admin" }, decoded: {}, database: null });
  assert.equal(refusal.status, 401);
});

test("les rôles finance et lecture seule sont bien du personnel", async () => {
  for (const role of ["finance", "readonly"]) {
    const refusal = await readSessionRefusal({ user: { role }, decoded: {}, database: null });
    assert.equal(refusal.status, 401);
  }
});

test("une session révoquée ou expirée est refusée", async () => {
  for (const session of [
    null,
    { revokedAt: new Date(NOW), absoluteExpiresAt: new Date(NOW + 1000) },
    { revokedAt: null, absoluteExpiresAt: new Date(NOW - 1) },
  ]) {
    const refusal = await readSessionRefusal({
      user: { role: "admin", _id: "u1" },
      decoded: { sid: SID },
      database: databaseWith(session),
      now: NOW,
    });
    assert.equal(refusal.status, 401);
  }
});

test("une session vivante passe", async () => {
  const refusal = await readSessionRefusal({
    user: { role: "superadmin", _id: "u1" },
    decoded: { sid: SID },
    database: databaseWith({ revokedAt: null, absoluteExpiresAt: new Date(NOW + 1000) }),
    now: NOW,
  });
  assert.equal(refusal, null);
});

test("une panne de lecture ferme l'accès", async () => {
  const refusal = await readSessionRefusal({
    user: { role: "admin", _id: "u1" },
    decoded: { sid: SID },
    database: { collection: () => ({ findOne: async () => { throw new Error("down"); } }) },
  });
  assert.equal(refusal.status, 503);
});
