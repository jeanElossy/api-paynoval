"use strict";

/**
 * ============================================================================
 * TOUTES LES COUCHES ARRONDISSENT PAREIL
 * ============================================================================
 *
 * ── Ce que ce fichier fige ──────────────────────────────────────────────────
 *
 * Le service portait CINQ `roundMoney` et SEPT listes de devises sans décimale,
 * et elles divergeaient de deux façons mesurées le 2026-09-16 :
 *
 *   · `toFixed` contre `Math.round(n + EPSILON)` — sur 1,005 : 1,00 contre 1,01 ;
 *   · des listes de 3 à 10 devises — un montant en GNF arrondi au centime par
 *     une couche, à l'unité par une autre.
 *
 * Conséquence : le devis et l'écriture comptable pouvaient produire deux
 * montants différents pour la même opération, chacun « ayant raison ».
 *
 * Ces tests tombent si quelqu'un réintroduit une copie locale.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const money = require("../../src/utils/money");
const engine = require("../../src/services/pricing/pricingEngine");
const normalizer = require("../../src/services/pricingSnapshotNormalizer");
const helpers = require("../../src/services/transactions/shared/helpers");
const cancellation = require("../../src/config/cancellationFees");
const validation = require("../../src/services/transactions/shared/pricingValidation");

const RACINE = path.join(__dirname, "..", "..");

/** Montants choisis pour leur représentation binaire pénible. */
const CAS = [
  { montant: 1.005, devise: "CAD" },
  { montant: 8.835, devise: "EUR" },
  { montant: 2.675, devise: "USD" },
  { montant: 1234.6, devise: "XOF" },
  { montant: 999.5, devise: "GNF" },
  { montant: 0.1 + 0.2, devise: "CAD" },
  { montant: 10000, devise: "XAF" },
];

test("les quatre couches rendent EXACTEMENT le même montant", () => {
  for (const { montant, devise } of CAS) {
    const attendu = money.roundMoney(montant, devise);

    assert.equal(
      engine.roundMoney(montant, devise),
      attendu,
      `moteur de tarification — ${montant} ${devise}`
    );

    assert.equal(
      normalizer.roundMoney(montant, devise),
      attendu,
      `normalisateur de devis — ${montant} ${devise}`
    );

    assert.equal(
      helpers.roundMoney(montant, devise),
      attendu,
      `helpers de transaction — ${montant} ${devise}`
    );

    assert.equal(
      cancellation.roundMoney(montant, devise),
      attendu,
      `frais d'annulation — ${montant} ${devise}`
    );
  }
});

test("les devises sans décimale sont les mêmes partout", () => {
  for (const code of money.ZERO_DECIMAL_CURRENCIES) {
    assert.equal(engine.decimalsForCurrency(code), 0, code);
    assert.equal(validation.decimalsFor(code), 0, code);
    assert.equal(helpers.currencyHasDecimals(code), false, code);
    assert.ok(validation.ZERO_DECIMAL.has(code), code);
  }
});

test("aucune devise n'a été perdue en unifiant les listes", () => {
  /**
   * L'union devait être prise, pas une intersection : unifier sur la liste la
   * plus courte aurait remis des centimes sur des monnaies qui n'en ont pas.
   */
  for (const code of ["XOF", "XAF", "JPY", "KRW", "CLP", "VND", "ISK", "GNF", "RWF", "UGX", "BIF", "KMF"]) {
    assert.ok(
      money.ZERO_DECIMAL_CURRENCIES.has(code),
      `${code} figurait dans une des listes d'origine et doit rester sans décimale`
    );
  }
});

test("1,005 arrondit à 1,01 — la méthode qui facture est conservée", () => {
  /**
   * Le point qui départage les deux méthodes. `toFixed` rendait 1,00 parce que
   * 1,005 vaut en réalité 1,00499999… en binaire. On conserve le comportement
   * du moteur de tarification : changer d'arrondi aurait changé des prix sans
   * que personne ne l'ait décidé.
   */
  assert.equal(money.roundMoney(1.005, "CAD"), 1.01);
  assert.equal(money.roundMoney(-1.005, "CAD"), -1);
});

test("une entrée illisible ne devient pas un montant fantaisiste", () => {
  assert.equal(money.roundMoney(undefined, "CAD"), 0);
  assert.equal(money.roundMoney(null, "CAD"), 0);
  assert.equal(money.roundMoney("pas un nombre", "CAD"), 0);
});

test("plus aucune copie locale de roundMoney ne subsiste", () => {
  /**
   * Un garde-fou de TEXTE, délibérément : c'est la duplication elle-même qu'on
   * interdit, pas seulement sa divergence actuelle. Deux copies identiques
   * aujourd'hui sont deux copies qui divergeront.
   */
  const fichiers = [
    "src/services/pricing/pricingEngine.js",
    "src/services/pricingSnapshotNormalizer.js",
    "src/controllers/pricing/feesController.js",
    "src/services/transactions/shared/helpers.js",
    "src/config/cancellationFees.js",
  ];

  const fautifs = [];

  for (const f of fichiers) {
    const source = fs
      .readFileSync(path.join(RACINE, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    if (/function\s+roundMoney\s*\(/.test(source)) fautifs.push(f);
  }

  assert.deepEqual(
    fautifs,
    [],
    "Une copie locale de `roundMoney` est réapparue. Toutes les couches " +
      "doivent passer par `utils/money`, sinon deux d'entre elles finiront par " +
      "facturer deux montants différents.\n" + fautifs.join("\n")
  );
});

/* -------------------------------------------------------------------------- */
/* Le taux appliqué se déduit, il ne s'invente pas                            */
/* -------------------------------------------------------------------------- */

test("un taux annoncé lisible est retenu tel quel", () => {
  assert.equal(money.tauxEffectif(6559.57, 10, 655.957), 655.957);
});

test("un taux illisible est DÉDUIT des montants, jamais remplacé par 1", () => {
  /**
   * ⚠️ LE DÉFAUT QUE CE TEST FIGE.
   *
   * Trois endroits du chemin d'annulation écrivaient `convertedRate || 1`. Quand
   * le fournisseur rendait un montant converti sans taux lisible, la trace
   * d'audit affirmait « 1 pour 1 » — juste après avoir converti entre deux
   * devises différentes. Un chiffre faux, plausible, et contredit par la ligne
   * voisine.
   */
  assert.equal(money.tauxEffectif(6559.57, 10, 0), 655.957);
  assert.equal(money.tauxEffectif(6559.57, 10, null), 655.957);
  assert.equal(money.tauxEffectif(6559.57, 10, NaN), 655.957);
  assert.equal(money.tauxEffectif(6559.57, 10, undefined), 655.957);
});

test("un taux négatif ou nul n'est pas retenu — il est recalculé", () => {
  assert.equal(money.tauxEffectif(200, 100, -3), 2);
});

test("quand rien ne permet d'établir le taux, le résultat est `null` — pas 1", () => {
  /**
   * « Je ne sais pas » doit rester distinct de « un pour un ». Rendre 1 ferait
   * disparaître l'ignorance dans une valeur d'apparence normale.
   */
  assert.equal(money.tauxEffectif(100, 0, null), null);
  assert.equal(money.tauxEffectif(null, null, null), null);
  assert.equal(money.tauxEffectif("abc", "def", "ghi"), null);
});

test("plus aucun taux n'est fabriqué à 1 sur le chemin d'annulation", () => {
  /**
   * Garde de TEXTE. Le `catch` de `cancelTransaction` conserve, lui, un taux de
   * 1 à bon droit — aucune conversion n'y a lieu, les frais restent dans la
   * devise source. Le motif surveillé est donc `…Rate || 1`, pas une
   * affectation directe à 1.
   */
  const fichiers = [
    "src/services/cancellation.service.js",
    "src/services/transactions/handlers/cancelTransaction.js",
  ];

  const fautifs = [];

  for (const f of fichiers) {
    const source = fs
      .readFileSync(path.join(RACINE, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    if (/[Rr]ate\s*\|\|\s*1\b/.test(source)) fautifs.push(f);
  }

  assert.deepEqual(
    fautifs,
    [],
    "Un taux fabriqué à 1 est réapparu dans un champ d'audit. Le taux se déduit " +
      "des montants (`utils/money.js:tauxEffectif`).\n" + fautifs.join("\n")
  );
});
