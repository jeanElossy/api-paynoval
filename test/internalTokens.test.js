"use strict";

/**
 * Ces tests protègent une faille réelle, corrigée le 2026-08-19 : le `skip` du
 * `sensitiveLimiter` testait la seule PRÉSENCE de l'en-tête `x-internal-token`.
 * `x-internal-token: x` levait donc la limite de 10 requêtes/minute sur
 * `/initiate`, `/confirm` et `/cancel` — c'est-à-dire autorisait le martèlement
 * des codes de sécurité de confirmation.
 *
 * Ils échoueront si la faute est réintroduite.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  timingSafeEqualStr,
  extractInternalToken,
  matchesAnyToken,
} = require("../src/utils/internalTokens");

const EXPECTED = "token-interne-attendu";

test("un token quelconque ne vaut pas autorisation", () => {
  assert.equal(matchesAnyToken("x", [EXPECTED]), false);
  assert.equal(matchesAnyToken("token", [EXPECTED]), false);
});

test("un préfixe du bon token est refusé", () => {
  assert.equal(matchesAnyToken("token-interne", [EXPECTED]), false);
});

test("le bon token est accepté", () => {
  assert.equal(matchesAnyToken(EXPECTED, [EXPECTED]), true);
});

test("plusieurs tokens attendus : n'importe lequel convient", () => {
  assert.equal(matchesAnyToken("second", ["premier", "second"]), true);
  assert.equal(matchesAnyToken("troisieme", ["premier", "second"]), false);
});

test("aucun token attendu => refus, jamais autorisation par défaut", () => {
  assert.equal(matchesAnyToken(EXPECTED, []), false);
  assert.equal(matchesAnyToken(EXPECTED, [""]), false);
  assert.equal(matchesAnyToken(EXPECTED, [null, undefined]), false);
});

test("token vide ou absent => refus", () => {
  assert.equal(matchesAnyToken("", [EXPECTED]), false);
  assert.equal(matchesAnyToken(null, [EXPECTED]), false);
  assert.equal(matchesAnyToken("   ", [EXPECTED]), false);
});

test("l'en-tête est lu quelle que soit la casse", () => {
  assert.equal(extractInternalToken({ headers: { "x-internal-token": "a" } }), "a");
  assert.equal(extractInternalToken({ headers: { "X-Internal-Token": "b" } }), "b");
  assert.equal(extractInternalToken({ headers: { "X-INTERNAL-TOKEN": "c" } }), "c");
  assert.equal(extractInternalToken({ headers: {} }), "");
  assert.equal(extractInternalToken({}), "");
});

test("la comparaison distingue longueur et contenu", () => {
  assert.equal(timingSafeEqualStr("abc", "abc"), true);
  assert.equal(timingSafeEqualStr("abc", "abcd"), false);
  assert.equal(timingSafeEqualStr("abcd", "abc"), false);
  assert.equal(timingSafeEqualStr("abc", "abd"), false);
  assert.equal(timingSafeEqualStr("", ""), true);
});
