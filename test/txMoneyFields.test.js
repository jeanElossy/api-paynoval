"use strict";

/**
 * Lecture des montants d'une transaction pour l'e-mail de confirmation.
 *
 * L'enjeu tient en une phrase : `tx.amount` est le TOTAL débité, frais compris,
 * pas le montant envoyé. Un e-mail qui l'affiche en « Montant » puis ajoute une
 * ligne « Frais » et une ligne « Total » compte les frais DEUX FOIS — et
 * l'utilisateur, lui, rapproche ce total de son relevé bancaire.
 *
 * L'autre enjeu est la distinction entre `0` et `null`. Zéro affirme qu'aucun
 * frais n'a été prélevé ; `null` dit qu'on l'ignore, et le gabarit masque alors
 * la ligne au lieu d'affirmer quelque chose de faux.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  readMoneyField,
  buildSenderFee,
  buildSenderNet,
  buildSenderTotal,
} = require("../src/utils/txMoneyFields");

/** Imite un `Decimal128` de Mongoose : un objet dont seul `toString()` parle. */
const dec = (v) => ({ toString: () => String(v) });

/* -- readMoneyField ------------------------------------------------------ */

test("readMoneyField lit un Decimal128 sans perdre les décimales", () => {
  assert.equal(readMoneyField(dec("2000.50")), 2000.5);
  assert.equal(readMoneyField(dec("0.01")), 0.01);
  // Un objet dont toString() ne donne pas un nombre ne doit pas produire NaN.
  assert.equal(readMoneyField({ toString: () => "[object Object]" }), null);
});

test("readMoneyField prend la première valeur exploitable", () => {
  assert.equal(readMoneyField(null, undefined, "", 42, 99), 42);
});

test("readMoneyField distingue zéro d'une absence", () => {
  assert.equal(readMoneyField(0), 0);
  assert.equal(readMoneyField(dec("0.00")), 0);
  assert.equal(readMoneyField(null, undefined), null);
  assert.equal(readMoneyField(), null);
});

test("readMoneyField ne rend jamais NaN", () => {
  assert.equal(readMoneyField("pas un nombre"), null);
  assert.equal(readMoneyField(NaN), null);
  assert.equal(readMoneyField({}), null);
});

/* -- frais, net, total --------------------------------------------------- */

test("les frais sont lus sur transactionFees en priorité", () => {
  const tx = { transactionFees: dec("2000.00"), feeSource: dec("999.00") };
  assert.equal(buildSenderFee(tx), 2000);
});

test("les frais retombent sur feeSource, puis sur money.feeSource", () => {
  assert.equal(buildSenderFee({ feeSource: dec("1500") }), 1500);
  assert.equal(buildSenderFee({ money: { feeSource: { amount: 750 } } }), 750);
  assert.equal(buildSenderFee({ feeSnapshot: { fee: 25 } }), 25);
});

test("une transaction sans frais renseignés rend null, jamais zéro", () => {
  assert.equal(buildSenderFee({}), null);
  assert.equal(buildSenderNet({}), null);
  assert.equal(buildSenderTotal({}), null);
});

test("des frais réellement nuls restent zéro, et s'affichent", () => {
  assert.equal(buildSenderFee({ transactionFees: dec("0.00") }), 0);
});

/* -- L'INVARIANT --------------------------------------------------------- */

test("Montant (net) + Frais = Total (amount), sur une transaction réelle", () => {
  // Valeurs telles que la tarification les écrit : grossFrom / fee / netFrom.
  const tx = {
    amount: dec("100000.00"),
    transactionFees: dec("2000.00"),
    netAmount: dec("98000.00"),
  };

  const net = buildSenderNet(tx);
  const fee = buildSenderFee(tx);
  const total = buildSenderTotal(tx);

  assert.equal(net, 98000);
  assert.equal(fee, 2000);
  assert.equal(total, 100000);
  assert.equal(Number((net + fee).toFixed(2)), total);
});

test("l'invariant tient aussi sur une devise à décimales", () => {
  const tx = {
    amount: dec("150.00"),
    transactionFees: dec("4.50"),
    netAmount: dec("145.50"),
  };

  assert.equal(
    Number((buildSenderNet(tx) + buildSenderFee(tx)).toFixed(2)),
    buildSenderTotal(tx)
  );
});

test("le total ne se confond pas avec le net : c'est le piège de tx.amount", () => {
  const tx = {
    amount: dec("100000.00"),
    transactionFees: dec("2000.00"),
    netAmount: dec("98000.00"),
  };

  // Si un jour quelqu'un branche « Montant » sur tx.amount, ce test tombe.
  assert.notEqual(buildSenderTotal(tx), buildSenderNet(tx));
});
