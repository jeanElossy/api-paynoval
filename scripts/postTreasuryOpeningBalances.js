#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * REPRISE DE SOLDE DES COMPTES INTERNES — simulation par défaut.
 * -----------------------------------------------------------------------------
 * Mesuré le 2026-09-22 : les cinq trésoreries portent des soldes (9 992,64 CAD,
 * 97,91 CAD, 97,78 CAD, 30 000 XOF, 16,15 CAD) hérités d'une base antérieure,
 * qu'AUCUNE écriture de cette base n'explique. La réconciliation les signale en
 * `UNBACKED_BALANCE` : un solde sans origine comptable.
 *
 * Ce que fait toute reprise comptable — et ce que fait ce script :
 *
 *   on n'invente pas l'historique manquant, on DÉCLARE un point de départ,
 *   daté, motivé et annulable :
 *
 *       CREDIT  treasury:<TYPE>:<userId>:<DEVISE>          écart constaté
 *       DEBIT   system_clearing:OPENING_BALANCE:<DEVISE>   même montant
 *
 * Le compte de compensation dédié mesure alors exactement « ce qui est entré
 * sans histoire » : un chiffre montrable, pas une dilution dans la compensation
 * générale. Une reprise erronée se reprend par CONTRE-ÉCRITURE (invariant 4) —
 * rien ici ne réécrit une écriture existante.
 *
 * ⚠️ AUCUN SOLDE N'EST MODIFIÉ. Le script n'écrit QUE des écritures : l'écart
 * qu'il constate est celui qui existe déjà. Idempotent : la référence
 * `OPENING:<TYPE>:<userId>:<DEVISE>` et un `transactionId` déterministe rendent
 * un second passage sans effet.
 *
 * Usage :
 *   node scripts/postTreasuryOpeningBalances.js                    # simulation
 *   node scripts/postTreasuryOpeningBalances.js --apply            # écrit
 *   node scripts/postTreasuryOpeningBalances.js --apply --motif "…"
 */

require("dotenv").config();

const crypto = require("crypto");
const mongoose = require("mongoose");

const { connectTransactionsDB, getTxConn } = require("../src/config/db");
const { reconcileTreasury } = require("../src/services/ledger/treasuryLedgerReconciliation");
const {
  treasuryAccountId,
  openingBalanceClearingAccountId,
} = require("../src/services/ledger/doubleEntry");
const D = require("../src/services/ledger/decimalMoney");

const APPLY = process.argv.includes("--apply");

const MOTIF =
  (() => {
    const i = process.argv.indexOf("--motif");
    return i >= 0 ? String(process.argv[i + 1] || "").trim() : "";
  })() ||
  "Reprise de solde : compte interne hérité d'une base antérieure, sans écriture d'origine";

/** `transactionId` déterministe : un second passage produit la MÊME clé de
 *  déduplication, donc ne peut pas doubler l'écriture. */
function transactionIdFor(reference) {
  const hash = crypto.createHash("md5").update(reference).digest("hex").slice(0, 24);
  return new mongoose.Types.ObjectId(hash);
}

(async () => {
  await connectTransactionsDB();

  const conn = getTxConn();
  const db = conn.db;
  const ledger = require("../src/services/ledgerService");

  const wallets = await db
    .collection("txsystembalances")
    .find({ isActive: { $ne: false } })
    .toArray();

  const plan = [];

  for (const wallet of wallets) {
    const prefix = `treasury:${String(wallet.systemType).toUpperCase()}:${String(wallet.userId)}:`;

    const entries = await db
      .collection("ledgerentries")
      .find({ accountId: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` } })
      .project({ accountId: 1, currency: 1, direction: 1, amount: 1, status: 1 })
      .toArray();

    const rapport = reconcileTreasury({ wallet, entries });

    for (const ligne of rapport.currencies) {
      const ecart = D.parseDecimal(ligne.ecart);

      if (ecart === null || D.isZero(ecart)) continue;

      plan.push({
        systemType: rapport.systemType,
        userId: rapport.userId,
        currency: ligne.currency,
        stored: ligne.stored,
        ledger: ligne.ledger,
        ecart: D.format(ecart),
        sens: D.compare(ecart, D.zero()) > 0 ? "CREDIT" : "DEBIT",
        montant: D.format(D.abs(ecart)),
      });
    }
  }

  console.log(`\n— Reprise de solde (${APPLY ? "APPLIQUÉE" : "simulation"}) —`);
  console.log(`Motif : ${MOTIF}\n`);

  if (!plan.length) {
    console.log("Aucun écart : tous les soldes internes sont adossés au grand livre.");
    await mongoose.disconnect();
    process.exit(0);
  }

  for (const p of plan) {
    console.log(
      `${p.systemType.padEnd(24)} ${p.currency.padEnd(4)} ` +
        `solde=${p.stored.padStart(12)} grand-livre=${p.ledger.padStart(8)} ` +
        `⇒ ${p.sens} ${p.montant}`
    );
  }

  if (!APPLY) {
    console.log("\nRelancer avec --apply pour poser ces écritures.");
    await mongoose.disconnect();
    process.exit(0);
  }

  let posees = 0;
  let deja = 0;

  for (const p of plan) {
    const reference = `OPENING:${p.systemType}:${p.userId}:${p.currency}`;

    const existante = await db.collection("ledgerentries").findOne({ reference });

    if (existante) {
      deja += 1;
      console.log(`  déjà repris : ${reference}`);
      continue;
    }

    const compteTresorerie = treasuryAccountId({
      treasuryUserId: p.userId,
      treasurySystemType: p.systemType,
      currency: p.currency,
    });

    await ledger.postDoubleEntry({
      transactionId: transactionIdFor(reference),
      reference,
      entryType: "OPENING_BALANCE",
      context: "openingBalance",
      dedupScope: reference,
      metadata: {
        motif: MOTIF,
        repriseLe: new Date().toISOString(),
        soldeConstate: p.stored,
        grandLivreAvant: p.ledger,
      },
      legs: [
        {
          accountType: "TREASURY",
          accountId: compteTresorerie,
          userId: p.userId,
          direction: p.sens,
          amount: p.montant,
          currency: p.currency,
        },
        {
          accountType: "SYSTEM_CLEARING",
          accountId: openingBalanceClearingAccountId(p.currency),
          direction: p.sens === "CREDIT" ? "DEBIT" : "CREDIT",
          amount: p.montant,
          currency: p.currency,
        },
      ],
    });

    posees += 1;
    console.log(`  ✅ ${reference} — ${p.sens} ${p.montant} ${p.currency}`);
  }

  console.log(`\n${posees} reprise(s) posée(s), ${deja} déjà présente(s).`);
  console.log("Vérifier : `npm run reconcile:treasuries`.");

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("❌ Reprise interrompue :", err?.message || err);
  process.exit(1);
});
