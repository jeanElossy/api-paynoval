"use strict";

/**
 * AUCUN MOUVEMENT DE TRÉSORERIE SANS ÉCRITURE COMPTABLE — garde statique.
 * =============================================================================
 *
 * Invariant 2 : le grand livre fait foi, le solde n'est qu'une projection. Un
 * crédit de trésorerie posé sans écriture rendrait cette projection
 * invérifiable — et c'est précisément sur ces comptes-là (frais, marge de
 * change, commissions) que personne ne regarde au quotidien.
 *
 * Audit du 2026-09-22 : les six chemins qui déplacent une trésorerie écrivent
 * tous au grand livre. Cette garde fige ce constat. Elle échoue dès qu'un
 * fichier appelle une primitive de mouvement sans poser d'écriture — le cas
 * qu'aucun test ne voyait jusqu'ici.
 *
 * Contrôle de SOURCE, volontairement grossier : il ne prouve pas que chaque
 * mouvement est équilibré (c'est le rôle de `doubleEntry.assertBalanced` et de
 * `treasuryLedgerReconciliation`), il prouve qu'aucun fichier ne déplace une
 * trésorerie en ignorant le grand livre.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

/** Déplacer l'argent d'un compte interne. */
const MOVEMENT = /(?:TxSystemBalance|SystemBalance)\s*\.\s*(?:credit|debit)\s*\(|(?:credit|debit)SystemWallet\s*\(/;

/** Poser des écritures au grand livre. */
/**
 * La liste vient des exports RÉELS de `ledgerService` (plus
 * `postReferralLedgerEntries`, posé par le module parrainage) : un nom inventé
 * ici rendrait la garde aveugle, exactement ce qu'elle doit empêcher.
 */
const LEDGER = new RegExp(
  [
    "postDoubleEntry",
    "createLedgerEntry",
    "postInternalPaymentEntries",
    "postCagnotteLotEntries",
    "postCagnotteVaultWithdrawalEntries",
    "postCagnotteClosureFeeEntries",
    "postReferralLedgerEntries",
  ].join("|") + "\\s*\\("
);

/**
 * Fichiers autorisés à porter la primitive SANS écriture : ceux qui la
 * DÉFINISSENT ou la ré-exportent, jamais ceux qui l'utilisent.
 */
const DEFINITIONS = new Set([
  "models/TxSystemBalance.js",
  "services/ledgerService.js",
  "services/transactions/shared/runtime.js",
]);

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function scan() {
  const movers = [];

  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file);
    if (DEFINITIONS.has(rel)) continue;

    const code = stripComments(fs.readFileSync(file, "utf8"));
    if (!MOVEMENT.test(code)) continue;

    movers.push({ rel, posteDesEcritures: LEDGER.test(code) });
  }

  return movers;
}

test("les chemins qui déplacent une trésorerie sont connus (sanity)", () => {
  const movers = scan();

  assert.ok(
    movers.length >= 4,
    `la détection ne trouve plus les chemins de trésorerie (${movers.length}) — motif cassé ?`
  );
});

test("tout fichier qui déplace une trésorerie écrit AUSSI au grand livre", () => {
  const muets = scan()
    .filter((m) => !m.posteDesEcritures)
    .map((m) => m.rel);

  assert.deepEqual(
    muets,
    [],
    "mouvement de trésorerie sans écriture comptable :\n" +
      muets.join("\n") +
      "\nLe solde d'un compte interne est une PROJECTION (invariant 2) : " +
      "sans écriture, il devient invérifiable."
  );
});

test("la garde attrape un fichier qui crédite sans écrire (mutation)", () => {
  // Vérifie que le motif détecte réellement, plutôt que de passer sur du vide.
  const faux = stripComments(`
    const x = await TxSystemBalance.credit(userId, "FEES_TREASURY", "CAD", 10);
  `);

  assert.equal(MOVEMENT.test(faux), true);
  assert.equal(LEDGER.test(faux), false);
});
