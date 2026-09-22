#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * FUSION DE DEUX COMPTES D'UN MÊME RÔLE — simulation par défaut.
 * -----------------------------------------------------------------------------
 * Mesuré le 2026-09-22 : `CAGNOTTE_FEES_TREASURY` portait DEUX comptes actifs
 * détenant chacun de l'argent (16,15 CAD sur le compte officiel, 176 XOF sur un
 * compte dont le propriétaire n'existe plus). `repairSystemTreasuries` refuse ce
 * cas, et il a raison : réunir deux soldes DÉPLACE de l'argent.
 *
 * Ce script le déplace comme une banque le ferait — par une écriture, jamais par
 * une réécriture :
 *
 *     DEBIT   treasury:<TYPE>:<ancien>:<DEVISE>    solde de l'ancien
 *     CREDIT  treasury:<TYPE>:<officiel>:<DEVISE>  même montant   (SYSTEM_TRANSFER)
 *
 * puis les soldes suivent l'écriture, et l'ancien compte — vidé — est ARCHIVÉ
 * (`isActive: false`). Il reste en base : son historique est une preuve, pas un
 * encombrement. Une fusion erronée se reprend par contre-écriture (invariant 4).
 *
 * ⚠️ À lancer APRÈS `treasuries:opening-balances`, pour que les deux comptes
 * soient déjà adossés au grand livre — sinon le transfert creuserait un écart.
 *
 * Usage :
 *   node scripts/mergeDuplicateTreasuries.js                  # simulation
 *   node scripts/mergeDuplicateTreasuries.js --apply
 *   node scripts/mergeDuplicateTreasuries.js --apply --motif "…"
 */

require("dotenv").config();

const crypto = require("crypto");
const mongoose = require("mongoose");

const { connectTransactionsDB, getTxConn, getUsersConn } = require("../src/config/db");
const { planTreasuryMerge } = require("../src/services/treasuryRegistry");
const { treasuryAccountId } = require("../src/services/ledger/doubleEntry");
const { toDecimal128 } = require("../src/services/ledger/systemBalanceAmounts");

const APPLY = process.argv.includes("--apply");

const MOTIF =
  (() => {
    const i = process.argv.indexOf("--motif");
    return i >= 0 ? String(process.argv[i + 1] || "").trim() : "";
  })() ||
  "Fusion de deux comptes internes du même rôle : l'ancien compte est vidé puis archivé";

function transactionIdFor(reference) {
  return new mongoose.Types.ObjectId(
    crypto.createHash("md5").update(reference).digest("hex").slice(0, 24)
  );
}

(async () => {
  await connectTransactionsDB();

  const conn = getTxConn();
  const db = conn.db;
  const ledger = require("../src/services/ledgerService");

  const wallets = await db.collection("txsystembalances").find({}).toArray();
  const systemUsers = await getUsersConn()
    .db.collection("users")
    .find({ isSystem: true }, { projection: { systemType: 1 } })
    .toArray();

  const plans = planTreasuryMerge({ wallets, systemUsers });

  console.log(`\n— Fusion des comptes internes (${APPLY ? "APPLIQUÉE" : "simulation"}) —`);
  console.log(`Motif : ${MOTIF}\n`);

  if (!plans.length) {
    console.log("Aucun doublon actif : rien à fusionner.");
    await mongoose.disconnect();
    process.exit(0);
  }

  for (const p of plans) {
    if (p.action !== "FUSIONNER") {
      console.log(`${p.systemType.padEnd(24)} ${p.action} (${p.reason})`);
      continue;
    }

    const contenu = p.devises.length
      ? p.devises.map((d) => `${d.amount} ${d.currency}`).join(", ")
      : "(vide)";

    console.log(
      `${p.systemType.padEnd(24)} ${p.sourceUserId.slice(-6)} → ${p.targetUserId.slice(-6)} : ${contenu}`
    );
  }

  if (!APPLY) {
    console.log("\nRelancer avec --apply pour poser les écritures et archiver.");
    await mongoose.disconnect();
    process.exit(0);
  }

  for (const p of plans) {
    if (p.action !== "FUSIONNER") continue;

    for (const d of p.devises) {
      const reference = `MERGE:${p.systemType}:${p.sourceUserId}->${p.targetUserId}:${d.currency}`;

      if (await db.collection("ledgerentries").findOne({ reference })) {
        console.log(`  déjà fusionné : ${reference}`);
        continue;
      }

      await ledger.postDoubleEntry({
        transactionId: transactionIdFor(reference),
        reference,
        entryType: "SYSTEM_TRANSFER",
        context: "mergeTreasuries",
        dedupScope: reference,
        metadata: { motif: MOTIF, fusionLe: new Date().toISOString() },
        legs: [
          {
            accountType: "TREASURY",
            accountId: treasuryAccountId({
              treasuryUserId: p.sourceUserId,
              treasurySystemType: p.systemType,
              currency: d.currency,
            }),
            userId: p.sourceUserId,
            direction: "DEBIT",
            amount: d.amount,
            currency: d.currency,
          },
          {
            accountType: "TREASURY",
            accountId: treasuryAccountId({
              treasuryUserId: p.targetUserId,
              treasurySystemType: p.systemType,
              currency: d.currency,
            }),
            userId: p.targetUserId,
            direction: "CREDIT",
            amount: d.amount,
            currency: d.currency,
          },
        ],
      });

      // Les soldes SUIVENT l'écriture. Le filtre répète le montant attendu :
      // si le compte a bougé depuis le diagnostic, rien n'est écrit.
      const montant = toDecimal128(d.amount, d.currency);

      const vide = await db.collection("txsystembalances").updateOne(
        { _id: new mongoose.Types.ObjectId(p.sourceWalletId), [`balances.${d.currency}`]: montant },
        { $set: { [`balances.${d.currency}`]: toDecimal128(0, d.currency), updatedAt: new Date() } }
      );

      if (!vide.modifiedCount) {
        console.log(`  ⚠️  ${reference} : le solde source a changé depuis le diagnostic — NON vidé`);
        continue;
      }

      await db.collection("txsystembalances").updateOne(
        { _id: new mongoose.Types.ObjectId(p.targetWalletId) },
        { $inc: { [`balances.${d.currency}`]: montant }, $set: { updatedAt: new Date() } }
      );

      console.log(`  ✅ ${d.amount} ${d.currency} transféré (${reference})`);
    }

    const restant = await db
      .collection("txsystembalances")
      .findOne({ _id: new mongoose.Types.ObjectId(p.sourceWalletId) });

    const encorePlein = Object.values(restant?.balances || {}).some(
      (v) => Number(String(v)) !== 0
    );

    if (encorePlein) {
      console.log(`  ⚠️  ${p.systemType} : compte source non vide — NON archivé`);
      continue;
    }

    await db.collection("txsystembalances").updateOne(
      { _id: new mongoose.Types.ObjectId(p.sourceWalletId) },
      {
        $set: {
          isActive: false,
          archivedAt: new Date(),
          archiveReason: MOTIF,
          updatedAt: new Date(),
        },
      }
    );

    console.log(`  📦 compte source archivé (${p.sourceWalletId})`);
  }

  console.log("\nVérifier : `npm run reconcile:treasuries`.");

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("❌ Fusion interrompue :", err?.message || err);
  process.exit(1);
});
