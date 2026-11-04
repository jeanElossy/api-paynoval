"use strict";

/**
 * Retrait mobile money : vers le numéro du COMPTE, et lui seul (2026-11-04).
 * Un dépôt peut venir d'un autre numéro ; un retrait non.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { assertWithdrawalToOwnPhone, registeredPhoneE164 } = require("../src/services/transactions/withdrawOwnership");

const user = { phone: "0700495952", country: "cote d'ivoire", mobiles: [{ numero: "0102030405", country: "CI" }] };
const base = { operationType: "WITHDRAW", isMobileMoneyPayout: true, payoutCountry: "CI", user };

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

test("retrait vers le numéro du compte : accepté, quelle que soit l'écriture", () => {
  for (const phone of ["0700495952", "+2250700495952", "+225 07 00 49 59 52"]) {
    assert.equal(codeOf(() => assertWithdrawalToOwnPhone({ ...base, recipientPhone: phone })), null, phone);
  }
});

test("retrait vers un AUTRE numéro : refusé", () => {
  assert.equal(codeOf(() => assertWithdrawalToOwnPhone({ ...base, recipientPhone: "0700000001" })), "WITHDRAW_PHONE_NOT_OWNER");
});

test("un numéro mobile money simplement ENREGISTRÉ ne vaut pas le numéro du compte", () => {
  assert.equal(codeOf(() => assertWithdrawalToOwnPhone({ ...base, recipientPhone: "0102030405" })), "WITHDRAW_PHONE_NOT_OWNER");
  assert.equal(registeredPhoneE164({ mobiles: user.mobiles, country: "CI" }), "");
});

test("échec en fermeture : numéro du compte inconnu ou numéro de retrait illisible", () => {
  assert.equal(
    codeOf(() => assertWithdrawalToOwnPhone({ ...base, user: { country: "CI" }, recipientPhone: "0700495952" })),
    "WITHDRAW_OWN_PHONE_UNKNOWN"
  );
  assert.equal(codeOf(() => assertWithdrawalToOwnPhone({ ...base, recipientPhone: "abc" })), "WITHDRAW_PHONE_INVALID");
});

test("un transfert vers un tiers ou un retrait carte n'est pas concerné", () => {
  assert.equal(codeOf(() => assertWithdrawalToOwnPhone({ ...base, operationType: "TRANSFER", recipientPhone: "0700000001" })), null);
  assert.equal(codeOf(() => assertWithdrawalToOwnPhone({ ...base, isMobileMoneyPayout: false, recipientPhone: "" })), null);
});

test("le contrôle est fait AVANT toute réservation d'argent", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "transactions", "handlers", "initiateExternalTransactions.js"),
    "utf8"
  );
  const check = src.indexOf("assertWithdrawalToOwnPhone({");
  const reserve = src.indexOf("fundsReserved: true");
  assert.ok(check > 0, "contrôle absent");
  assert.ok(reserve > check, "le contrôle doit précéder la réservation");
});
