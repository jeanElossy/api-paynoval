"use strict";

/**
 * Première suite de tests de ce dépôt. Runner NATIF (`node:test`) : aucune
 * dépendance ajoutée, aucun service démarré, aucune connexion Mongo — comme
 * dans les autres dépôts du projet, où c'est précisément ce qui rend les
 * suites utilisables au quotidien.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildUserScopeQuery } = require("../src/utils/userScopeQuery");

const USER_ID = "507f1f77bcf86cd799439011";
const OTHER_ID = "507f1f77bcf86cd799439012";

const keysOf = (clauses) => clauses.map((c) => Object.keys(c)[0]);

test("interroge les trois champs qui rattachent une transaction à un compte", () => {
  const clauses = buildUserScopeQuery(USER_ID, "");

  assert.deepEqual(keysOf(clauses), ["sender", "receiver", "userId"]);
});

test("compare des ObjectId, pas des chaînes", () => {
  const [first] = buildUserScopeQuery(USER_ID, "");

  // Une chaîne ne matcherait jamais un champ typé ObjectId : la fiche
  // paraîtrait vide alors que le compte a un historique.
  assert.equal(typeof first.sender, "object");
  assert.equal(String(first.sender), USER_ID);
});

test("accepte l'e-mail en complément, normalisé en minuscules", () => {
  const clauses = buildUserScopeQuery("", "  Jean.Elossy@Example.COM ");

  assert.deepEqual(keysOf(clauses), ["senderEmail", "recipientEmail", "toEmail"]);
  assert.equal(clauses[0].senderEmail, "jean.elossy@example.com");
});

test("combine identifiant et e-mail quand les deux sont fournis", () => {
  const clauses = buildUserScopeQuery(USER_ID, "a@b.com");

  assert.equal(clauses.length, 6);
});

test("compare l'e-mail à l'identique, jamais en expression régulière", () => {
  const [clause] = buildUserScopeQuery("", "jean@x.com");

  // Une regex ramènerait l'historique de « jean@x.com.br » ou de
  // « bigjean@x.com » dans la fiche de « jean@x.com ».
  assert.equal(typeof clause.senderEmail, "string");
  assert.equal(clause.senderEmail instanceof RegExp, false);
});

test("ne rend AUCUNE clause quand rien n'est exploitable", () => {
  // Le point critique : une portée vide doit rester vide. L'appelant refuse
  // alors la requête — sans quoi le filtre disparaîtrait et la fiche d'un
  // client afficherait l'historique de toute la plateforme.
  assert.deepEqual(buildUserScopeQuery("", ""), []);
  assert.deepEqual(buildUserScopeQuery("pas-un-id", ""), []);
  assert.deepEqual(buildUserScopeQuery(null, null), []);
  assert.deepEqual(buildUserScopeQuery(undefined, "sans-arobase"), []);
  assert.deepEqual(buildUserScopeQuery({}, []), []);
});

test("un identifiant invalide n'est pas rattrapé par un e-mail valide", () => {
  const clauses = buildUserScopeQuery("pas-un-id", "a@b.com");

  assert.deepEqual(keysOf(clauses), ["senderEmail", "recipientEmail", "toEmail"]);
});

test("deux comptes différents ne produisent jamais la même portée", () => {
  const a = JSON.stringify(buildUserScopeQuery(USER_ID, ""));
  const b = JSON.stringify(buildUserScopeQuery(OTHER_ID, ""));

  assert.notEqual(a, b);
});
