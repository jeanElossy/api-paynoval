// File: scripts/ensure-ledger-indexes.js
/* eslint-disable no-console */
"use strict";

/**
 * Création des index manquants sur `ledgerentries` (base transactions).
 *
 * Pourquoi un script séparé plutôt qu'une déclaration au schéma :
 * `ledgerentries` contient déjà des données de production et `autoIndex` n'est
 * désactivé nulle part. Déclarer ces index dans `models/LedgerEntry.js` les
 * ferait construire automatiquement au prochain démarrage, sans qu'on choisisse
 * ni le moment ni l'instance. Ce script laisse la main : on le lance en heure
 * creuse et on suit la construction.
 *
 * Les index visés sont ceux qu'utilisent les agrégations d'analytique de
 * trésorerie (`internalTreasuryAnalytics.controller.js`), qui filtrent toutes
 * sur `createdAt` — aujourd'hui sans aucun index, donc en balayage complet.
 *
 * Le script est **idempotent** : `createIndex` sur un index déjà présent et
 * identique ne fait rien. Il ne supprime jamais un index existant.
 *
 * Usage :
 *   node scripts/ensure-ledger-indexes.js            # crée les index
 *   node scripts/ensure-ledger-indexes.js --dry-run  # liste sans rien créer
 */

/* `dotenv` simple, et non `dotenv-safe` : ce script n'a besoin que de
   `MONGO_URI_TRANSACTIONS`. `dotenv-safe` exige la présence de TOUTES les
   variables listées dans `.env.example` — lequel est incomplet et diverge du
   `.env` réel — et rendrait le script impossible à lancer. */
require("dotenv").config();
const mongoose = require("mongoose");

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * `background: true` : la construction ne bloque pas les lectures et écritures
 * de la collection. C'est le comportement par défaut depuis MongoDB 4.2, on le
 * précise pour rester explicite sur l'intention.
 */
const INDEXES = [
  {
    collection: "ledgerentries",
    keys: { createdAt: -1 },
    options: { name: "createdAt_-1", background: true },
    why: "pagination du grand livre par date décroissante",
  },
  {
    collection: "ledgerentries",
    keys: { entryType: 1, status: 1, createdAt: -1 },
    options: { name: "entryType_1_status_1_createdAt_-1", background: true },
    why: "sections frais et marge de change (filtre entryType + status)",
  },
  {
    collection: "ledgerentries",
    keys: { currency: 1, createdAt: -1 },
    options: { name: "currency_1_createdAt_-1", background: true },
    why: "séries journalières par devise",
  },
  {
    collection: "transactions",
    keys: { context: 1, status: 1, createdAt: -1 },
    options: { name: "context_1_status_1_createdAt_-1", background: true },
    why: "section parrainage (context: referral_bonus)",
  },
];

async function main() {
  const uri = process.env.MONGO_URI_TRANSACTIONS;
  if (!uri) {
    throw new Error("MONGO_URI_TRANSACTIONS manquant");
  }

  console.log("⏳ Connexion à la base transactions…");
  const conn = await mongoose.createConnection(uri).asPromise();
  console.log(`✅ Connecté à « ${conn.name} »`);

  if (DRY_RUN) {
    console.log("\n🔍 Mode --dry-run : aucune écriture ne sera faite.\n");
  }

  for (const { collection, keys, options, why } of INDEXES) {
    const col = conn.collection(collection);
    const label = `${collection}.${options.name}`;

    // Volume : utile pour anticiper la durée de construction.
    const count = await col.estimatedDocumentCount();

    const existing = await col.indexes();
    const already = existing.some((ix) => ix.name === options.name);

    if (already) {
      console.log(`⏭️  ${label} — déjà présent, rien à faire`);
      continue;
    }

    console.log(`\n🔧 ${label}`);
    console.log(`   raison : ${why}`);
    console.log(`   documents dans la collection : ${count.toLocaleString("fr-FR")}`);

    if (DRY_RUN) {
      console.log("   (dry-run) index NON créé");
      continue;
    }

    const startedAt = Date.now();
    await col.createIndex(keys, options);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`   ✅ créé en ${seconds} s`);
  }

  await conn.close();
  console.log("\n🎉 Terminé");
}

main().catch((err) => {
  console.error("\n💥 Erreur ensure-ledger-indexes:", err.message);
  process.exit(1);
});
