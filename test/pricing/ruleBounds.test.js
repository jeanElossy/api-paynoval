"use strict";

/**
 * ============================================================================
 * LES BORNES D'UN BARÈME SE REFUSENT À L'APPROBATION, PAS AU PREMIER DEVIS
 * ============================================================================
 *
 * Avant le 2026-09-16, `validateProposedRule` ne contrôlait aucun ordre de
 * grandeur. Une marge négative passait l'approbation et faisait perdre de
 * l'argent en silence ; une marge ≥ 100 % passait aussi, et n'échouait qu'au
 * premier devis, en erreur 500, barème déjà publié.
 *
 * Chaque test ci-dessous correspond à une saisie qui était ACCEPTÉE.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { validateProposedRule } = require("../../src/services/pricing/ruleValidation");

function baseRule(overrides = {}) {
  return {
    name: "Règle de test",
    scope: {
      txType: "TRANSFER",
      method: "INTERNAL",
      provider: "paynoval",
      fromCurrency: "XOF",
      toCurrency: "XOF",
    },
    amountRange: { min: 0, max: null },
    fee: { mode: "PERCENT", fixed: 0, percent: 1, minFee: null, maxFee: null },
    fx: { mode: "PASS_THROUGH" },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Frais                                                                      */
/* -------------------------------------------------------------------------- */

test("un tarif ordinaire reste accepté — les bornes n'entravent pas le métier", () => {
  assert.equal(validateProposedRule(baseRule()).ok, true);

  assert.equal(
    validateProposedRule(
      baseRule({ fee: { mode: "MIXED", fixed: 100, percent: 1.5 } })
    ).ok,
    true
  );
});

test("refuse des frais en pourcentage négatifs", () => {
  const out = validateProposedRule(
    baseRule({ fee: { mode: "PERCENT", percent: -1 } })
  );

  assert.equal(out.ok, false);
  assert.match(out.message, /négatif/i);
});

test("refuse des frais aberrants (150 %) — ils échouaient au devis, pas ici", () => {
  const out = validateProposedRule(
    baseRule({ fee: { mode: "PERCENT", percent: 150 } })
  );

  assert.equal(out.ok, false);
  assert.match(out.message, /borne/i);
});

test("refuse un montant fixe négatif — il créditerait l'expéditeur", () => {
  const out = validateProposedRule(
    baseRule({ fee: { mode: "FIXED", fixed: -500 } })
  );

  assert.equal(out.ok, false);
  assert.match(out.message, /créditerait/i);
});

test("refuse un plancher ou un plafond de frais négatif", () => {
  assert.equal(
    validateProposedRule(
      baseRule({ fee: { mode: "PERCENT", percent: 1, minFee: -1 } })
    ).ok,
    false
  );

  assert.equal(
    validateProposedRule(
      baseRule({ fee: { mode: "PERCENT", percent: 1, maxFee: -1 } })
    ).ok,
    false
  );
});

/* -------------------------------------------------------------------------- */
/* Marge de change                                                            */
/* -------------------------------------------------------------------------- */

test("une marge usuelle est acceptée", () => {
  assert.equal(
    validateProposedRule(
      baseRule({ fx: { mode: "MARKUP_PERCENT", markupPercent: 2 } })
    ).ok,
    true
  );
});

test("refuse une marge NÉGATIVE — elle ferait perdre de l'argent en silence", () => {
  const out = validateProposedRule(
    baseRule({ fx: { mode: "MARKUP_PERCENT", markupPercent: -2 } })
  );

  assert.equal(out.ok, false);
  assert.match(out.message, /meilleur que le marché/i);
});

test("refuse une marge ≥ 100 % — le bénéficiaire ne recevrait rien", () => {
  const out = validateProposedRule(
    baseRule({ fx: { mode: "MARKUP_PERCENT", markupPercent: 100 } })
  );

  assert.equal(out.ok, false);
  assert.match(out.message, /ne recevrait rien/i);
});

test("refuse une marge au-delà de la borne", () => {
  const out = validateProposedRule(
    baseRule({ fx: { mode: "MARKUP_PERCENT", markupPercent: 35 } })
  );

  assert.equal(out.ok, false);
  assert.match(out.message, /borne/i);
});

/* -------------------------------------------------------------------------- */
/* Ajustements                                                                */
/* -------------------------------------------------------------------------- */

test("refuse un ajustement relatif hors borne, dans les deux sens", () => {
  assert.equal(
    validateProposedRule(
      baseRule({ fx: { mode: "DELTA_PERCENT", percent: 50 } })
    ).ok,
    false
  );

  assert.equal(
    validateProposedRule(
      baseRule({ fx: { mode: "DELTA_PERCENT", percent: -50 } })
    ).ok,
    false
  );
});

test("un ajustement qui FAVORISE le client est refusé — il ferait perdre PayNoval", () => {
  const paire = { txType: "TRANSFER", method: "INTERNAL", provider: "paynoval", fromCurrency: "EUR", toCurrency: "XOF" };

  assert.equal(
    validateProposedRule(baseRule({ scope: paire, fx: { mode: "DELTA_ABS", deltaAbs: 12.5 } })).ok,
    false
  );
  assert.equal(
    validateProposedRule(baseRule({ fx: { mode: "DELTA_PERCENT", percent: 2 } })).ok,
    false
  );
  assert.equal(
    validateProposedRule(baseRule({ scope: paire, fx: { mode: "DELTA_ABS", deltaAbs: -5 } })).ok,
    true
  );
});

test("un taux imposé ou un ajustement absolu exige une paire de devises précise", () => {
  // `baseRule` vise XOF→XOF : aucun taux ne s'y applique.
  assert.equal(
    validateProposedRule(baseRule({ fx: { mode: "DELTA_ABS", deltaAbs: -5 } })).ok,
    false
  );
  assert.equal(
    validateProposedRule(
      baseRule({
        scope: { ...baseRule().scope, fromCurrency: "ALL", toCurrency: "EUR" },
        fx: { mode: "OVERRIDE", overrideRate: 0.0015 },
      })
    ).ok,
    false
  );
});

test("le mode « taux imposé » exige toujours un taux strictement positif", () => {
  const paire = { ...baseRule().scope, fromCurrency: "XOF", toCurrency: "EUR" };

  assert.equal(
    validateProposedRule(baseRule({ scope: paire, fx: { mode: "OVERRIDE", overrideRate: 0 } })).ok,
    false
  );

  assert.equal(
    validateProposedRule(baseRule({ scope: paire, fx: { mode: "OVERRIDE", overrideRate: 0.0015 } })).ok,
    true
  );
});
