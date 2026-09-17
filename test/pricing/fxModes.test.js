"use strict";

/**
 * Modes de change : bornes jugées contre le marché, perte de change visible,
 * rôle contrôlé dans Tx-Core, re-validation à l'approbation (2026-09-16).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  appliedRateFor,
  assertFxWithinMarket,
  borne,
} = require("../../src/services/pricing/fxModes");
const { assertStaffRole } = require("../../src/services/pricing/governanceRules");
const { assertPublishable } = require("../../src/services/pricing/governanceService");
const { normalizePricingSnapshot, buildTreasuryRevenueBreakdown } = require(
  "../../src/services/pricingSnapshotNormalizer"
);

const XOF_EUR = 1 / 655.957;

function regle(fx, paire = { fromCurrency: "XOF", toCurrency: "EUR" }) {
  return {
    name: "Règle de test",
    scope: { txType: "TRANSFER", method: "INTERNAL", provider: "paynoval", ...paire },
    fee: { mode: "PERCENT", percent: 1 },
    fx,
  };
}

const marche = async () => XOF_EUR;

/* -------------------------------------------------------------------------- */
/* Écart au marché                                                            */
/* -------------------------------------------------------------------------- */

test("un taux imposé saisi dans le mauvais sens (655,957 sur XOF→EUR) est refusé", async () => {
  const r = await assertFxWithinMarket({
    proposed: regle({ mode: "OVERRIDE", overrideRate: 655.957 }),
    getMarketRate: marche,
  });

  assert.equal(r.ok, false);
  assert.match(r.message, /SUPÉRIEUR au taux du marché/);
});

test("un taux imposé d'un facteur dix trop BAS dépasse la borne d'écart", async () => {
  const r = await assertFxWithinMarket({
    proposed: regle({ mode: "OVERRIDE", overrideRate: XOF_EUR / 10 }),
    getMarketRate: marche,
  });

  assert.equal(r.ok, false);
  assert.match(r.message, /au-delà de la borne/);
});

test("un taux imposé légèrement sous le marché est accepté", async () => {
  const r = await assertFxWithinMarket({
    proposed: regle({ mode: "OVERRIDE", overrideRate: XOF_EUR * 0.98 }),
    getMarketRate: marche,
  });

  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.deviationPercent + 2) < 1e-9);
});

test("un ajustement absolu hors d'échelle pour le corridor est refusé", async () => {
  // −0,01 sur un taux de 0,0015 : le taux client deviendrait négatif.
  const r = await assertFxWithinMarket({
    proposed: regle({ mode: "DELTA_ABS", deltaAbs: -0.01 }),
    getMarketRate: marche,
  });

  assert.equal(r.ok, false);
});

test("sans taux de marché, un taux imposé n'est pas publiable — échec en fermeture", async () => {
  const r = await assertFxWithinMarket({
    proposed: regle({ mode: "OVERRIDE", overrideRate: XOF_EUR }),
    getMarketRate: async () => {
      throw new Error("panne");
    },
  });

  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test("les modes relatifs au marché ne demandent pas de taux de marché pour être jugés", async () => {
  let interroge = false;
  const r = await assertFxWithinMarket({
    proposed: regle({ mode: "MARKUP_PERCENT", markupPercent: 1.5 }),
    getMarketRate: async () => {
      interroge = true;
      return XOF_EUR;
    },
  });

  assert.equal(r.ok, true);
  assert.equal(interroge, false);
});

test("une borne d'environnement illisible retombe sur le défaut, jamais sur NaN", () => {
  assert.equal(borne("X", 10, { X: "abc" }), 10);
  assert.equal(borne("X", 10, { X: "-3" }), 10);
  assert.equal(borne("X", 10, { X: "5" }), 5);
});

test("appliedRateFor rend null plutôt qu'un taux nul ou négatif", () => {
  assert.equal(appliedRateFor({ mode: "MARKUP_PERCENT", fx: { markupPercent: 100 }, marketRate: 450 }), null);
  assert.equal(appliedRateFor({ mode: "PASS_THROUGH", fx: {}, marketRate: null }), null);
  assert.equal(appliedRateFor({ mode: "OVERRIDE", fx: { overrideRate: 400 } }), 400);
});

/* -------------------------------------------------------------------------- */
/* Re-validation à l'approbation                                              */
/* -------------------------------------------------------------------------- */

test("une demande hors bornes n'est pas publiable, même déjà déposée", async () => {
  await assert.rejects(
    assertPublishable({
      request: { action: "update", proposed: regle({ mode: "OVERRIDE", overrideRate: 655.957 }) },
      getMarketRate: marche,
    }),
    (err) => err.status === 400 && /non publiable/.test(err.message)
  );

  await assert.rejects(
    assertPublishable({
      request: { action: "create", proposed: regle({ mode: "DELTA_PERCENT", percent: 3 }) },
      getMarketRate: marche,
    }),
    (err) => err.status === 400
  );
});

test("une demande conforme est publiable, et un archivage n'est pas rejugé", async () => {
  await assertPublishable({
    request: { action: "create", proposed: regle({ mode: "MARKUP_PERCENT", markupPercent: 1.5 }) },
    getMarketRate: marche,
  });

  await assertPublishable({ request: { action: "archive", proposed: null } });
});

/* -------------------------------------------------------------------------- */
/* Rôle                                                                       */
/* -------------------------------------------------------------------------- */

test("la gouvernance tarifaire exige un rôle admin dans Tx-Core aussi", () => {
  assert.throws(() => assertStaffRole(null), (e) => e.status === 401);
  assert.throws(() => assertStaffRole({ _id: "u1", role: "user" }), (e) => e.status === 403);
  assert.throws(() => assertStaffRole({ _id: null, role: "internal" }), (e) => e.status === 401);
  assert.doesNotThrow(() => assertStaffRole({ _id: "u1", role: "admin" }));
  assert.doesNotThrow(() => assertStaffRole({ _id: "u1", role: "SuperAdmin" }));
  assert.throws(() => assertStaffRole({ _id: "u1", role: "admin" }, ["superadmin"]), (e) => e.status === 403);
});

/* -------------------------------------------------------------------------- */
/* La perte de change atteint la transaction                                  */
/* -------------------------------------------------------------------------- */

test("le sens de la marge traverse le normalisateur jusqu'à la trésorerie", () => {
  const snap = {
    request: { fromCurrency: "CAD", toCurrency: "XOF" },
    result: {
      fee: 2,
      grossFrom: 100,
      netFrom: 98,
      netTo: 45080,
      marketRate: 450,
      appliedRate: 460,
      fxRevenue: { amount: 0, signedAmount: -980, favorsCustomer: true, measured: true },
    },
  };

  const norm = normalizePricingSnapshot(snap);
  assert.equal(norm.result.fxRevenue.signedAmount, -980);
  assert.equal(norm.result.fxRevenue.favorsCustomer, true);

  const tresorerie = buildTreasuryRevenueBreakdown(snap);
  assert.equal(tresorerie.fxRevenue.signedAmount, -980);
  assert.equal(tresorerie.fxRevenue.sourceAmount, 0, "une perte ne se crédite pas");
});

test("un devis ancien, sans mesure, reste « inconnu » — pas « aucune perte »", () => {
  const norm = normalizePricingSnapshot({
    request: { fromCurrency: "CAD", toCurrency: "XOF" },
    result: { fxRevenue: { amount: 10 } },
  });

  assert.equal(norm.result.fxRevenue.measured, null);
  assert.equal(norm.result.fxRevenue.signedAmount, null);
  assert.equal(norm.result.fxRevenue.favorsCustomer, null);
});

/* -------------------------------------------------------------------------- */
/* Câblage — ces appels vivent dans du code qu'aucun test n'exécute (base)     */
/* -------------------------------------------------------------------------- */

const fs = require("node:fs");
const path = require("node:path");

const lire = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", "..", "src", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function corpsDe(source, entete) {
  const debut = source.indexOf(entete);
  assert.ok(debut >= 0, `introuvable : ${entete}`);
  const suite = source.indexOf("\nexports.", debut + entete.length);
  const suiteFn = source.indexOf("\nasync function ", debut + entete.length);
  const fins = [suite, suiteFn].filter((i) => i > 0);
  return source.slice(debut, fins.length ? Math.min(...fins) : undefined);
}

test("câblage : l'approbation re-valide AVANT de réserver la demande", () => {
  const corps = corpsDe(lire("services/pricing/governanceService.js"), "async function applyChangeRequest(");
  const valide = corps.indexOf("await assertPublishable(");
  const reserve = corps.indexOf("findOneAndUpdate(");

  assert.ok(valide > 0, "applyChangeRequest n'appelle plus assertPublishable");
  assert.ok(valide < reserve, "la re-validation doit précéder la réservation");
});

test("câblage : chaque route de gouvernance contrôle le rôle, et le dépôt juge le marché", () => {
  const src = lire("controllers/pricing/pricingChangeRequestsController.js");

  for (const nom of ["create", "list", "getById", "cancel", "reject", "approve", "retryApply", "preview"]) {
    assert.match(
      corpsDe(src, `exports.${nom} = async`),
      /assertStaffRole\(req\.user/,
      `exports.${nom} ne contrôle pas le rôle`
    );
  }

  assert.match(corpsDe(src, "exports.create = async"), /await assertFxWithinMarket\(/);
});

test("le schéma du devis DÉCLARE le sens de la marge — sinon il l'écarte à l'écriture", () => {
  const mongoose = require("mongoose");
  const conn = mongoose.createConnection(); // non connectée : lecture du schéma seulement
  const PricingQuote = require("../../src/models/pricing/PricingQuote")(conn);

  for (const champ of ["measured", "signedAmount", "favorsCustomer"]) {
    assert.ok(
      PricingQuote.schema.path(`result.fxRevenue.${champ}`),
      `result.fxRevenue.${champ} absent du schéma strict : la perte de change disparaîtrait au verrou`
    );
  }
});
