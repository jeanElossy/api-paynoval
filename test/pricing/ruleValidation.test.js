"use strict";

/**
 * ── Déplacé depuis l'API Gateway le 2026-09-10 ──────────────────────────────
 *
 * Ce test suit le code qu'il protège. Le laisser dans la passerelle en aurait
 * fait un test de code MORT : il aurait continué à passer, en donnant
 * l'impression de couvrir la tarification, pendant que la tarification réelle
 * — celle de Tx-Core — n'aurait été couverte par rien.
 *
 * C'est exactement le défaut trouvé le 2026-09-09 sur le chemin de l'argent des
 * cagnottes : un garde-fou qui ne couvre qu'un dépôt sur deux protège la moitié
 * du chemin en donnant l'impression de le protéger entièrement.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { validateProposedRule } = require("../../src/services/pricing/ruleValidation");

/** Règle valide minimale, réutilisée par surcharge dans chaque cas. */
function baseRule(overrides = {}) {
  return {
    name: "Transfert interne XOF",
    scope: {
      txType: "TRANSFER",
      method: "INTERNAL",
      provider: "paynoval",
      country: "ALL",
      fromCountry: "ALL",
      toCountry: "ALL",
      fromCurrency: "XOF",
      toCurrency: "XOF",
    },
    amountRange: { min: 0, max: null },
    fee: { mode: "PERCENT", fixed: 0, percent: 1, minFee: null, maxFee: null },
    fx: { mode: "PASS_THROUGH" },
    startsAt: null,
    endsAt: null,
    active: true,
    priority: 0,
    ...overrides,
  };
}

test("accepte une règle interne en devise identique", () => {
  // C'est le cas PayNoval → PayNoval, le plus courant, que le formulaire
  // navigateur refusait jusqu'ici en exigeant deux devises différentes.
  assert.deepEqual(validateProposedRule(baseRule()), { ok: true });
});

test("refuse un nom vide", () => {
  const out = validateProposedRule(baseRule({ name: "   " }));
  assert.equal(out.ok, false);
  assert.match(out.message, /nom/i);
});

test("refuse une devise qui n'est pas un code ISO", () => {
  const rule = baseRule();
  rule.scope.fromCurrency = "F CFA";
  const out = validateProposedRule(rule);
  assert.equal(out.ok, false);
  assert.match(out.message, /ISO/i);
});

test("refuse la méthode INTERNAL avec un fournisseur autre que paynoval", () => {
  const rule = baseRule();
  rule.scope.provider = "wave";
  const out = validateProposedRule(rule);
  assert.equal(out.ok, false);
  assert.match(out.message, /paynoval/i);
});

test("refuse un mode de frais en pourcentage sans pourcentage", () => {
  const out = validateProposedRule(
    baseRule({ fee: { mode: "PERCENT", fixed: 0, percent: null, minFee: null, maxFee: null } })
  );
  assert.equal(out.ok, false);
  assert.match(out.message, /pourcentage/i);
});

test("refuse un mode de frais fixe sans montant fixe", () => {
  const out = validateProposedRule(
    baseRule({ fee: { mode: "FIXED", fixed: null, percent: 0, minFee: null, maxFee: null } })
  );
  assert.equal(out.ok, false);
  assert.match(out.message, /fixe/i);
});

test("refuse minFee supérieur à maxFee", () => {
  const out = validateProposedRule(
    baseRule({ fee: { mode: "PERCENT", fixed: 0, percent: 1, minFee: 500, maxFee: 100 } })
  );
  assert.equal(out.ok, false);
  assert.match(out.message, /minimum/i);
});

test("refuse une tranche de montant inversée", () => {
  const out = validateProposedRule(baseRule({ amountRange: { min: 5000, max: 100 } }));
  assert.equal(out.ok, false);
  assert.match(out.message, /tranche|montant/i);
});

test("refuse le mode OVERRIDE sans taux strictement positif", () => {
  const out = validateProposedRule(baseRule({ fx: { mode: "OVERRIDE", overrideRate: 0 } }));
  assert.equal(out.ok, false);
  assert.match(out.message, /taux impos/i);
});

test("refuse le mode MARKUP_PERCENT sans marge", () => {
  const out = validateProposedRule(
    baseRule({ fx: { mode: "MARKUP_PERCENT", markupPercent: null } })
  );
  assert.equal(out.ok, false);
  assert.match(out.message, /marge/i);
});

test("refuse une date de fin antérieure à la date de début", () => {
  const out = validateProposedRule(
    baseRule({ startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-08-01T00:00:00Z" })
  );
  assert.equal(out.ok, false);
  assert.match(out.message, /date/i);
});

test("refuse une marge saisie alors que le mode est PASS_THROUGH", () => {
  const out = validateProposedRule(
    baseRule({ fx: { mode: "PASS_THROUGH", markupPercent: 2 } })
  );
  assert.equal(out.ok, false);
  assert.match(out.message, /march/i);
});
