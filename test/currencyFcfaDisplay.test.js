"use strict";

/**
 * « FCFA » partout à l'affichage (2026-11-17, demande de l'utilisateur) : même
 * graphie dans l'application, les e-mails, les push et les messages de Tx-Core.
 * L'ancienne graphie « F CFA » reste LUE en entrée (données historiques), elle
 * n'est plus ÉCRITE. Ce test échoue si un affichage la réintroduit.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { getCurrencySymbolByCode } = require("../src/tools/currency");

const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

test("symbole de XOF et XAF : « FCFA »", () => {
  assert.equal(getCurrencySymbolByCode("XOF"), "FCFA");
  assert.equal(getCurrencySymbolByCode("XAF"), "FCFA");
});

test("les push et in-app de transaction écrivent « FCFA »", () => {
  const src = read("src/services/transactions/transactionNotificationService.js");
  assert.match(src, /return "FCFA";/);
  assert.doesNotMatch(src, /return "F CFA";/);
});

test("le libellé des frais d'annulation en XOF écrit « FCFA »", () => {
  const src = read("src/config/cancellationFees.js");
  assert.doesNotMatch(src, /label: "[^"]*F CFA"/);
  assert.match(src, /XOF: \{ amount: 300, label: "300 FCFA" \}/);
});

test("l'ancienne graphie reste reconnue pour retrouver l'historique (AML)", () => {
  const src = read("src/services/aml.js");
  assert.match(src, /compat\.add\("F CFA"\);/);
  assert.match(src, /compat\.add\("FCFA"\);/);
});
