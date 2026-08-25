"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

/**
 * Vérifie le **câblage** entre le schéma `Transaction` et le sérialiseur.
 *
 * `test/transactionSerializer.test.js` couvre la fonction pure ; il ne peut pas
 * détecter qu'on a oublié de la brancher sur le schéma. C'est pourtant ce
 * branchement qui protège `GET /api/v1/transactions` : depuis le passage en
 * `.lean()`, si le `toJSON` du schéma et la lecture de l'historique cessaient
 * d'appeler la même fonction, l'un des deux chemins recommencerait à publier
 * des secrets.
 *
 * ⚠️ `mongoose.createConnection()` sans URI ne se connecte à rien : elle crée
 * l'objet Connection nécessaire à la factory du modèle, sans ouvrir de socket.
 * La règle du dépôt — aucun test n'ouvre de connexion Mongo, toutes les suites
 * se terminent seules — reste tenue.
 */

const SECRETS = [
  "securityCode",
  "securityAnswerHash",
  "verificationToken",
  "attemptCount",
  "lastAttemptAt",
  "lockedUntil",
];

function buildDoc(overrides = {}) {
  const conn = mongoose.createConnection();
  const Transaction = require("../src/models/Transaction")(conn);

  return new Transaction({
    flow: "PAYNOVAL_INTERNAL_TRANSFER",
    sender: new mongoose.Types.ObjectId(),
    receiver: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    amount: 1500.5,
    netAmount: 1450.5,
    transactionFees: 50,
    currency: "XOF",
    securityAnswerHash: "sha256:SECRET",
    verificationToken: "vt_SECRET",
    securityCode: "123456",
    attemptCount: 2,
    ...overrides,
  });
}

test("le toJSON du schéma ne publie aucun secret", () => {
  const json = buildDoc().toJSON();

  for (const field of SECRETS) {
    assert.ok(
      !(field in json),
      `${field} ressort de toJSON — le schéma n'appelle plus le sérialiseur`
    );
  }
});

test("le toJSON du schéma rend les montants en nombres", () => {
  const json = buildDoc().toJSON();

  assert.equal(typeof json.amount, "number");
  assert.equal(json.amount, 1500.5);
  assert.equal(json.netAmount, 1450.5);
  assert.equal(json.transactionFees, 50);
});

test("le toJSON du schéma expose id et retire _id et __v", () => {
  const json = buildDoc().toJSON();

  assert.ok(json.id, "id doit être exposé");
  assert.ok(!("_id" in json));
  assert.ok(!("__v" in json));
});

test("schéma et lecture .lean() produisent la même surface publique", () => {
  const doc = buildDoc();

  const fromSchema = doc.toJSON();

  // Ce que Mongo rendrait en `.lean()` : un objet simple, sans méthode.
  const { toPublicTransaction } = require("../src/models/transactionSerializer");
  const fromLean = toPublicTransaction(doc.toObject());

  for (const field of SECRETS) {
    assert.ok(!(field in fromSchema), `${field} fuit par le schéma`);
    assert.ok(!(field in fromLean), `${field} fuit par le chemin .lean()`);
  }

  assert.equal(typeof fromLean.amount, "number");
  assert.equal(fromLean.amount, fromSchema.amount);
  assert.equal(String(fromLean.id), String(fromSchema.id));
});
