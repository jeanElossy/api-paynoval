"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  serializeTransaction,
  toPublicTransaction,
  SECRET_FIELDS,
} = require("../src/models/transactionSerializer");

/**
 * Ces tests couvrent la régression que le passage en `.lean()` rendait possible.
 *
 * Avant le 2026-08-25, c'était le `toJSON()` de Mongoose qui retirait les
 * secrets d'une transaction. `.lean()` rend des objets simples, sans `toJSON()` :
 * si la sérialisation avait été oubliée, `GET /api/v1/transactions` aurait
 * renvoyé `securityAnswerHash` et `verificationToken` avec un 200, sans rien
 * casser d'observable. C'est cette silence-là qu'on teste.
 */

function buildRawTransaction(extra = {}) {
  return {
    _id: "tx_1",
    reference: "PN-0001",
    status: "confirmed",
    amount: { toString: () => "1500.50" },
    netAmount: { toString: () => "1450.50" },
    transactionFees: { toString: () => "50" },
    securityCode: "123456",
    securityAnswerHash: "sha256:deadbeef",
    verificationToken: "vt_secret",
    attemptCount: 3,
    lastAttemptAt: new Date("2026-08-01"),
    lockedUntil: new Date("2026-08-02"),
    __v: 7,
    ...extra,
  };
}

test("aucun secret ne survit à la sérialisation", () => {
  const out = serializeTransaction(buildRawTransaction());

  for (const field of SECRET_FIELDS) {
    assert.ok(
      !(field in out),
      `${field} ne doit jamais être transmis au client`
    );
  }
});

test("la liste des secrets couvre bien ce que retirait l'ancien toJSON", () => {
  // Reprise littérale des `delete` que portait `transactionSchema.set("toJSON")`
  // avant l'extraction. Ce test échoue si quelqu'un raccourcit la liste.
  const historical = [
    "securityCode",
    "securityAnswerHash",
    "verificationToken",
    "attemptCount",
    "lastAttemptAt",
    "lockedUntil",
  ];

  for (const field of historical) {
    assert.ok(
      SECRET_FIELDS.includes(field),
      `${field} était retiré avant l'extraction, il doit l'être encore`
    );
  }
});

test("_id devient id, et _id disparaît", () => {
  const out = serializeTransaction(buildRawTransaction());

  assert.equal(out.id, "tx_1");
  assert.ok(!("_id" in out));
});

test("les Decimal128 sortent en nombres exploitables", () => {
  const out = serializeTransaction(buildRawTransaction());

  assert.equal(out.amount, 1500.5);
  assert.equal(out.netAmount, 1450.5);
  assert.equal(out.transactionFees, 50);
  assert.equal(typeof out.amount, "number");
});

test("__v n'apparaît pas — .lean() le rendrait, pas toJSON", () => {
  const out = serializeTransaction(buildRawTransaction());
  assert.ok(!("__v" in out));
});

test("le sous-objet money est normalisé sans être muté à la source", () => {
  const money = {
    source: { amount: "1000", currency: "XOF" },
    feeSource: { amount: "25", currency: "XOF" },
    target: { amount: "1.63", currency: "EUR" },
    fxRateSourceToTarget: "0.00163",
  };

  const raw = buildRawTransaction({ money });
  const out = serializeTransaction(raw);

  assert.equal(out.money.source.amount, 1000);
  assert.equal(out.money.feeSource.amount, 25);
  assert.equal(out.money.target.amount, 1.63);
  assert.equal(out.money.fxRateSourceToTarget, 0.00163);

  // La source garde ses chaînes : muter en place corromprait le document pour
  // tout ce qui le relirait dans la même requête.
  assert.equal(money.source.amount, "1000");
  assert.equal(money.fxRateSourceToTarget, "0.00163");
});

test("toPublicTransaction ne mute pas l'objet reçu", () => {
  const raw = buildRawTransaction();
  const out = toPublicTransaction(raw);

  assert.ok(!("securityAnswerHash" in out));
  assert.equal(
    raw.securityAnswerHash,
    "sha256:deadbeef",
    "l'objet d'origine doit rester intact"
  );
  assert.equal(raw._id, "tx_1");
});

test("les entrées vides ou non-objets traversent sans lever", () => {
  assert.equal(serializeTransaction(null), null);
  assert.equal(serializeTransaction(undefined), undefined);
  assert.equal(toPublicTransaction(null), null);
  assert.deepEqual(serializeTransaction({}), {});
});

test("un champ décimal absent n'est pas inventé", () => {
  const out = serializeTransaction({ _id: "tx_2", status: "pending" });

  assert.ok(!("amount" in out), "ne pas créer de clé absente du document");
  assert.equal(out.id, "tx_2");
});
