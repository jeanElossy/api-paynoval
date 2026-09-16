"use strict";

/**
 * ============================================================================
 * LES FRAIS D'ANNULATION : UNE SEULE SOURCE POUR L'AFFICHAGE ET LE PRÉLÈVEMENT
 * ============================================================================
 *
 * ── Le défaut fermé le 2026-09-16 ───────────────────────────────────────────
 *
 * TROIS sources se contredisaient :
 *
 *   1. `config/cancellationFees.js` — table codée en dur, deux pays. Elle
 *      PRÉLEVAIT.
 *   2. la collection `Fee`, lue par `/fees/simulate?type=cancellation`. Elle
 *      AFFICHAIT.
 *   3. un repli inventé dans ce même endpoint (2,99 / 300 / 2) — le pire des
 *      trois, puisqu'il ne correspondait à aucune décision.
 *
 * Un utilisateur pouvait voir un montant d'annulation et s'en voir prélever un
 * autre ; et modifier le barème affiché n'avait aucun effet sur le prélèvement.
 *
 * Tests **purs** : les barèmes sont injectés, aucune base n'est ouverte.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TX_TYPE,
  resoudreDepuisBaremes,
} = require("../../src/services/pricing/cancellationPricing");

const NOW = Date.parse("2026-09-16T12:00:00Z");

function regle(overrides = {}) {
  return {
    _id: "cancel-ci",
    name: "Annulation — Côte d'Ivoire",
    code: "CANCELLATION_CI_DEFAULT",
    active: true,
    priority: 0,
    currentVersion: 3,
    scope: {
      txType: "CANCELLATION",
      method: "ALL",
      provider: "all",
      country: "CI",
      fromCountry: "CI",
      toCountry: "ALL",
      fromCurrency: "XOF",
      toCurrency: "XOF",
    },
    amountRange: { min: 0, max: null },
    fee: { mode: "FIXED", fixed: 300 },
    fx: { mode: "PASS_THROUGH" },
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

const demande = {
  amount: 50000,
  currency: "XOF",
  country: "CI",
  now: NOW,
};

test("le type de barème est bien CANCELLATION", () => {
  assert.equal(TX_TYPE, "CANCELLATION");
});

test("un barème gouverné donne le montant, et cite sa version", () => {
  const out = resoudreDepuisBaremes({ rules: [regle()], ...demande });

  assert.equal(out.amount, 300);
  assert.equal(out.currency, "XOF");
  assert.equal(out.resolvedBy, "pricing_rule");
  assert.equal(out.ruleVersion, 3);

  assert.match(
    out.source,
    /^PRICING_RULE:CANCELLATION_CI_DEFAULT@v3$/,
    "la source doit permettre de retrouver le barème ET sa version en litige"
  );
});

test("un barème en pourcentage est calculé sur le montant annulé", () => {
  const out = resoudreDepuisBaremes({
    rules: [regle({ fee: { mode: "PERCENT", percent: 1 } })],
    ...demande,
  });

  assert.equal(out.amount, 500); // 1 % de 50 000, arrondi XOF
  assert.equal(out.type, "percent");
  assert.equal(out.percent, 1);
});

test("le plafond d'un barème mord aussi sur l'annulation", () => {
  const out = resoudreDepuisBaremes({
    rules: [regle({ fee: { mode: "PERCENT", percent: 10, maxFee: 1000 } })],
    ...demande,
  });

  assert.equal(out.amount, 1000);
});

test("aucun barème ne couvre le cas → `null`, jamais un montant inventé", () => {
  assert.equal(resoudreDepuisBaremes({ rules: [], ...demande }), null);

  /* Mauvais pays : la règle CI ne doit pas servir à une annulation au Canada. */
  assert.equal(
    resoudreDepuisBaremes({
      rules: [regle()],
      ...demande,
      country: "CA",
      currency: "CAD",
    }),
    null
  );
});

test("une règle expirée ne s'applique plus", () => {
  const out = resoudreDepuisBaremes({
    rules: [regle({ endsAt: new Date(NOW - 86400000).toISOString() })],
    ...demande,
  });

  assert.equal(out, null);
});

test("une règle programmée ne s'applique pas avant sa date", () => {
  const out = resoudreDepuisBaremes({
    rules: [regle({ startsAt: new Date(NOW + 86400000).toISOString() })],
    ...demande,
  });

  assert.equal(out, null);
});

test("un montant nul ou illisible ne produit aucun barème", () => {
  assert.equal(resoudreDepuisBaremes({ rules: [regle()], ...demande, amount: 0 }), null);
  assert.equal(
    resoudreDepuisBaremes({ rules: [regle()], ...demande, amount: "abc" }),
    null
  );
  assert.equal(
    resoudreDepuisBaremes({ rules: [regle()], ...demande, currency: "" }),
    null
  );
});

test("l'affichage et le prélèvement appellent le MÊME résolveur", () => {
  /**
   * Garde de câblage. C'est la divergence des appelants — et non le calcul —
   * qui produisait un montant affiché différent du montant prélevé.
   */
  const fs = require("node:fs");
  const path = require("node:path");

  const racine = path.join(__dirname, "..", "..");

  const preleve = fs.readFileSync(
    path.join(racine, "src/services/cancellation.service.js"),
    "utf8"
  );

  const affiche = fs.readFileSync(
    path.join(racine, "src/controllers/pricing/feesController.js"),
    "utf8"
  );

  for (const [nom, source] of [
    ["le prélèvement", preleve],
    ["l'affichage", affiche],
  ]) {
    assert.match(
      source,
      /resolveCancellationFeeFromRules/,
      `${nom} doit passer par le moteur de tarification`
    );
  }

  assert.doesNotMatch(
    affiche,
    /feeValue\s*=\s*2\.99/,
    "le repli inventé (2,99 / 300 / 2) de l'endpoint de simulation ne doit pas revenir"
  );
});
