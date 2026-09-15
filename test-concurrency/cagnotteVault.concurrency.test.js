"use strict";

/**
 * ============================================================================
 * MÊME COFFRE DE CAGNOTTE — `NO GOAL OVERFLOW` · `NO VAULT OVERDRAFT`
 *                            `NO CREDIT AFTER CLOSE` · `NO DOUBLE REVERSAL`
 * ============================================================================
 *
 * Ajouté le 2026-09-15 avec le module Cagnotte v2 (remboursement invité,
 * contributions récurrentes). Une cagnotte populaire est exactement la
 * ressource qu'on dispute : cent personnes paient en même temps, l'objectif
 * approche, le propriétaire clôture, un remboursement est contre-passé.
 *
 * ── Ce qui tient ces invariants — et que cette suite met à l'épreuve
 *
 * Aucun verrou. Chaque écriture de `services/cagnotte/vaultPosition.js` est un
 * compare-and-swap : la condition vit DANS le filtre du `findOneAndUpdate`.
 *   · crédit   : `closedAt: null` + `$expr: collected + montant <= objectif`
 *   · débit    : `balance >= montant` (+ `collected >= montant` pour un remboursement)
 *   · contre-passation : `refunded >= montant`
 * MongoDB évalue le filtre et applique l'incrément sous le même verrou de
 * document : il n'y a pas de fenêtre entre « je lis » et « j'écris ».
 *
 * ── Deux règles du README, appliquées
 *
 * 1. Une rafale sans refus n'a rien éprouvé : chaque scénario demande PLUS que
 *    ce que la ressource couvre, et exige des refus — pour la bonne cause.
 * 2. Après chaque rafale, l'identité comptable de la position est vérifiée :
 *        balance   = crédité − remboursé − retiré − frais de clôture
 *        collecté  = crédité − remboursé
 *    Elle attrape une écriture perdue ou doublée sans connaître le bogue.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const H = require("./lib/harness");

/** XOF : zéro décimale — aucune erreur de virgule flottante ne peut se cacher. */
const DEVISE = "XOF";
const MONTANT = 1000;
const RAFALES = [2, 10, 100, 500];

const vaults = [];
let Position;

const VP = () => require("../src/services/cagnotte/vaultPosition");

before(async () => {
  const e = await H.ouvrir();
  await H.verifierIndex();

  Position = require("../src/models/CagnotteVaultPosition")(e.txConn);

  // Même règle que le harnais : l'index est VÉRIFIÉ, jamais créé ici.
  let index = [];
  try {
    index = await Position.collection.indexes();
  } catch (err) {
    if (!/ns does not exist/i.test(String(err?.message))) throw err;
  }
  assert.ok(
    index.some((ix) => ix.unique === true && H.memeCles({ vaultId: 1 }, ix.key)),
    "⛔ index unique {vaultId} absent sur tx_cagnotte_vault_positions — `npm run indexes:apply` d'abord. " +
      "Sans lui, deux ouvertures simultanées créent deux positions et l'argent se répartit entre elles."
  );
});

after(async () => {
  if (Position && vaults.length) await Position.deleteMany({ vaultId: { $in: vaults } });
  await H.fermer();
});

async function nouveauCoffre({ solde = 0 } = {}) {
  const vaultId = new mongoose.Types.ObjectId().toString();
  const cagnotteId = new mongoose.Types.ObjectId().toString();
  vaults.push(vaultId);

  await VP().openPosition({ Model: Position, vaultId, cagnotteId, currency: DEVISE });
  if (solde > 0) await VP().creditPosition({ Model: Position, vaultId, currency: DEVISE, amount: solde });

  return vaultId;
}

async function lire(vaultId) {
  return VP().positionToJSON(await Position.findOne({ vaultId }).lean());
}

function assertIdentite(p, contexte) {
  assert.equal(
    p.balance,
    p.credited - p.refunded - p.withdrawn - p.closureFees,
    `IDENTITÉ ROMPUE ${contexte} : balance ${p.balance} ≠ crédité ${p.credited} − remboursé ${p.refunded} ` +
      `− retiré ${p.withdrawn} − frais ${p.closureFees}`
  );
  assert.equal(p.collected, p.credited - p.refunded, `COLLECTÉ INCOHÉRENT ${contexte}`);
  assert.ok(p.balance >= 0, `SOLDE NÉGATIF ${contexte} : ${p.balance}`);
}

function causes(r) {
  return new Set(r.echecsBruts.map((e) => e?.code || "SANS_CODE"));
}

/* ── 1. L'objectif ne se dépasse pas ─────────────────────────────────────── */

for (const N of RAFALES) {
  const K = Math.max(1, Math.floor(N / 2));

  test(`${N} participations simultanées sur un objectif qui n'en couvre que ${K}`, async () => {
    const vaultId = await nouveauCoffre();
    const objectif = K * MONTANT;

    const r = await H.rafale(N, () =>
      VP().creditPosition({ Model: Position, vaultId, currency: DEVISE, amount: MONTANT, goalCap: objectif })
    );

    console.log(H.resumer(r, `même coffre · objectif ${objectif} · N=${N}`));

    assert.equal(r.nbReussites, K, `NO GOAL OVERFLOW VIOLÉ : ${r.nbReussites} crédits pour ${K} couverts.`);
    assert.ok(r.nbEchecs > 0, "Aucun refus : la rafale n'a rien éprouvé.");
    for (const c of causes(r)) assert.ok(["GOAL_REACHED", "GOAL_EXCEEDED"].includes(c), `refus pour une mauvaise cause : ${c}`);

    const p = await lire(vaultId);
    assert.equal(p.collected, objectif, `collecté ${p.collected} ≠ objectif ${objectif}`);
    assertIdentite(p, `(objectif, N=${N})`);
  });
}

test("un reste inférieur au montant n'est pas « comblé » partiellement", async () => {
  const vaultId = await nouveauCoffre();

  const r = await H.rafale(10, () =>
    VP().creditPosition({ Model: Position, vaultId, currency: DEVISE, amount: MONTANT, goalCap: 2500 })
  );

  console.log(H.resumer(r, "objectif 2 500, participations de 1 000"));

  assert.equal(r.nbReussites, 2);
  const p = await lire(vaultId);
  assert.equal(p.collected, 2000, "le coffre a dépassé l'objectif ou accepté une participation partielle");
  assertIdentite(p, "(reste < montant)");
});

/* ── 2. Le coffre ne se découvre pas ─────────────────────────────────────── */

for (const N of RAFALES) {
  const K = Math.max(1, Math.floor(N / 2));

  test(`${N} retraits simultanés sur un coffre qui n'en couvre que ${K}`, async () => {
    const vaultId = await nouveauCoffre({ solde: K * MONTANT });

    const r = await H.rafale(N, () =>
      VP().debitPosition({ Model: Position, vaultId, currency: DEVISE, amount: MONTANT, kind: "WITHDRAWAL" })
    );

    console.log(H.resumer(r, `même coffre · couvre ${K} retraits · N=${N}`));

    assert.equal(r.nbReussites, K, `NO VAULT OVERDRAFT VIOLÉ : ${r.nbReussites} retraits pour ${K} couverts.`);
    assert.ok(r.nbEchecs > 0, "Aucun refus : la rafale n'a rien éprouvé.");
    for (const c of causes(r)) assert.equal(c, "VAULT_INSUFFICIENT_BALANCE", `refus pour une mauvaise cause : ${c}`);

    const p = await lire(vaultId);
    assert.equal(p.balance, 0);
    assertIdentite(p, `(retraits, N=${N})`);
  });
}

test("remboursements et retraits mêlés se partagent le solde, sans le dépasser", async () => {
  const K = 50;
  const vaultId = await nouveauCoffre({ solde: K * MONTANT });

  const r = await H.rafale(2 * K, (i) =>
    VP().debitPosition({
      Model: Position,
      vaultId,
      currency: DEVISE,
      amount: MONTANT,
      kind: i % 2 === 0 ? "REFUND" : "WITHDRAWAL",
    })
  );

  console.log(H.resumer(r, `remboursements + retraits · couvre ${K} · N=${2 * K}`));

  assert.equal(r.nbReussites, K);
  assert.ok(r.nbEchecs > 0);

  const p = await lire(vaultId);
  assert.equal(p.balance, 0);
  assert.equal(p.refunded + p.withdrawn, K * MONTANT);
  assertIdentite(p, "(débits mêlés)");
});

/* ── 3. Aucun crédit après la clôture ────────────────────────────────────── */

test("clôture pendant une rafale de participations : aucun crédit sur un coffre clos", async () => {
  const vaultId = await nouveauCoffre();
  const N = 200;

  const r = await H.rafale(N + 1, (i) =>
    i === Math.floor(N / 2)
      ? VP().closePosition({ Model: Position, vaultId }).then(() => "CLOSE")
      : VP().creditPosition({ Model: Position, vaultId, currency: DEVISE, amount: MONTANT })
  );

  const credits = r.reussites.filter((x) => x !== "CLOSE");
  console.log(H.resumer(r, `clôture au milieu de ${N} crédits`) + `\n    ${credits.length} crédits acceptés avant la clôture`);

  // Chaque crédit accepté l'a été sur un coffre OUVERT (le filtre l'exige).
  for (const doc of credits) assert.equal(doc.closedAt ?? null, null, "un crédit a été accepté sur un coffre clos");
  for (const c of causes(r)) assert.equal(c, "VAULT_CLOSED", `refus pour une mauvaise cause : ${c}`);

  const p = await lire(vaultId);
  assert.ok(p.closedAt, "la clôture n'a pas été enregistrée");
  assert.equal(p.credited, credits.length * MONTANT, "crédits perdus ou doublés autour de la clôture");
  assertIdentite(p, "(clôture concurrente)");

  // Après coup, plus aucune participation ne passe.
  await assert.rejects(
    VP().creditPosition({ Model: Position, vaultId, currency: DEVISE, amount: MONTANT }),
    (err) => err.code === "VAULT_CLOSED"
  );
});

/* ── 4. Une contre-passation ne se rejoue pas ────────────────────────────── */

test("50 contre-passations simultanées d'UN remboursement invité refusé : une seule passe", async () => {
  const vaultId = await nouveauCoffre({ solde: 5 * MONTANT });
  await VP().debitPosition({ Model: Position, vaultId, currency: DEVISE, amount: MONTANT, kind: "REFUND" });

  const r = await H.rafale(50, () =>
    VP().reverseRefundDebit({ Model: Position, vaultId, currency: DEVISE, amount: MONTANT })
  );

  console.log(H.resumer(r, "même remboursement contre-passé · N=50"));

  assert.equal(r.nbReussites, 1, `NO DOUBLE REVERSAL VIOLÉ : le coffre a été recrédité ${r.nbReussites} fois.`);
  for (const c of causes(r)) assert.equal(c, "VAULT_POSITION_REVERSAL_REFUSED");

  const p = await lire(vaultId);
  assert.equal(p.balance, 5 * MONTANT, "le coffre n'est pas revenu exactement à son solde d'avant le remboursement");
  assert.equal(p.refunded, 0);
  assertIdentite(p, "(contre-passation)");
});
