"use strict";

/**
 * ============================================================================
 * LE CALCUL DU PRIX — CE QUE PERSONNE NE TESTAIT
 * ============================================================================
 *
 * Au 2026-09-16, `test/pricing/` couvrait la fenêtre de validité, la détection
 * de couverture, le diff et la validation d'un barème proposé. Le CALCUL —
 * quatre modes de frais, cinq modes de change, plancher, plafond, arrondi —
 * n'était couvert par rien. C'est pourtant lui qui décide de ce qu'un client
 * paie (règle B.5).
 *
 * ── La version du barème ────────────────────────────────────────────────────
 *
 * Le moteur inscrivait `version: rule.version`, un champ que la gouvernance
 * n'écrit plus depuis qu'elle versionne par `currentVersion`. Toute transaction
 * citait donc « version 1 », et le versionnage devenait inexploitable en
 * litige. Le test correspondant tombe si quelqu'un rebranche l'ancien champ.
 *
 * Tests **purs** : le moteur ne touche ni base ni réseau, le taux de marché est
 * injecté.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeQuote,
  computeFee,
  roundMoney,
  decimalsForCurrency,
} = require("../../src/services/pricing/pricingEngine");

function regle(overrides = {}) {
  return {
    _id: "r-1",
    name: "Règle",
    active: true,
    priority: 0,
    currentVersion: 7,
    version: 1,
    scope: {
      txType: "TRANSFER",
      method: "INTERNAL",
      provider: "paynoval",
      country: "ALL",
      fromCountry: "ALL",
      toCountry: "ALL",
      fromCurrency: "CAD",
      toCurrency: "XOF",
    },
    amountRange: { min: 0, max: null },
    fee: { mode: "PERCENT", percent: 2 },
    fx: { mode: "PASS_THROUGH" },
    ...overrides,
  };
}

const demande = {
  txType: "TRANSFER",
  method: "INTERNAL",
  provider: "paynoval",
  amount: 100,
  fromCurrency: "CAD",
  toCurrency: "XOF",
};

const marcheA450 = async () => 450;

/* -------------------------------------------------------------------------- */
/* Arrondi                                                                    */
/* -------------------------------------------------------------------------- */

test("les devises sans décimale s'arrondissent à l'unité", () => {
  assert.equal(decimalsForCurrency("XOF"), 0);
  assert.equal(decimalsForCurrency("XAF"), 0);
  assert.equal(decimalsForCurrency("CAD"), 2);

  assert.equal(roundMoney(1234.6, "XOF"), 1235);
  assert.equal(roundMoney(1.005, "CAD"), 1.01);
});

/* -------------------------------------------------------------------------- */
/* Les quatre modes de frais                                                  */
/* -------------------------------------------------------------------------- */

test("mode NONE : aucun frais", () => {
  assert.equal(computeFee(100, { mode: "NONE" }, "CAD").fee, 0);
});

test("mode FIXED : le montant ne dépend pas de la somme envoyée", () => {
  assert.equal(computeFee(100, { mode: "FIXED", fixed: 2.5 }, "CAD").fee, 2.5);
  assert.equal(computeFee(10000, { mode: "FIXED", fixed: 2.5 }, "CAD").fee, 2.5);
});

test("mode PERCENT : proportionnel, arrondi à la devise", () => {
  assert.equal(computeFee(100, { mode: "PERCENT", percent: 2 }, "CAD").fee, 2);
  assert.equal(computeFee(10000, { mode: "PERCENT", percent: 1.5 }, "XOF").fee, 150);
});

test("mode MIXED : part fixe ET part proportionnelle", () => {
  assert.equal(
    computeFee(100, { mode: "MIXED", fixed: 1, percent: 2 }, "CAD").fee,
    3
  );
});

test("le plancher et le plafond de frais mordent", () => {
  assert.equal(
    computeFee(10, { mode: "PERCENT", percent: 1, minFee: 5 }, "CAD").fee,
    5
  );

  assert.equal(
    computeFee(100000, { mode: "PERCENT", percent: 10, maxFee: 25 }, "CAD").fee,
    25
  );
});

/* -------------------------------------------------------------------------- */
/* Les cinq modes de change                                                   */
/* -------------------------------------------------------------------------- */

test("PASS_THROUGH applique le taux du marché, sans marge", async () => {
  const q = await computeQuote({
    req: demande,
    rules: [regle()],
    getMarketRate: marcheA450,
  });

  assert.equal(q.result.marketRate, 450);
  assert.equal(q.result.appliedRate, 450);
  assert.equal(q.result.fxRevenue.amount, 0);
});

test("MARKUP_PERCENT retient la marge pour PayNoval", async () => {
  const q = await computeQuote({
    req: demande,
    rules: [regle({ fx: { mode: "MARKUP_PERCENT", markupPercent: 2 } })],
    getMarketRate: marcheA450,
  });

  assert.equal(q.result.appliedRate, 441); // 450 × (1 − 0,02)
  assert.ok(q.result.appliedRate < q.result.marketRate);

  // La marge est le manque à gagner du client, en devise de réception.
  assert.equal(q.result.fxRevenue.amount, Math.round(98 * (450 - 441)));
});

test("OVERRIDE impose le taux et ne cite aucun taux de marché", async () => {
  const q = await computeQuote({
    req: demande,
    rules: [regle({ fx: { mode: "OVERRIDE", overrideRate: 400 } })],
    getMarketRate: async () => {
      throw new Error("le marché ne doit pas être interrogé");
    },
  });

  assert.equal(q.result.appliedRate, 400);
  assert.equal(q.result.marketRate, null);
});

test("DELTA_PERCENT et DELTA_ABS ajustent le taux du marché", async () => {
  const relatif = await computeQuote({
    req: demande,
    rules: [regle({ fx: { mode: "DELTA_PERCENT", percent: -1 } })],
    getMarketRate: marcheA450,
  });

  assert.equal(relatif.result.appliedRate, 445.5);

  const absolu = await computeQuote({
    req: demande,
    rules: [regle({ fx: { mode: "DELTA_ABS", deltaAbs: -10 } })],
    getMarketRate: marcheA450,
  });

  assert.equal(absolu.result.appliedRate, 440);
});

/* -------------------------------------------------------------------------- */
/* L'arithmétique du devis                                                    */
/* -------------------------------------------------------------------------- */

test("les montants racontent la même histoire : net = brut − frais, puis conversion", async () => {
  const q = await computeQuote({
    req: demande,
    rules: [regle()],
    getMarketRate: marcheA450,
  });

  assert.equal(q.result.grossFrom, 100);
  assert.equal(q.result.fee, 2);
  assert.equal(q.result.netFrom, 98);
  assert.equal(q.result.netTo, 44100); // 98 × 450, arrondi XOF
});

test("des frais supérieurs au montant ARRÊTENT la cotation", async () => {
  await assert.rejects(
    computeQuote({
      req: { ...demande, amount: 1 },
      rules: [regle({ fee: { mode: "FIXED", fixed: 50 } })],
      getMarketRate: marcheA450,
    }),
    (err) => err.status === 400
  );
});

test("un taux indisponible ARRÊTE la cotation : aucun repli à 1", async () => {
  await assert.rejects(
    computeQuote({
      req: demande,
      rules: [regle()],
      getMarketRate: async () => null,
    }),
    (err) => err.status === 503
  );
});

test("aucun barème ne couvre le corridor → 404, jamais un prix inventé", async () => {
  await assert.rejects(
    computeQuote({ req: demande, rules: [], getMarketRate: marcheA450 }),
    (err) => err.status === 404
  );
});

/* -------------------------------------------------------------------------- */
/* La version appliquée                                                       */
/* -------------------------------------------------------------------------- */

test("la version citée est `currentVersion`, celle que la gouvernance écrit", async () => {
  const q = await computeQuote({
    req: demande,
    rules: [regle({ currentVersion: 7, version: 1 })],
    getMarketRate: marcheA450,
  });

  assert.equal(
    q.ruleApplied.version,
    7,
    "citer `rule.version` rendrait tout litige inexploitable : ce champ n'est " +
      "plus écrit par le circuit de gouvernance et vaut 1 partout."
  );

  assert.equal(q.ruleApplied.currentVersion, 7);
  assert.equal(q.ruleApplied.ruleId, "r-1");
});

/* -------------------------------------------------------------------------- */
/* Pas de change ⇒ pas de marge de change                                     */
/* -------------------------------------------------------------------------- */

const memeDevise = {
  txType: "TRANSFER",
  method: "INTERNAL",
  provider: "paynoval",
  amount: 10000,
  fromCurrency: "XOF",
  toCurrency: "XOF",
};

function regleMemeDevise(fx) {
  return regle({
    scope: { ...regle().scope, fromCurrency: "XOF", toCurrency: "XOF" },
    fee: { mode: "PERCENT", percent: 1 },
    fx,
  });
}

test("une marge ne s'applique PAS quand il n'y a aucune conversion", async () => {
  /**
   * ⚠️ LE DÉFAUT QUE CE TEST FIGE.
   *
   * Sur un corridor en devise identique le taux de marché vaut 1, et une règle
   * `MARKUP_PERCENT` l'appliquait quand même : 1 × (1 − 1,5/100) = 0,985.
   * L'expéditeur envoyait 10 000 XOF, le bénéficiaire en recevait 9 850 — sans
   * la moindre conversion. Une marge de change sans change est un frais caché,
   * qui n'apparaît sur aucune ligne de frais.
   *
   * Les six règles en base évitaient le piège par CONVENTION (PASS_THROUGH sur
   * CI→CI et CA→CA). Une convention n'est pas une garantie.
   */
  const q = await computeQuote({
    req: memeDevise,
    rules: [regleMemeDevise({ mode: "MARKUP_PERCENT", markupPercent: 1.5 })],
    getMarketRate: async () => 1,
  });

  assert.equal(q.result.appliedRate, 1);
  assert.equal(q.result.netFrom, 9900); // 10 000 − 1 % de frais
  assert.equal(
    q.result.netTo,
    9900,
    "le bénéficiaire reçoit le net intégral : aucune conversion n'a eu lieu"
  );
  assert.equal(q.result.fxRevenue.amount, 0);
});

test("un taux imposé ne s'applique pas non plus en devise identique", async () => {
  /**
   * Imposer un taux ≠ 1 entre deux comptes de la même devise ferait apparaître
   * ou disparaître de l'argent entre le débit et le crédit.
   */
  const q = await computeQuote({
    req: memeDevise,
    rules: [regleMemeDevise({ mode: "OVERRIDE", overrideRate: 0.9 })],
    getMarketRate: async () => 1,
  });

  assert.equal(q.result.appliedRate, 1);
  assert.equal(q.result.netTo, q.result.netFrom);
});

test("en devise identique, le taux de marché n'est même pas interrogé", async () => {
  const q = await computeQuote({
    req: memeDevise,
    rules: [regleMemeDevise({ mode: "MARKUP_PERCENT", markupPercent: 2 })],
    getMarketRate: async () => {
      throw new Error("aucun taux ne doit être demandé sans conversion");
    },
  });

  assert.equal(q.result.appliedRate, 1);
  assert.equal(q.result.marketRate, 1);
});

test("la conversion réelle, elle, applique bien la marge", async () => {
  /* Le garde ne doit pas neutraliser la marge là où elle est légitime. */
  const q = await computeQuote({
    req: demande,
    rules: [regle({ fx: { mode: "MARKUP_PERCENT", markupPercent: 1.5 } })],
    getMarketRate: marcheA450,
  });

  assert.equal(q.result.appliedRate, 450 * 0.985);
  assert.ok(q.result.fxRevenue.amount > 0);
});
