"use strict";

/**
 * V1 COUNTRIES — pinned end to end on the corridor validators.
 *
 * V1 = DEUX PAYS (décision du 2026-11-10) : Côte d'Ivoire et Canada.
 * Comptes : CI, CA. Un transfert se reçoit par mobile money en Côte d'Ivoire
 * (Orange, MTN, Moov, Wave), par carte au Canada. PayNoval ↔ PayNoval entre
 * les deux. Compte ivoirien : dépôt / retrait mobile money seulement ; compte
 * canadien : carte seulement — aucune carte en Afrique (2026-11-03).
 * Les huit pays retirés (États-Unis, France, Royaume-Uni, Belgique,
 * Allemagne, Espagne, Mali, Burkina Faso) sont refusés, chacun, ici.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  COUNTRY_RULES,
  validateInternalPaynovalCorridor,
  validateOutboundExternalCorridor,
  validateInboundExternalCorridor,
} = require("../src/services/transactions/handlers/corridorValidation");

const user = (country, currency, id = "u1") => ({
  _id: id,
  email: `${id}@example.com`,
  country,
  currency,
  accountStatus: "active",
});

const refusedWith = (fn, code) => {
  try {
    fn();
  } catch (err) {
    assert.equal(err.code, code, err.message);
    return;
  }
  assert.fail(`expected ${code}`);
};

const ACCOUNTS = [
  ["Canada", "CAD"],
  ["Côte d'Ivoire", "XOF"],
];

const RETIRED = [
  ["USA", "USD", "US"],
  ["France", "EUR", "FR"],
  ["Angleterre", "GBP", "GB"],
  ["Belgique", "EUR", "BE"],
  ["Allemagne", "EUR", "DE"],
  ["Espagne", "EUR", "ES"],
  ["Mali", "XOF", "ML"],
  ["Burkina Faso", "XOF", "BF"],
];

test("exactly two countries are served, and both open accounts", () => {
  assert.deepEqual(Object.keys(COUNTRY_RULES).sort(), ["canada", "cote d'ivoire"]);
  const opening = Object.entries(COUNTRY_RULES)
    .filter(([, r]) => r.accountOpening === true)
    .map(([k]) => k)
    .sort();
  assert.deepEqual(opening, ["canada", "cote d'ivoire"]);
});

test("internal transfers between the two account countries, both ways", () => {
  for (const [c1, cur1] of ACCOUNTS) {
    for (const [c2, cur2] of ACCOUNTS) {
      const res = validateInternalPaynovalCorridor({
        sender: user(c1, cur1, "s"),
        receiver: user(c2, cur2, "r"),
        sourceCountry: c1,
        targetCountry: c2,
        currencySource: cur1,
        currencyTarget: cur2,
      });
      assert.equal(res.ok, true, `${c1} -> ${c2}`);
    }
  }
});

test("a retired country can neither send nor receive a PayNoval transfer", () => {
  for (const [country, currency] of [...RETIRED, ["Sénégal", "XOF"]]) {
    refusedWith(
      () =>
        validateInternalPaynovalCorridor({
          sender: user(country, currency, "s"),
          receiver: user("Canada", "CAD", "r"),
          currencySource: currency,
          currencyTarget: "CAD",
        }),
      "SENDER_COUNTRY_NOT_SUPPORTED"
    );
    refusedWith(
      () =>
        validateInternalPaynovalCorridor({
          sender: user("Canada", "CAD", "s"),
          receiver: user(country, currency, "r"),
          currencySource: "CAD",
          currencyTarget: currency,
        }),
      "RECIPIENT_COUNTRY_NOT_SUPPORTED"
    );
  }
});

const momoPayout = (toCountry, phone, operator, sender = user("Canada", "CAD")) =>
  validateOutboundExternalCorridor({
    flow: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
    body: { destination: "mobilemoney", action: "send", phoneNumber: phone, operator },
    senderUser: sender,
    toCountry,
    currencySource: sender.currency,
    currencyTarget: "XOF",
  });

test("mobile money transfers to Côte d'Ivoire, from either account country, all four operators", () => {
  for (const op of ["orange", "mtn", "moov", "wave"]) {
    assert.equal(momoPayout("Côte d'Ivoire", "+2250701020304", op).ok, true, op);
    assert.equal(momoPayout("Côte d'Ivoire", "+2250701020304", op, user("Côte d'Ivoire", "XOF")).ok, true, op);
  }
});

test("no mobile money transfer outside Côte d'Ivoire (Mali and Burkina Faso retired)", () => {
  refusedWith(() => momoPayout("Mali", "+22370102030", "orange"), "DESTINATION_COUNTRY_NOT_SUPPORTED");
  refusedWith(() => momoPayout("Burkina Faso", "+22670102030", "moov"), "DESTINATION_COUNTRY_NOT_SUPPORTED");
  refusedWith(() => momoPayout("Sénégal", "+221701020304", "orange"), "DESTINATION_COUNTRY_NOT_SUPPORTED");
});

const cardPayout = (toCountry, cardCountry, currencyTarget, action = "send", sender = user("Canada", "CAD")) =>
  validateOutboundExternalCorridor({
    flow: "PAYNOVAL_TO_CARD_PAYOUT",
    body: { destination: "card", action, cardCountry },
    senderUser: sender,
    toCountry,
    currencySource: sender.currency,
    currencyTarget,
  });

test("card transfers are received in Canada only", () => {
  assert.equal(cardPayout("Canada", "CA", "CAD").ok, true);
  assert.equal(cardPayout("Canada", "CA", "CAD", "withdraw").ok, true);
  for (const [country, , iso] of RETIRED.filter(([, , iso]) => !["ML", "BF"].includes(iso))) {
    refusedWith(() => cardPayout(country, iso, "CAD"), "CARD_COUNTRY_NOT_SUPPORTED");
  }
});

test("no card in Africa: no card transfer to Côte d'Ivoire, no card withdrawal there", () => {
  // Réintroduire la carte dans `COUNTRY_RULES` pour l'Afrique fait échouer ce test.
  refusedWith(() => cardPayout("Côte d'Ivoire", "CI", "XOF"), "PAYOUT_RAIL_NOT_AVAILABLE_FOR_COUNTRY");
  refusedWith(
    () => cardPayout("Côte d'Ivoire", "CI", "XOF", "withdraw", user("Côte d'Ivoire", "XOF")),
    "WITHDRAW_RAIL_NOT_AVAILABLE_FOR_COUNTRY"
  );
  for (const [key, rule] of Object.entries(COUNTRY_RULES)) {
    if (rule.region !== "africa") continue;
    for (const capability of ["transferPayoutRails", "depositRails", "withdrawRails"]) {
      assert.equal(rule[capability].includes("card"), false, `${key} ${capability}`);
    }
  }
});

test("no deposit with a card issued in Côte d'Ivoire", () => {
  refusedWith(
    () =>
      validateInboundExternalCorridor({
        flow: "CARD_TOPUP_TO_PAYNOVAL",
        body: { funds: "card", action: "deposit", sourceCardCountry: "CI" },
        receiverUser: user("Côte d'Ivoire", "XOF"),
        fromCountry: "Côte d'Ivoire",
        currencySource: "XOF",
        currencyTarget: "XOF",
      }),
    "DEPOSIT_RAIL_NOT_AVAILABLE_FOR_COUNTRY"
  );
});

test("deposits: mobile money in Côte d'Ivoire, card in Canada — nothing elsewhere", () => {
  const momo = validateInboundExternalCorridor({
    flow: "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
    body: { funds: "mobilemoney", action: "deposit", phoneNumber: "+2250701020304", operator: "orange" },
    receiverUser: user("Côte d'Ivoire", "XOF"),
    fromCountry: "Côte d'Ivoire",
    currencySource: "XOF",
    currencyTarget: "XOF",
  });
  assert.equal(momo.ok, true);

  const card = validateInboundExternalCorridor({
    flow: "CARD_TOPUP_TO_PAYNOVAL",
    body: { funds: "card", action: "deposit", sourceCardCountry: "CA" },
    receiverUser: user("Canada", "CAD"),
    fromCountry: "Canada",
    currencySource: "CAD",
    currencyTarget: "CAD",
  });
  assert.equal(card.ok, true);

  // Un compte d'un pays retiré ne dépose plus rien.
  refusedWith(
    () =>
      validateInboundExternalCorridor({
        flow: "CARD_TOPUP_TO_PAYNOVAL",
        body: { funds: "card", action: "deposit", sourceCardCountry: "FR" },
        receiverUser: user("France", "EUR"),
        fromCountry: "France",
        currencySource: "EUR",
        currencyTarget: "EUR",
      }),
    "RECEIVER_COUNTRY_NOT_SUPPORTED"
  );
});
