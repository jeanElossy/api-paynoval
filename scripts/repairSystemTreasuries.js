#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * RÉPARATION DU REGISTRE DES COMPTES INTERNES — lecture seule par défaut.
 * -----------------------------------------------------------------------------
 * Mesuré sur les bases -test le 2026-09-22 : `FEES_TREASURY` et
 * `FX_MARGIN_TREASURY` créditées sur des comptes dont le propriétaire n'existe
 * plus (97,91 CAD / 97,78 CAD), deux `OPERATIONS_TREASURY` actives dont une
 * avec 30 000 XOF, et les comptes système officiels vides. Cause :
 * `TxSystemBalance.credit()` créait la trésorerie manquante à partir d'une
 * variable d'environnement périmée (corrigé, création désormais explicite).
 *
 * Ce script RÉTABLIT LE LIEN, il ne déplace JAMAIS d'argent :
 *   RELIER    le compte qui porte l'argent est rattaché au compte système réel
 *             (`userId`/`ownerId` mis à jour, montants inchangés, trace dans
 *             `metadata.ownerRelinks`) ;
 *   ARCHIVER  un doublon VIDE et sans historique part dans
 *             `txsystembalances_archive` ;
 *   CRÉER     un type sans aucun compte est provisionné à zéro ;
 *   BLOQUÉ    deux comptes portant de l'argent : un humain tranche, car les
 *             réunir serait une écriture comptable (invariant 4).
 *
 * Usage :
 *   node scripts/repairSystemTreasuries.js            # diagnostic seul
 *   node scripts/repairSystemTreasuries.js --apply    # applique le plan
 */

require("dotenv").config();

const mongoose = require("mongoose");

const { connectTransactionsDB, getTxConn, getUsersConn } = require("../src/config/db");
const {
  planTreasuryRepair,
  auditTreasuryRegistry,
  TREASURY_SYSTEM_TYPES,
} = require("../src/services/treasuryRegistry");

const APPLY = process.argv.includes("--apply");
const COLLECTION = "txsystembalances";
const ARCHIVE = "txsystembalances_archive";

const envIds = Object.fromEntries(
  TREASURY_SYSTEM_TYPES.map((t) => [t, String(process.env[`${t}_USER_ID`] || "").trim()])
);

const asObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : String(id);

(async () => {
  await connectTransactionsDB();

  const tx = getTxConn().db;
  const users = getUsersConn().db;

  const wallets = await tx.collection(COLLECTION).find({}).toArray();
  const systemUsers = await users
    .collection("users")
    .find({ isSystem: true }, { projection: { systemType: 1, currency: 1, fullName: 1 } })
    .toArray();

  console.log("\n— État du registre —");
  for (const row of auditTreasuryRegistry({ wallets, envIds, systemUsers })) {
    console.log(
      `${row.systemType.padEnd(24)} ${row.status.padEnd(14)} registre=${row.registryId || "—"} env=${row.envId || "—"}`
    );
  }

  const plan = planTreasuryRepair({ wallets, systemUsers });

  console.log(`\n— Plan (${APPLY ? "APPLIQUÉ" : "lecture seule"}) —`);
  for (const step of plan) {
    console.log(`${step.systemType.padEnd(24)} ${step.action}${step.reason ? ` (${step.reason})` : ""}`);
  }

  if (!APPLY) {
    console.log("\nRelancer avec --apply pour appliquer.");
    await mongoose.disconnect();
    process.exit(0);
  }

  const now = new Date();

  for (const step of plan) {
    if (step.action === "RIEN" || step.action === "BLOQUÉ") continue;

    for (const walletId of step.archive || []) {
      const doc = await tx.collection(COLLECTION).findOne({ _id: asObjectId(walletId) });
      if (!doc) continue;

      await tx.collection(ARCHIVE).insertOne({
        ...doc,
        archivedAt: now,
        archiveReason: "Doublon vide — registre des comptes internes (2026-09-22)",
      });

      // Le filtre REPÈTE les conditions du plan : entre la lecture et
      // l'écriture, un crédit a pu arriver sur ce compte.
      const res = await tx.collection(COLLECTION).deleteOne({
        _id: asObjectId(walletId),
        balanceHistory: { $size: 0 },
      });

      console.log(
        res.deletedCount
          ? `  archivé ${step.systemType} ${walletId}`
          : `  ⚠️ ${walletId} a bougé depuis le diagnostic — NON archivé`
      );
    }

    if (step.action === "RELIER") {
      const res = await tx.collection(COLLECTION).updateOne(
        { _id: asObjectId(step.walletId), systemType: step.systemType },
        {
          $set: { userId: asObjectId(step.ownerId), ownerId: asObjectId(step.ownerId), updatedAt: now },
          $push: {
            "metadata.ownerRelinks": {
              at: now,
              from: String(step.fromUserId),
              to: String(step.ownerId),
              reason: "Propriétaire périmé — registre des comptes internes (2026-09-22)",
            },
          },
        }
      );

      console.log(`  relié ${step.systemType} ← ${step.walletId} (${res.modifiedCount})`);
    }

    if (step.action === "CRÉER") {
      const TxSystemBalance = require("../src/models/TxSystemBalance")(getTxConn());

      await TxSystemBalance.ensureSystemWallet(step.ownerId, step.systemType, step.currency, {
        allowCreate: true,
        metadata: { source: "scripts/repairSystemTreasuries" },
      });

      console.log(`  créé ${step.systemType} pour ${step.ownerId} (${step.currency})`);
    }
  }

  const after = await tx.collection(COLLECTION).find({}).toArray();
  console.log("\n— État après réparation —");
  for (const row of auditTreasuryRegistry({ wallets: after, envIds, systemUsers })) {
    console.log(`${row.systemType.padEnd(24)} ${row.status.padEnd(14)} registre=${row.registryId || "—"}`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("❌ Réparation interrompue :", err?.message || err);
  process.exit(1);
});
