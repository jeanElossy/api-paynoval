"use strict";

/**
 * Un taux de change s'inscrit à pleine précision sur la transaction.
 *
 * Défaut fermé le 2026-09-16 : `exchangeRate` et `fxRateSourceToTarget` étaient
 * écrits par `dec2`, l'helper des montants — XOF → EUR (0,0015) devenait
 * « 0.00 ». Voir `utils/money.formatRate`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { formatRate } = require("../../src/utils/money");
const { decRate } = require("../../src/services/transactions/shared/helpers");
const { decideRateRepair } = require("../../src/services/pricing/rateRepair");

const XOF_EUR = 1 / 655.957;

test("formatRate conserve un taux inférieur au centime", () => {
  assert.equal(formatRate(XOF_EUR), "0.001524490172");
  assert.equal(formatRate(0.00221), "0.00221");
});

test("formatRate ne tronque pas un taux usuel", () => {
  assert.equal(formatRate(1.4823), "1.4823");
  assert.equal(formatRate(655.957), "655.957");
  assert.equal(formatRate(1), "1");
});

test("formatRate rend null, jamais « 0 », sur un taux illisible ou nul", () => {
  for (const v of [0, -1, NaN, Infinity, null, undefined, "abc", 1e-15]) {
    assert.equal(formatRate(v), null, `entrée ${v}`);
  }
});

test("decRate écrit un Decimal128 exact, et LÈVE sur un taux illisible", () => {
  assert.equal(decRate(XOF_EUR).toString(), "0.001524490172");
  assert.throws(() => decRate(0));
  assert.throws(() => decRate(NaN));
});

/* ------------------------------------------------------------------------ */
/* Garde de texte : aucun taux ne repasse par un helper de MONTANT            */
/* ------------------------------------------------------------------------ */

const SRC = path.join(__dirname, "..", "..", "src");

function fichiersJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return fichiersJs(p);
    return e.name.endsWith(".js") ? [p] : [];
  });
}

/**
 * Détecte `dec2(…rate…)`, `decMoney(…rate…)` et `toDecimal128(…rate…)`, y
 * compris quand l'appel s'écrit sur plusieurs lignes. Les blocs commentés sont
 * retirés d'abord : plusieurs fichiers du dépôt portent une ancienne version
 * intégralement commentée.
 */
const HELPER_DE_MONTANT_SUR_UN_TAUX =
  /\b(?:dec2|decMoney|toDecimal128)\(\s*[^()]*?(?:\brate|Rate)[^()]*\)/;

function sansCommentaires(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("le détecteur se prouve d'abord sur des cas construits", () => {
  assert.match("exchangeRate: dec2(rateUsed),", HELPER_DE_MONTANT_SUR_UN_TAUX);
  assert.match("x: dec2(\n  pricingCtx.rateUsed\n)", HELPER_DE_MONTANT_SUR_UN_TAUX);
  assert.match("toDecimal128(exchangeRate, currency)", HELPER_DE_MONTANT_SUR_UN_TAUX);
  assert.doesNotMatch("amount: dec2(amountSourceStd),", HELPER_DE_MONTANT_SUR_UN_TAUX);
  assert.doesNotMatch("dec2(separateAmount)", HELPER_DE_MONTANT_SUR_UN_TAUX);
  assert.doesNotMatch("exchangeRate: decRate(rateUsed),", HELPER_DE_MONTANT_SUR_UN_TAUX);
});

test("aucun fichier de src n'arrondit un taux avec un helper de montant", () => {
  const fautes = fichiersJs(SRC).filter((f) =>
    HELPER_DE_MONTANT_SUR_UN_TAUX.test(sansCommentaires(fs.readFileSync(f, "utf8")))
  );

  assert.deepEqual(
    fautes.map((f) => path.relative(SRC, f)),
    [],
    "un taux passé à dec2/decMoney/toDecimal128 est arrondi comme un montant"
  );
});

/* ------------------------------------------------------------------------ */
/* Rattrapage des transactions existantes                                   */
/* ------------------------------------------------------------------------ */

function txTronquee(over = {}) {
  return {
    reference: "PNV-TEST",
    exchangeRate: { $numberDecimal: "0.00" },
    fxRateSourceToTarget: { $numberDecimal: "0.00" },
    netAmount: { $numberDecimal: "9900" },
    amountTarget: { $numberDecimal: "14.87" },
    currencyTarget: "EUR",
    money: { fxRateSourceToTarget: 0.0015022 },
    pricingSnapshot: { result: { appliedRate: 0.0015022 } },
    ...over,
  };
}

test("rattrapage : un taux tronqué est recopié depuis la source exacte", () => {
  const d = decideRateRepair(txTronquee());
  assert.equal(d.action, "repair");
  assert.equal(d.rate, "0.0015022");
  assert.equal(d.previous.exchangeRate, 0);
});

test("rattrapage : un taux déjà exact n'est pas réécrit", () => {
  const d = decideRateRepair(
    txTronquee({
      exchangeRate: { $numberDecimal: "0.0015022" },
      fxRateSourceToTarget: { $numberDecimal: "0.0015022" },
    })
  );
  assert.equal(d.action, "ok");
});

test("rattrapage : deux sources exactes qui divergent ARRÊTENT la réparation", () => {
  const d = decideRateRepair(
    txTronquee({ pricingSnapshot: { result: { appliedRate: 0.0016 } } })
  );
  assert.deepEqual([d.action, d.reason], ["skip", "RATE_SOURCES_DISAGREE"]);
});

test("rattrapage : un taux qui n'explique pas les montants n'est pas écrit", () => {
  const d = decideRateRepair(txTronquee({ amountTarget: { $numberDecimal: "20.00" } }));
  assert.deepEqual([d.action, d.reason], ["skip", "RATE_DOES_NOT_EXPLAIN_AMOUNTS"]);
});

test("rattrapage : sans source exacte, rien n'est inventé", () => {
  const d = decideRateRepair(txTronquee({ money: {}, pricingSnapshot: {} }));
  assert.deepEqual([d.action, d.reason], ["skip", "NO_EXACT_RATE_SOURCE"]);
});
