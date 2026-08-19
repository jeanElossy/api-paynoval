"use strict";

/**
 * Seaux de limitation de debit.
 *
 * Le defaut corrige ici n'etait pas une valeur trop basse mais une CLE
 * inadaptee : Tx-Core ne voit que les adresses de la passerelle, donc un
 * plafond par IP comptait tous les utilisateurs ensemble. Le 2026-08-19, un
 * seul compte a suffi a faire repondre 429 a GET /api/v1/transactions.
 *
 * Les tests portent donc surtout sur l'ISOLATION : deux utilisateurs distincts
 * ne doivent jamais partager un seau, et un jeton non verifie ne doit jamais
 * en ouvrir un neuf.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bearerToken,
  userIdFromClaims,
  identify,
  bucketFor,
  limitFor,
  DEFAULT_AUTH_MAX,
  DEFAULT_ANON_MAX,
} = require("../src/utils/rateLimitKey");

const reqWith = (authorization, ip = "10.0.0.1") => ({
  headers: authorization ? { authorization } : {},
  ip,
});

const acceptAll = (token) => ({ sub: `user-of-${token}` });
const rejectAll = () => {
  throw new Error("signature invalide");
};

test("extrait un jeton Bearer, et rien d'autre", () => {
  assert.equal(bearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(bearerToken("bearer abc"), "abc");
  assert.equal(bearerToken("  Bearer   abc  "), "abc");

  for (const bad of [null, undefined, 42, "", "abc", "Basic abc", "Bearer", "Bearer a b"]) {
    assert.equal(bearerToken(bad), null, `devrait refuser : ${String(bad)}`);
  }
});

test("lit l'identifiant utilisateur dans l'ordre de authMiddleware", () => {
  assert.equal(userIdFromClaims({ sub: "a" }), "a");
  assert.equal(userIdFromClaims({ id: "b" }), "b");
  assert.equal(userIdFromClaims({ userId: "c" }), "c");
  assert.equal(userIdFromClaims({ _id: "d" }), "d");
  assert.equal(userIdFromClaims({ sub: "a", id: "b" }), "a");
});

test("ne fabrique pas d'identite a partir de rien", () => {
  for (const bad of [null, undefined, {}, { sub: "" }, { sub: "   " }, "abc", 42]) {
    assert.equal(userIdFromClaims(bad), null);
  }
});

test("un jeton valide donne un seau propre a l'utilisateur", () => {
  const who = identify(reqWith("Bearer jeton-a"), acceptAll);

  assert.equal(who.verified, true);
  assert.equal(bucketFor({ ...who, ip: "10.0.0.1" }), "u:user-of-jeton-a");
});

/** LE TEST CENTRAL : c'est ce partage qui a provoque l'incident. */
test("deux utilisateurs derriere la MEME adresse ne partagent pas de seau", () => {
  const a = identify(reqWith("Bearer jeton-a"), acceptAll);
  const b = identify(reqWith("Bearer jeton-b"), acceptAll);

  const bucketA = bucketFor({ ...a, ip: "10.0.0.1" });
  const bucketB = bucketFor({ ...b, ip: "10.0.0.1" });

  assert.notEqual(bucketA, bucketB);
});

test("le meme utilisateur garde son seau en changeant d'adresse", () => {
  const who = identify(reqWith("Bearer jeton-a"), acceptAll);

  assert.equal(
    bucketFor({ ...who, ip: "10.0.0.1" }),
    bucketFor({ ...who, ip: "203.0.113.9" })
  );
});

test("une signature invalide ne donne pas de seau personnel", () => {
  const who = identify(reqWith("Bearer forge"), rejectAll);

  assert.equal(who.verified, false);
  assert.equal(who.userId, null);
  assert.equal(bucketFor({ ...who, ip: "10.0.0.1" }), "ip:10.0.0.1");
});

/**
 * Sans cela, forger des jetons au hasard ouvrirait un quota neuf a chaque
 * requete — la limitation ne limiterait plus rien.
 */
test("mille jetons forges retombent tous dans le meme seau", () => {
  const buckets = new Set();

  for (let i = 0; i < 1000; i += 1) {
    const who = identify(reqWith(`Bearer forge-${i}`), rejectAll);
    buckets.add(bucketFor({ ...who, ip: "10.0.0.1" }));
  }

  assert.equal(buckets.size, 1);
});

test("une requete sans jeton retombe sur l'adresse", () => {
  const who = identify(reqWith(null), acceptAll);

  assert.equal(who.verified, false);
  assert.equal(bucketFor({ ...who, ip: "198.51.100.7" }), "ip:198.51.100.7");
});

test("une adresse absente ne produit jamais une cle vide", () => {
  const bucket = bucketFor({ userId: null, verified: false, ip: undefined });

  assert.equal(bucket, "ip:unknown");
  assert.ok(bucket.length > 0);
});

test("le plafond est genereux pour un compte, restreint sinon", () => {
  assert.equal(limitFor({ verified: true }), DEFAULT_AUTH_MAX);
  assert.equal(limitFor({ verified: false }), DEFAULT_ANON_MAX);
  assert.ok(DEFAULT_AUTH_MAX > DEFAULT_ANON_MAX);
});

test("les plafonds restent surchargeables", () => {
  assert.equal(limitFor({ verified: true }, { authMax: 42 }), 42);
  assert.equal(limitFor({ verified: false }, { anonMax: 7 }), 7);
});

test("identify ne leve jamais, quelle que soit la requete", () => {
  for (const req of [undefined, null, {}, { headers: null }, { headers: {} }]) {
    assert.doesNotThrow(() => identify(req, acceptAll));
    assert.equal(identify(req, acceptAll).verified, false);
  }

  assert.doesNotThrow(() => identify(reqWith("Bearer x"), null));
  assert.doesNotThrow(() => identify(reqWith("Bearer x"), () => null));
});
