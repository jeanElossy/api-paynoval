"use strict";

/**
 * Montants des comptes internes (2026-09-22) — voir
 * `services/ledger/systemBalanceAmounts.js`.
 *
 * Mesuré en base : `CAD: 16.150000000000002` et `97.91000000000001` sur des
 * trésoreries, après quelques dizaines de `$inc` en flottants. Les
 * portefeuilles clients étaient déjà en Decimal128 ; les comptes internes non.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const {
  scaleFor,
  roundToCurrency,
  toDecimal128,
  readExact,
  readNumber,
  covers,
  balancesAsNumbers,
} = require("../src/services/ledger/systemBalanceAmounts");

test("l'échelle suit la devise : XOF n'a pas de centime", () => {
  assert.equal(scaleFor("CAD"), 2);
  assert.equal(scaleFor("eur"), 2);
  assert.equal(scaleFor("XOF"), 0);
  assert.equal(scaleFor("XAF"), 0);
});

test("l'arrondi est exact — la queue des flottants disparaît", () => {
  assert.equal(roundToCurrency(16.150000000000002, "CAD"), "16.15");
  assert.equal(roundToCurrency(97.91000000000001, "CAD"), "97.91");
  assert.equal(roundToCurrency("0.005", "CAD"), "0.01");
  assert.equal(roundToCurrency("0.004", "CAD"), "0.00");
  assert.equal(roundToCurrency(30000, "XOF"), "30000");
  assert.equal(roundToCurrency("1234.5", "XOF"), "1235");
  assert.equal(roundToCurrency("-2.345", "CAD"), "-2.35");
});

test("un montant illisible rend null — JAMAIS zéro", () => {
  assert.equal(roundToCurrency("abc", "CAD"), null);
  assert.equal(roundToCurrency(NaN, "CAD"), null);
  assert.equal(roundToCurrency(undefined, "CAD"), null);
  assert.throws(() => toDecimal128("abc", "CAD"), /illisible/);
});

test("toDecimal128 rend un Decimal128 exact", () => {
  const d = toDecimal128(16.150000000000002, "CAD");

  assert.ok(d instanceof mongoose.Types.Decimal128);
  assert.equal(d.toString(), "16.15");
  assert.equal(toDecimal128("30000", "XOF").toString(), "30000");
});

test("lecture exacte : Decimal128 comme Number, devise absente = 0", () => {
  const wallet = {
    balances: {
      CAD: mongoose.Types.Decimal128.fromString("97.91"),
      XOF: 30000,
      EUR: "abc",
    },
  };

  assert.equal(readExact(wallet, "CAD"), "97.91");
  assert.equal(readExact(wallet, "XOF"), "30000");
  assert.equal(readExact(wallet, "USD"), "0");
  assert.equal(readExact(wallet, "EUR"), null, "un solde illisible ne vaut pas zéro");
  assert.equal(readNumber(wallet, "CAD"), 97.91);
  assert.equal(readNumber(wallet, "EUR"), null);
});

test("la comparaison de couverture est exacte, sans flottant", () => {
  assert.equal(covers("16.15", "16.15"), true);
  assert.equal(covers("16.15", "16.16"), false);
  assert.equal(covers(mongoose.Types.Decimal128.fromString("0.30"), "0.1"), true);
  assert.equal(covers("abc", "1"), false, "illisible ⇒ ne couvre rien");
});

test("l'accesseur rend des NOMBRES : les lecteurs existants ne cassent pas", () => {
  // `Number(Decimal128)` vaut NaN : sans cet accesseur, basculer le stockage
  // transformerait un solde en NaN sur le chemin de l'argent.
  const vue = balancesAsNumbers({
    CAD: mongoose.Types.Decimal128.fromString("97.91"),
    XOF: mongoose.Types.Decimal128.fromString("30000"),
  });

  assert.deepEqual(vue, { CAD: 97.91, XOF: 30000 });
  assert.equal(Number(vue.CAD) + 1, 98.91);
});

test("l'accesseur ne masque pas une valeur illisible par un zéro", () => {
  const vue = balancesAsNumbers({ CAD: "corrompu" });
  assert.equal(vue.CAD, "corrompu");
});
