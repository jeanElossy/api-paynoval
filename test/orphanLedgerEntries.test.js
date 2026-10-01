"use strict";

/**
 * Écritures orphelines — les parents légitimes (2026-10-01).
 *
 * Le contrôle ne connaissait que `transactions` : chaque lot de cagnotte
 * (rattaché à son RÈGLEMENT) et chaque reprise de solde (`OPENING_BALANCE`,
 * journal autonome) levait `ORPHAN_LEDGER_ENTRY` pendant 48 h. Mesuré le
 * 2026-10-01 : 12 faux orphelins après la remise à zéro, uniquement des
 * écritures d'ouverture. Ces tests échouent sur l'ancien contrôle (règle B.5)
 * et vérifient qu'un VRAI orphelin reste signalé.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findOrphanEntries,
  ANOMALIES,
} = require("../src/services/reconciliation/transactionReconciliationService");

const entry = (over = {}) => ({
  _id: `le_${Math.random().toString(16).slice(2)}`,
  transactionId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  reference: null,
  entryType: "USER_CREDIT",
  amount: 10,
  currency: "CAD",
  ...over,
});

test("une écriture d'une transaction connue n'est pas orpheline", () => {
  const e = entry();
  assert.deepEqual(findOrphanEntries([e], { parentIds: new Set([e.transactionId]) }), []);
});

test("un lot de cagnotte rattaché à son RÈGLEMENT n'est pas orphelin", () => {
  const settlementId = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const e = entry({ transactionId: settlementId, entryType: "FEE_REVENUE" });
  assert.deepEqual(findOrphanEntries([e], { parentIds: new Set([settlementId]) }), []);
});

test("une reprise de solde (OPENING_BALANCE) est un journal autonome", () => {
  for (const reference of [
    "OPENING:FEES_TREASURY:u1:CAD",
    "RESET_OPENING:FEES_TREASURY:u1:CAD:2026-10-01T21:50:34.000Z",
  ]) {
    const e = entry({ entryType: "OPENING_BALANCE", reference });
    assert.deepEqual(findOrphanEntries([e]), [], reference);
  }
});

test("la contre-passation d'un remboursement d'invité se rattache à son remboursement", () => {
  const e = entry({ reference: "CGR-123:reversal", entryType: "USER_DEBIT" });
  assert.deepEqual(findOrphanEntries([e], { refundReferences: new Set(["CGR-123"]) }), []);
});

test("un VRAI orphelin reste signalé", () => {
  const e = entry({ reference: "inconnue" });
  const out = findOrphanEntries([e], { parentIds: new Set(), refundReferences: new Set() });

  assert.equal(out.length, 1);
  assert.equal(out[0].type, ANOMALIES.ORPHAN_LEDGER_ENTRY);
  assert.equal(out[0].ledgerEntryId, e._id);
});

test("OPENING_BALANCE sans référence d'ouverture reconnue reste orphelin", () => {
  // Le type seul ne suffit pas : sinon n'importe quelle écriture déguisée en
  // reprise échapperait au contrôle.
  const e = entry({ entryType: "OPENING_BALANCE", reference: "autre-chose" });
  assert.equal(findOrphanEntries([e]).length, 1);
});

test("une contre-passation dont le remboursement est introuvable reste orpheline", () => {
  const e = entry({ reference: "CGR-999:reversal" });
  assert.equal(findOrphanEntries([e], { refundReferences: new Set(["CGR-123"]) }).length, 1);
});
