"use strict";

/**
 * ============================================================================
 * UN APPELANT MUET N'EST PLUS TARIFÉ COMME UN TRANSFERT
 * ============================================================================
 *
 * Le défaut figé ici, mesuré le 2026-09-16 : `normalizeTxTypeForPricing`
 * rendait `"TRANSFER"` quand ni `txType` ni `action` n'était fourni. Dépôt,
 * retrait et transfert n'ayant pas les mêmes barèmes, un appelant qui ne se
 * déclarait pas payait un prix d'apparence normale, calculé sur la mauvaise
 * règle.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  resoudreTypeExterne,
  TYPES_EXTERNES,
} = require("../../src/services/transactions/shared/externalTxType");

const RACINE = path.join(__dirname, "..", "..");
const HANDLER = "src/services/transactions/handlers/initiateExternalTransactions.js";

test("⚠️ LE DÉFAUT : un appelant qui ne déclare rien rend `null`, plus `TRANSFER`", () => {
  assert.equal(resoudreTypeExterne({}), null);
  assert.equal(resoudreTypeExterne({ amount: 10000 }), null);
  assert.equal(resoudreTypeExterne(), null);
  assert.equal(resoudreTypeExterne(null), null);
});

test("un type déclaré est retenu tel quel", () => {
  assert.equal(resoudreTypeExterne({ txType: "DEPOSIT" }), "DEPOSIT");
  assert.equal(resoudreTypeExterne({ txType: "withdraw" }), "WITHDRAW");
  assert.equal(resoudreTypeExterne({ transactionType: "TRANSFER" }), "TRANSFER");
  assert.equal(resoudreTypeExterne({ txType: "  deposit  " }), "DEPOSIT");
});

test("`action` reste acceptée — c'est une déclaration, pas une déduction", () => {
  /**
   * L'application mobile pose `txType` ET `action`. Retirer `action` casserait
   * les versions déjà déployées sans rien gagner : elle dit explicitement ce
   * que l'appelant veut faire.
   */
  assert.equal(resoudreTypeExterne({ action: "deposit" }), "DEPOSIT");
  assert.equal(resoudreTypeExterne({ action: "WITHDRAW" }), "WITHDRAW");
});

test("`txType` l'emporte sur `action` quand les deux sont présents", () => {
  assert.equal(
    resoudreTypeExterne({ txType: "WITHDRAW", action: "deposit" }),
    "WITHDRAW"
  );
});

test("une `action` inconnue ne devient pas un type — elle rend `null`", () => {
  /**
   * `action: "send"` n'est pas un type d'opération externe. Le traduire en
   * TRANSFER serait exactement la déduction que ce module refuse.
   */
  assert.equal(resoudreTypeExterne({ action: "send" }), null);
  assert.equal(resoudreTypeExterne({ action: "n'importe quoi" }), null);
});

test("les trois types externes sont fermés", () => {
  assert.deepEqual([...TYPES_EXTERNES], ["TRANSFER", "DEPOSIT", "WITHDRAW"]);
});

test("le handler REFUSE en 400 au lieu de deviner", () => {
  /**
   * Garde de TEXTE : `initiateExternalTransactions.js` n'exporte que ses deux
   * handlers, et aucun test ne les exécute. Sans ce contrôle, le repli
   * `return "TRANSFER"` pourrait revenir sans qu'une seule assertion bouge.
   */
  const source = fs
    .readFileSync(path.join(RACINE, HANDLER), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.match(
    source,
    /require\(\s*["'][^"']*shared\/externalTxType["']\s*\)/,
    "Le handler n'importe plus le résolveur de type."
  );

  assert.doesNotMatch(
    source,
    /return\s+["']TRANSFER["']/,
    "Le repli `return \"TRANSFER\"` est réapparu : un appelant muet serait de nouveau tarifé comme un transfert."
  );

  assert.match(
    source,
    /createError\(\s*400[^)]*TX_TYPE/,
    "Le refus explicite en 400 a disparu."
  );
});
