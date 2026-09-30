"use strict";

/**
 * V1 COUNTRIES — pinned end to end on the corridor validators.
 *
 * Accounts: CA, US, CI, FR, GB, BE, DE, ES. Transfers received by card in
 * Europe / America, by mobile money (Orange, Moov — plus MTN, Wave in CI) in
 * Côte d'Ivoire, Mali, Burkina Faso. Internal PayNoval ↔ PayNoval between any
 * two account countries. Ivorian accounts deposit / withdraw by mobile money
 * or card, the others by card.
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
  ["USA", "USD"],
  ["Côte d'Ivoire", "XOF"],
  ["France", "EUR"],
  ["Angleterre", "GBP"],
  ["Belgique", "EUR"],
  ["Allemagne", "EUR"],
  ["Espagne", "EUR"],
];

test("exactly the eight account countries open accounts", () => {
  const opening = Object.entries(COUNTRY_RULES)
    .filter(([, r]) => r.accountOpening === true)
    .map(([k]) => k)
    .sort();
  assert.deepEqual(opening, ["allemagne", "belgique", "canada", "cote d'ivoire", "espagne", "france", "royaume uni", "usa"]);
});

test("internal transfers between any two account countries", () => {
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

test("no account in a destination-only or unserved country", () => {
  for (const [country, currency] of [["Mali", "XOF"], ["Burkina Faso", "XOF"], ["Sénégal", "XOF"]]) {
    refusedWith(
      () =>
        validateInternalPaynovalCorridor({
          sender: user(country, currency, "s"),
          receiver: user("France", "EUR", "r"),
          currencySource: currency,
          currencyTarget: "EUR",
        }),
      "SENDER_COUNTRY_NOT_SUPPORTED"
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

test("mobile money transfers to Côte d'Ivoire, Mali, Burkina Faso — from any account country", () => {
  assert.equal(momoPayout("Côte d'Ivoire", "+2250701020304", "wave").ok, true);
  assert.equal(momoPayout("Mali", "+22370102030", "orange").ok, true);
  assert.equal(momoPayout("Burkina Faso", "+22670102030", "moov", user("Angleterre", "GBP")).ok, true);
});

test("Mali and Burkina Faso: Orange and Moov only", () => {
  refusedWith(() => momoPayout("Mali", "+22370102030", "wave"), "OPERATOR_NOT_ALLOWED_FOR_COUNTRY");
  refusedWith(() => momoPayout("Burkina Faso", "+22670102030", "mtn"), "OPERATOR_NOT_ALLOWED_FOR_COUNTRY");
});

test("no mobile money transfer outside the three African destinations", () => {
  refusedWith(() => momoPayout("Sénégal", "+221701020304", "orange"), "DESTINATION_COUNTRY_NOT_SUPPORTED");
});

const cardPayout = (toCountry, cardCountry, currencyTarget, action = "send", sender = user("Côte d'Ivoire", "XOF")) =>
  validateOutboundExternalCorridor({
    flow: "PAYNOVAL_TO_CARD_PAYOUT",
    body: { destination: "card", action, cardCountry },
    senderUser: sender,
    toCountry,
    currencySource: sender.currency,
    currencyTarget,
  });

test("card transfers are received in Europe and America", () => {
  for (const [country, iso, cur] of [["France", "FR", "EUR"], ["Espagne", "ES", "EUR"], ["Angleterre", "GB", "GBP"], ["USA", "US", "USD"], ["Canada", "CA", "CAD"]]) {
    assert.equal(cardPayout(country, iso, cur).ok, true, country);
  }
});

test("a transfer to an Ivorian card is refused, a withdrawal to one's own Ivorian card is not", () => {
  refusedWith(() => cardPayout("Côte d'Ivoire", "CI", "XOF"), "PAYOUT_RAIL_NOT_AVAILABLE_FOR_COUNTRY");
  assert.equal(cardPayout("Côte d'Ivoire", "CI", "XOF", "withdraw").ok, true);
});

test("deposits: mobile money in Côte d'Ivoire only, card for every account country", () => {
  const momo = validateInboundExternalCorridor({
    flow: "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
    body: { funds: "mobilemoney", action: "deposit", phoneNumber: "+2250701020304", operator: "orange" },
    receiverUser: user("Côte d'Ivoire", "XOF"),
    fromCountry: "Côte d'Ivoire",
    currencySource: "XOF",
    currencyTarget: "XOF",
  });
  assert.equal(momo.ok, true);

  refusedWith(
    () =>
      validateInboundExternalCorridor({
        flow: "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
        body: { funds: "mobilemoney", action: "deposit", phoneNumber: "+22370102030", operator: "orange" },
        receiverUser: user("Côte d'Ivoire", "XOF"),
        fromCountry: "Mali",
        currencySource: "XOF",
        currencyTarget: "XOF",
      }),
    "DEPOSIT_RAIL_NOT_AVAILABLE_FOR_COUNTRY"
  );

  const card = validateInboundExternalCorridor({
    flow: "CARD_TOPUP_TO_PAYNOVAL",
    body: { funds: "card", action: "deposit", sourceCardCountry: "GB" },
    receiverUser: user("Angleterre", "GBP"),
    fromCountry: "Angleterre",
    currencySource: "GBP",
    currencyTarget: "GBP",
  });
  assert.equal(card.ok, true);
});
