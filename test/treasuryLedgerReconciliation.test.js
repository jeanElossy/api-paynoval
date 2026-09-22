"use strict";

/**
 * Trésorerie ↔ grand livre (2026-09-22) — voir
 * `services/ledger/treasuryLedgerReconciliation.js`.
 *
 * Le contrôle existait pour les portefeuilles CLIENTS et manquait pour les
 * comptes internes, ceux qui encaissent frais et marge de change. Un client
 * voit son solde faux en une journée ; une trésorerie peut dériver des mois.
 *
 * Module pur : aucune base, aucun réseau.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ANOMALIES,
  VERDICTS,
  reconcileTreasury,
  summarize,
} = require("../src/services/ledger/treasuryLedgerReconciliation");

const USER = "69dadd3370fd7d74cf627182";
const TYPE = "FEES_TREASURY";
const account = (cur) => `treasury:${TYPE}:${USER}:${cur}`;

const wallet = (balances) => ({ userId: USER, systemType: TYPE, balances });

const entry = (over = {}) => ({
  _id: over._id || "e1",
  accountId: over.accountId || account("CAD"),
  currency: over.currency || "CAD",
  direction: over.direction || "CREDIT",
  amount: over.amount ?? "10.00",
  status: over.status || "POSTED",
});

test("solde conforme au cumul des écritures ⇒ OK", () => {
  const r = reconcileTreasury({
    wallet: wallet({ CAD: 25 }),
    entries: [entry({ amount: "30.00" }), entry({ _id: "e2", direction: "DEBIT", amount: "5.00" })],
  });

  assert.equal(r.verdict, VERDICTS.OK);
  assert.deepEqual(r.anomalies, []);
  assert.equal(r.currencies[0].ledger, "25.00");
});

test("écart au-delà de la tolérance ⇒ DRIFT nommé, avec le montant de l'écart", () => {
  const r = reconcileTreasury({ wallet: wallet({ CAD: 97.91 }), entries: [entry({ amount: "50.00" })] });

  assert.equal(r.verdict, VERDICTS.DRIFT);
  assert.equal(r.anomalies[0].code, ANOMALIES.BALANCE_DRIFT);
  assert.equal(r.anomalies[0].ecart, "47.91");
});

test("un solde non nul SANS aucune écriture se nomme autrement qu'une dérive", () => {
  // Cas mesuré sur les bases -test : soldes hérités d'une base antérieure,
  // sans aucune écriture au grand livre de cette base.
  const r = reconcileTreasury({ wallet: wallet({ CAD: 97.91 }), entries: [] });

  assert.equal(r.verdict, VERDICTS.DRIFT);
  assert.equal(r.anomalies[0].code, ANOMALIES.UNBACKED_BALANCE);
});

test("tolérance : un arrondi de représentation ne déclenche pas d'alerte", () => {
  const r = reconcileTreasury({
    wallet: wallet({ CAD: 16.150000000000002 }),
    entries: [entry({ amount: "16.15" })],
  });

  assert.equal(r.verdict, VERDICTS.OK);
});

test("des écritures dans une devise absente du solde sont SIGNALÉES, pas ignorées", () => {
  const r = reconcileTreasury({
    wallet: wallet({ CAD: 0 }),
    entries: [entry({ _id: "x", accountId: account("XOF"), currency: "XOF", amount: "30000" })],
  });

  assert.equal(r.verdict, VERDICTS.DRIFT);
  assert.ok(r.anomalies.some((a) => a.code === ANOMALIES.MISSING_BALANCE && a.currency === "XOF"));
});

test("montant illisible ou statut inattendu ⇒ INDÉTERMINÉ, jamais « OK »", () => {
  const illisible = reconcileTreasury({
    wallet: wallet({ CAD: 10 }),
    entries: [entry({ amount: "abc" })],
  });
  assert.equal(illisible.verdict, VERDICTS.INDETERMINATE);

  const statut = reconcileTreasury({
    wallet: wallet({ CAD: 10 }),
    entries: [entry({ amount: "10.00", status: "DRAFT" })],
  });
  assert.equal(statut.verdict, VERDICTS.INDETERMINATE);
  assert.equal(statut.anomalies[0].code, ANOMALIES.UNEXPECTED_ENTRY_STATUS);
});

test("une écriture visant un AUTRE compte n'est jamais comptée dans ce solde", () => {
  const r = reconcileTreasury({
    wallet: wallet({ CAD: 0 }),
    entries: [entry({ accountId: "treasury:FX_MARGIN_TREASURY:autre:CAD", amount: "500" })],
  });

  assert.equal(r.verdict, VERDICTS.INDETERMINATE);
  assert.equal(r.anomalies[0].code, ANOMALIES.UNEXPECTED_ACCOUNT);
  assert.equal(r.currencies[0].ledger, "0");
});

test("un compte sans propriétaire ou sans type ARRÊTE le contrôle", () => {
  assert.throws(() => reconcileTreasury({ wallet: { systemType: TYPE, balances: {} } }));
  assert.throws(() => reconcileTreasury({ wallet: { userId: USER, balances: {} } }));
});

test("le résumé distingue OK, dérive et indéterminé", () => {
  const ok = reconcileTreasury({ wallet: wallet({ CAD: 10 }), entries: [entry({ amount: "10.00" })] });
  const drift = reconcileTreasury({ wallet: wallet({ CAD: 10 }), entries: [] });
  const indet = reconcileTreasury({ wallet: wallet({ CAD: 10 }), entries: [entry({ amount: "x" })] });

  assert.deepEqual(summarize([ok, drift, indet]), {
    total: 3,
    ok: 1,
    drift: 1,
    indeterminate: 1,
    // L'indéterminé porte DEUX anomalies : le montant illisible, et le solde
    // qui n'est alors adossé à aucune écriture lisible.
    anomalies: 3,
  });
});
