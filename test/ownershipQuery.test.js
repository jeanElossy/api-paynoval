"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOwnershipQuery,
  modelHasPath,
  OWNERSHIP_FIELDS,
} = require("../src/services/transactions/shared/ownershipQuery");

/**
 * Faux modèle Mongoose : `schema.path(nom)` rend une valeur pour les champs
 * déclarés, `undefined` sinon. C'est exactement ce que `modelHasPath`
 * interroge.
 */
function fakeModel(declaredFields) {
  const set = new Set(declaredFields);

  return {
    schema: {
      path(name) {
        return set.has(name) ? { instance: "ObjectId" } : undefined;
      },
    },
  };
}

/** Le schéma `Transaction` réel, au 2026-08-25. */
const REAL_SCHEMA_FIELDS = ["sender", "receiver", "userId"];

/** Les trois champs qui provoquaient le balayage complet. */
const PHANTOM_FIELDS = ["receiverUserId", "createdBy", "ownerUserId"];

test("le schéma réel ne produit que des branches indexées", () => {
  const q = buildOwnershipQuery(fakeModel(REAL_SCHEMA_FIELDS), "u1");

  assert.deepEqual(q, {
    $or: [{ sender: "u1" }, { receiver: "u1" }, { userId: "u1" }],
  });
});

test("aucun champ fantôme ne survit dans la requête", () => {
  const q = buildOwnershipQuery(fakeModel(REAL_SCHEMA_FIELDS), "u1");
  const serialized = JSON.stringify(q);

  for (const ghost of PHANTOM_FIELDS) {
    assert.ok(
      !serialized.includes(ghost),
      `${ghost} n'est pas au schéma : sa présence rendrait le $or non indexable ` +
        `et ferait basculer MongoDB en balayage complet de collection`
    );
  }
});

test("un champ fantôme reste ignoré même s'il figure dans la liste", () => {
  // La liste les contient volontairement — c'est la garde qui les écarte, pas
  // leur absence de la liste.
  for (const ghost of PHANTOM_FIELDS) {
    assert.ok(
      OWNERSHIP_FIELDS.includes(ghost),
      `${ghost} doit rester listé pour être récupéré s'il entre au schéma`
    );
  }

  const q = buildOwnershipQuery(fakeModel(REAL_SCHEMA_FIELDS), "u1");
  assert.equal(q.$or.length, 3);
});

test("la garde est auto-corrigeante : un champ ajouté au schéma revient", () => {
  const q = buildOwnershipQuery(
    fakeModel([...REAL_SCHEMA_FIELDS, "ownerUserId"]),
    "u1"
  );

  assert.deepEqual(q, {
    $or: [
      { sender: "u1" },
      { receiver: "u1" },
      { userId: "u1" },
      { ownerUserId: "u1" },
    ],
  });
});

test("un seul champ déclaré ne produit pas un $or à une branche", () => {
  const q = buildOwnershipQuery(fakeModel(["userId"]), "u1");

  assert.deepEqual(q, { userId: "u1" });
  assert.ok(!("$or" in q), "un $or à une branche coûte plus cher à planifier");
});

test("aucun champ déclaré : repli sur userId, jamais un $or vide", () => {
  const q = buildOwnershipQuery(fakeModel([]), "u1");

  assert.deepEqual(q, { userId: "u1" });
  assert.ok(!("$or" in q), "un $or vide est une erreur MongoDB");
});

test("un modèle absent ou cassé ne fait pas échouer l'historique", () => {
  assert.deepEqual(buildOwnershipQuery(null, "u1"), { userId: "u1" });
  assert.deepEqual(buildOwnershipQuery(undefined, "u1"), { userId: "u1" });
  assert.deepEqual(buildOwnershipQuery({}, "u1"), { userId: "u1" });

  const throwing = {
    schema: {
      path() {
        throw new Error("schéma indisponible");
      },
    },
  };

  assert.deepEqual(buildOwnershipQuery(throwing, "u1"), { userId: "u1" });
});

test("modelHasPath ne lève jamais", () => {
  assert.equal(modelHasPath(null, "sender"), false);
  assert.equal(modelHasPath({}, "sender"), false);
  assert.equal(modelHasPath({ schema: null }, "sender"), false);
  assert.equal(modelHasPath(fakeModel(["sender"]), "sender"), true);
  assert.equal(modelHasPath(fakeModel(["sender"]), "ownerUserId"), false);
});

test("l'ordre des branches suit celui de la liste", () => {
  // L'ordre n'a pas d'incidence sur le résultat, mais il rend le plan de
  // requête reproductible d'une exécution à l'autre — utile pour comparer deux
  // `explain()`.
  const q = buildOwnershipQuery(fakeModel(REAL_SCHEMA_FIELDS), "u1");
  const order = q.$or.map((b) => Object.keys(b)[0]);

  assert.deepEqual(order, ["sender", "receiver", "userId"]);
});

test("l'identifiant est repris tel quel, sans transformation", () => {
  // Un ObjectId doit rester un ObjectId : le convertir en chaîne ferait échouer
  // l'appariement sur un champ typé ObjectId.
  const oid = { _bsontype: "ObjectID", toString: () => "507f1f77bcf86cd799439011" };
  const q = buildOwnershipQuery(fakeModel(REAL_SCHEMA_FIELDS), oid);

  assert.equal(q.$or[0].sender, oid);
});
