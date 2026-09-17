"use strict";

/**
 * La réponse d'initiation est destinée à l'UTILISATEUR : elle porte le montant
 * réservé (dont l'application a besoin pour son solde affiché) et jamais les
 * revenus de trésorerie de PayNoval (2026-09-16).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildInitiationMoney } = require("../../src/services/transactions/shared/pricing");

test("money.source porte le montant réservé et sa devise", () => {
  const m = buildInitiationMoney({
    sourceAmount: 10000,
    sourceCurrency: "XOF",
    feeAmount: 100,
    targetAmount: 14.87,
    targetCurrency: "EUR",
    rate: 0.0015022,
  });

  assert.deepEqual(m.source, { amount: 10000, currency: "XOF" });
  assert.deepEqual(m.target, { amount: 14.87, currency: "EUR" });
  assert.equal(m.fxRateSourceToTarget, 0.0015022);
});

test("un montant illisible sort null, jamais 0", () => {
  const m = buildInitiationMoney({ sourceAmount: NaN, sourceCurrency: "XOF", feeAmount: undefined, rate: "1" });
  assert.equal(m.source.amount, null);
  assert.equal(m.feeSource.amount, null);
  assert.equal(m.fxRateSourceToTarget, null);
});

function reponses201(fichier) {
  const src = fs
    .readFileSync(path.join(__dirname, "..", "..", "src", "services", "transactions", "handlers", fichier), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const blocs = [];
  let i = src.indexOf("res.status(201).json(");
  while (i >= 0) {
    blocs.push(src.slice(i, src.indexOf("\n    });", i)));
    i = src.indexOf("res.status(201).json(", i + 1);
  }
  return blocs;
}

test("aucune réponse d'initiation ne publie les revenus de PayNoval, toutes publient money", () => {
  const blocs = [
    ...reponses201("initiateInternal.js"),
    ...reponses201("initiateExternalTransactions.js"),
  ];

  assert.equal(blocs.length, 3, "trois réponses d'initiation attendues");

  for (const bloc of blocs) {
    assert.doesNotMatch(bloc, /feeRevenue|fxRevenue|treasuryRevenue/);
    assert.match(bloc, /money: buildInitiationMoney\(/);
  }
});
