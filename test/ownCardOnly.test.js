"use strict";

/**
 * Carte du compte obligatoire (2026-11-04) : la carte qui paie, et celle qui
 * reçoit un RETRAIT, doivent être des cartes enregistrées du compte.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { cardCountry } = require("../src/middleware/cardCountry");

const own = { _id: "c1", last4: "4242", issuerCountry: "FR" };
const loadCard = async (_userId, cardId) => (cardId === "c1" ? own : null);

async function run(body, user = { _id: "u", mode: "live" }) {
  const req = { user, body: { ...body } };
  let error = null;
  await new Promise((done) =>
    cardCountry({ loadCard })(req, {}, (err) => {
      error = err || null;
      done();
    })
  );
  return { error, body: req.body };
}

test("dépôt par carte : une carte du compte passe, une autre est refusée (compte réel ET simulation)", async () => {
  assert.equal((await run({ funds: "visa_direct", cardId: "c1" })).error, null);
  for (const user of [{ _id: "u", mode: "live" }, { _id: "u", mode: "sandbox", country: "France" }]) {
    assert.equal((await run({ funds: "visa_direct", cardId: "autre" }, user)).error?.code, "CARD_NOT_OWNED");
    assert.equal((await run({ funds: "card" }, user)).error?.code, "CARD_NOT_OWNED");
  }
});

test("retrait vers une carte : seulement une carte du compte, ses 4 chiffres relus en base", async () => {
  const ok = await run({ destination: "visa_direct", txType: "withdraw", cardId: "c1", cardLast4: "0000" });
  assert.equal(ok.error, null);
  assert.equal(ok.body.cardLast4, "4242");

  assert.equal((await run({ destination: "visa_direct", txType: "withdraw", cardId: "autre" })).error?.code, "CARD_NOT_OWNED");
  assert.equal((await run({ destination: "card", operationType: "WITHDRAW" })).error?.code, "CARD_NOT_OWNED");
});

test("un transfert vers la carte d'un TIERS n'est pas concerné (lien SMS + code + question)", async () => {
  assert.equal((await run({ destination: "visa_direct", txType: "transfer" })).error, null);
});
