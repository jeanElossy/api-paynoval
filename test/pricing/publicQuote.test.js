"use strict";

/**
 * Le devis public (`/pricing/quote`, sans session) ne rend que ce que le client
 * paie et reçoit, et un visiteur ne peut pas remplir le registre des corridors
 * non couverts (2026-09-16).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPublicQuotePayload } = require("../../src/services/pricing/quoteService");
const {
  estCorridorEnregistrable,
  champsDuCorridor,
} = require("../../src/services/pricing/coverage");

const devisInterne = {
  request: { txType: "TRANSFER", method: "INTERNAL", amount: 100, fromCurrency: "CAD", toCurrency: "XOF", provider: "paynoval" },
  result: {
    marketRate: 450,
    appliedRate: 443.25,
    fee: 1,
    feeBreakdown: { mode: "PERCENT", percent: 1, fixed: 0, minFee: null, maxFee: null, feeRaw: 1 },
    grossFrom: 100,
    netFrom: 99,
    netTo: 43882,
    feeRevenue: { amount: 1, amountCAD: 1 },
    fxRevenue: { amount: 668, amountCAD: 1.49, signedAmount: 668 },
  },
  ruleApplied: { ruleId: "65f0c0ffee", currentVersion: 3 },
  fxRuleApplied: { id: "x" },
  debug: { fxComputation: { gainFormula: "…" } },
};

/** Tous les chemins de feuilles d'un objet, pour comparer à une liste blanche. */
function chemins(obj, prefixe = "") {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? chemins(v, `${prefixe}${k}.`) : [`${prefixe}${k}`]
  );
}

test("le devis public ne contient QUE la liste blanche", () => {
  const publie = buildPublicQuotePayload({ quote: devisInterne });

  assert.deepEqual(chemins(publie).sort(), [
    "mode",
    "ok",
    "request.amount",
    "request.country",
    "request.fromCountry",
    "request.fromCurrency",
    "request.method",
    "request.operator",
    "request.provider",
    "request.toCountry",
    "request.toCurrency",
    "request.txType",
    "result.appliedRate",
    "result.fee",
    "result.feeBreakdown.fixed",
    "result.feeBreakdown.maxFee",
    "result.feeBreakdown.minFee",
    "result.feeBreakdown.mode",
    "result.feeBreakdown.percent",
    "result.grossFrom",
    "result.marketRate",
    "result.netFrom",
    "result.netTo",
    "success",
  ]);

  const texte = JSON.stringify(publie);
  for (const interdit of ["Revenue", "ruleApplied", "65f0c0ffee", "debug", "amountCAD"]) {
    assert.ok(!texte.includes(interdit), `« ${interdit} » ne doit pas sortir publiquement`);
  }
});

test("le devis public ne fabrique pas de valeur : absent reste null", () => {
  const publie = buildPublicQuotePayload({ quote: { request: {}, result: {} } });
  assert.equal(publie.result.fee, null);
  assert.equal(publie.result.appliedRate, null);
  assert.equal(publie.result.netTo, null);
});

test("un corridor bien formé s'enregistre", () => {
  assert.equal(
    estCorridorEnregistrable({ txType: "TRANSFER", method: "INTERNAL", fromCurrency: "EUR", toCurrency: "XOF", fromCountry: "FR", toCountry: "CI", provider: "paynoval" }),
    true
  );
});

test("un visiteur ne peut pas fabriquer de corridors dans le registre", () => {
  const base = { txType: "TRANSFER", method: "INTERNAL", fromCurrency: "EUR", toCurrency: "XOF" };

  for (const faux of [
    { ...base, txType: "HACK" },
    { ...base, fromCurrency: "EURO" },
    { ...base, toCurrency: "x".repeat(500) },
    { ...base, fromCountry: "FRANCE-ET-PLUS" },
    { ...base, provider: "a".repeat(200) },
    { ...base, method: "BANK" },
  ]) {
    assert.equal(estCorridorEnregistrable(faux), false, JSON.stringify(faux).slice(0, 80));
  }
});

test("seuls les champs du corridor sont stockés, jamais l'objet reçu", () => {
  const stocke = champsDuCorridor({ txType: "TRANSFER", fromCurrency: "EUR", toCurrency: "XOF", $where: "1", injecte: "x" });
  assert.ok(!("injecte" in stocke));
  assert.ok(!("$where" in stocke));
});

test("câblage : la route publique projette, et l'enregistrement filtre avant d'écrire", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const lire = (rel) =>
    fs
      .readFileSync(path.join(__dirname, "..", "..", "src", rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  const controleur = lire("controllers/pricingController.js");
  const corpsQuote = controleur.slice(controleur.indexOf("async function quote("), controleur.indexOf("async function lock("));
  assert.match(corpsQuote, /buildPublicQuotePayload\(/);
  assert.doesNotMatch(corpsQuote, /buildQuoteResponsePayload\(/);

  const couverture = lire("services/pricing/coverage.js");
  const corps = couverture.slice(couverture.indexOf("async function recordCoverageGap("));
  const filtre = corps.indexOf("estCorridorEnregistrable(");
  const ecriture = corps.indexOf("updateOne(");
  assert.ok(filtre > 0 && filtre < ecriture, "le filtre doit précéder l'écriture");
});

test("/fees/simulate (publique) ne sert ni la marge, ni les règles, ni des zéros fabriqués", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs
    .readFileSync(path.join(__dirname, "..", "..", "src", "controllers", "pricing", "feesController.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const corps = src.slice(src.indexOf("simulateFee"));

  for (const interdit of [/\bdebug:\s*\{/, /fxRevenue/, /baremeId/, /fxRuleApplied/, /fxStale/, /result\.\w+\s*\|\|\s*0/]) {
    assert.doesNotMatch(corps, interdit, `motif interdit dans la réponse publique : ${interdit}`);
  }
});

test("/exchange-rates/rate (publique) refuse tout autre mode que le taux du marché", async () => {
  const { getRatePublic } = require("../../src/controllers/pricing/exchangeRatesController");

  let statut = null;
  let corps = null;
  const res = {
    status(s) {
      statut = s;
      return this;
    },
    json(b) {
      corps = b;
      return this;
    },
    setHeader() {},
  };

  await getRatePublic({ query: { from: "XOF", to: "EUR", mode: "effective" } }, res);

  assert.equal(statut, 400);
  assert.equal(corps.code, "FX_MODE_UNSUPPORTED");
});
