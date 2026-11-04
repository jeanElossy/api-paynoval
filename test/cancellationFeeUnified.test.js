"use strict";

/**
 * Frais d'annulation — un seul calcul, celui qui est affiché (2026-11-04).
 *
 * Avant : l'annulation prélevait une table en dur (2,99 CAD / USD / EUR,
 * 300 XOF, 0 sinon) pendant que l'app affichait le barème du back-office puis
 * une autre table (0 en EUR / USD / GBP). Le destinataire qui refusait faisait
 * payer l'expéditeur ; sans trésorerie, les frais étaient abandonnés en silence.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { resolveCancellationFeeRule } = require("../src/config/cancellationFees");

test("table unique : les six devises, aucune annulation gratuite par défaut", () => {
  for (const [cur, amount] of [["XOF", 300], ["XAF", 300], ["CAD", 2.99], ["USD", 2.99], ["EUR", 2.99], ["GBP", 2.99]]) {
    const rule = resolveCancellationFeeRule({ currency: cur });
    assert.equal(rule?.amount, amount, cur);
    assert.equal(rule?.currency, cur, cur);
  }
  // Devise hors table : aucun montant inventé (l'appelant refuse).
  assert.equal(resolveCancellationFeeRule({ currency: "JPY" }), null);
});

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "services", "transactions", "handlers", "cancelTransaction.js"),
  "utf8"
);

test("l'annulation utilisateur n'a plus de table à elle : même calcul que l'affichage", () => {
  assert.doesNotMatch(SRC, /function getStaticCancellationFee/);
  assert.match(SRC, /resolveCancellationFeeAmounts\(\{ tx, sourceCurrency, grossSource \}\)/);
});

test("sans trésorerie, des frais ne sont plus abandonnés : refus 503", () => {
  assert.doesNotMatch(SRC, /cancellationFee > 0 &&\s*treasuryMeta\?\.treasuryUserId &&/);
  assert.equal((SRC.match(/FEES_TREASURY_UNAVAILABLE/g) || []).length >= 2, true);
});

const { resolveCancelFee, assertCancellable } = require("../src/services/transactions/handlers/cancelTransaction");

test("refus du destinataire : gratuit, sans même consulter le barème", async () => {
  const fee = await resolveCancelFee({ tx: {}, sourceCurrency: "EUR", grossSource: 100, cancelledBySender: false });
  assert.equal(fee.cancellationFee, 0);
  assert.equal(fee.cancellationFeeSource, "RECIPIENT_REFUSAL_FREE");
});

test("qui annule : l'expéditeur paie, le destinataire non", () => {
  const tx = {
    flow: "PAYNOVAL_INTERNAL_TRANSFER",
    status: "pending",
    sender: "s1",
    receiver: "r1",
    amount: "100",
    netAmount: "99",
    senderCurrencySymbol: "EUR",
    currencySource: "EUR",
  };
  const asSender = assertCancellable({ req: { user: { id: "s1" } }, tx });
  const asReceiver = assertCancellable({ req: { user: { id: "r1" } }, tx });
  assert.equal(asSender.cancelledBySender, true);
  assert.equal(asReceiver.cancelledBySender, false);
});
