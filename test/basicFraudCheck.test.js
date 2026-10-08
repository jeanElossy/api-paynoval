"use strict";

/**
 * Garde du contrôle anti-doublon `detectBasicFraud` (corrigé le 2026-10-08).
 *
 * Avant : un DÉPÔT passait le numéro du payeur comme `sender` (400 « Sender
 * invalide pour anti-fraude ») et un RETRAIT passait le numéro du bénéficiaire
 * comme `receiverEmail` (400 « receiverEmail invalide pour anti-fraude ») :
 * aucune opération externe n'aboutissait. Ces tests échouent sur l'ancienne
 * version.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { detectBasicFraud } = require("../src/services/validationService");

const ACCOUNT = "64b7f0c2a1b2c3d4e5f60718";

function fakeModel(found = null) {
  const calls = [];
  return {
    calls,
    findOne(query) {
      calls.push(query);
      return { sort: () => ({ lean: async () => found }) };
    },
  };
}

test("dépôt mobile money : l'initiateur est le titulaire, aucun numéro exigé", async () => {
  const Model = fakeModel();
  await detectBasicFraud({
    initiator: ACCOUNT,
    flow: "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
    amount: 25000,
    currency: "XOF",
    Model,
  });
  assert.equal(Model.calls.length, 1);
  const q = Model.calls[0];
  assert.deepEqual(q.$or, [{ userId: ACCOUNT }, { sender: ACCOUNT }]);
  assert.equal(q.flow, "MOBILEMONEY_COLLECTION_TO_PAYNOVAL");
  assert.equal(q.senderCurrencySymbol, "XOF");
  assert.equal(q.recipientEmail, undefined);
});

test("retrait mobile money : aucun e-mail de destinataire exigé", async () => {
  const Model = fakeModel();
  await detectBasicFraud({
    initiator: ACCOUNT,
    flow: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
    amount: 5000,
    currency: "XOF",
    Model,
  });
  assert.equal(Model.calls[0].flow, "PAYNOVAL_TO_MOBILEMONEY_PAYOUT");
});

test("virement interne : l'e-mail du destinataire restreint la recherche", async () => {
  const Model = fakeModel();
  await detectBasicFraud({
    initiator: ACCOUNT,
    receiverEmail: " Ami@Example.com ",
    flow: "PAYNOVAL_INTERNAL_TRANSFER",
    amount: 10,
    currency: "EUR",
    Model,
  });
  assert.equal(Model.calls[0].recipientEmail, "ami@example.com");
});

test("doublon récent ⇒ 429", async () => {
  const Model = fakeModel({ _id: "x" });
  await assert.rejects(
    detectBasicFraud({ initiator: ACCOUNT, flow: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT", amount: 5000, currency: "XOF", Model }),
    (err) => err.status === 429
  );
});

test("échoue en fermeture : initiateur illisible, montant illisible, ni contrepartie ni flow", async () => {
  const Model = fakeModel();
  await assert.rejects(
    detectBasicFraud({ initiator: "+2250700000000", flow: "X", amount: 10, currency: "XOF", Model }),
    (err) => err.status === 400
  );
  await assert.rejects(
    detectBasicFraud({ initiator: ACCOUNT, flow: "X", amount: "abc", currency: "XOF", Model }),
    (err) => err.status === 400
  );
  await assert.rejects(
    detectBasicFraud({ initiator: ACCOUNT, amount: 10, currency: "XOF", Model }),
    (err) => err.status === 400
  );
  assert.equal(Model.calls.length, 0);
});

test("les trois appelants passent le compte PayNoval comme initiateur", () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  const external = read("src/services/transactions/handlers/initiateExternalTransactions.js");
  const internal = read("src/services/transactions/handlers/initiateInternal.js");

  const calls = [...external.matchAll(/detectBasicFraud\(\{([\s\S]*?)\}\);/g)].map((m) => m[1]);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /initiator:\s*senderId/);
  assert.match(calls[1], /initiator:\s*receiverId/);
  for (const c of calls) {
    assert.doesNotMatch(c, /phoneNumber|receiverEmail|sender:/);
  }
  assert.match(internal, /detectBasicFraud\(\{\s*initiator:\s*senderId/);
});
