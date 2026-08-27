#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Pose les index DÉCLARÉS par les schémas — explicitement, quand on le décide.
 *
 * ── Pourquoi ce script existe ─────────────────────────────────────────────
 * `config/db.js` coupe `autoIndex`. Les index ne se créent donc plus au
 * démarrage d'une instance, à un moment et sur une machine que personne n'a
 * choisis. Ce script est le chemin de remplacement : il se lance en heure
 * creuse, on suit la construction, on l'interrompt si elle pèse.
 *
 * Il forme une boucle fermée avec `services/indexAudit.js` :
 *   le démarrage SIGNALE ce qui manque  →  ce script le POSE.
 *
 * ── Ce qu'il ne fait jamais ───────────────────────────────────────────────
 * Il ne SUPPRIME aucun index. Pas d'appel à `syncIndexes()` : cette méthode
 * Mongoose supprime les index absents du schéma, ce qui effacerait sans
 * discussion un index posé délibérément par un DBA, ou un index encore utilisé
 * par une version de l'application toujours déployée. Supprimer un index est
 * une décision distincte, qui se prend index par index — c'est l'objet de
 * `dropRedundantWebhookIndexes.js`, avec ses propres gardes.
 *
 * `createIndex` est idempotent : sur un index déjà présent et identique, il ne
 * fait rien.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   node scripts/ensureIndexes.js              # SIMULATION (défaut)
 *   node scripts/ensureIndexes.js --apply      # pose réellement
 *
 * Le défaut est la simulation, et c'est délibéré : sur une grosse collection,
 * une construction d'index lancée par mégarde se paie en latence de production.
 * Ce qui coûte cher ne doit pas être le comportement par défaut.
 */

const mongoose = require("mongoose");
const config = require("../src/config");
const { comparerIndex, empreinteIndex } = require("../src/services/indexAudit");

const APPLIQUER = process.argv.includes("--apply");

async function main() {
  config.load({ strict: false });

  const uri = config.mongo?.transactions;
  if (!uri) {
    console.error("⛔ MONGO_URI_TRANSACTIONS absent. Rien n'est tenté.");
    process.exit(1);
  }

  const conn = await mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
    autoCreate: false,
  }).asPromise();

  const { registerTransactionModels } = require("../src/config/db");
  registerTransactionModels(conn);

  console.log(
    `\n  Index déclarés — ${APPLIQUER ? "POSE RÉELLE" : "SIMULATION (utiliser --apply pour poser)"}`
  );
  console.log("  " + "─".repeat(60));

  let aPoser = 0;
  let poses = 0;
  let echecs = 0;

  for (const nom of Object.keys(conn.models)) {
    const modele = conn.models[nom];
    const declares = modele.schema.indexes();
    if (!declares.length) continue;

    let reels = [];
    try {
      reels = (await modele.collection.indexes()).map((i) => empreinteIndex(i.key, i));
    } catch {
      // Collection encore inexistante : tous les index sont à poser.
      reels = [];
    }

    const { manquants } = comparerIndex(
      declares.map(([cle, options]) => empreinteIndex(cle, options)),
      reels
    );
    if (!manquants.length) continue;

    console.log(`\n  ${nom} (${modele.collection.collectionName}) — ${manquants.length} à poser`);

    for (const [cle, options] of declares) {
      const empreinte = empreinteIndex(cle, options);
      if (!manquants.includes(empreinte)) continue;

      aPoser += 1;
      const detail = options?.unique ? " [unique]" : options?.expireAfterSeconds ? " [TTL]" : "";
      console.log(`     · ${empreinte}${detail}`);

      if (!APPLIQUER) continue;

      try {
        // `background` n'existe plus depuis MongoDB 4.2 : toute construction
        // est déjà non bloquante côté serveur. Ne pas le repasser.
        await modele.collection.createIndex(cle, { ...options });
        poses += 1;
        console.log("       ✅ posé");
      } catch (err) {
        echecs += 1;
        console.log(`       ⛔ échec : ${err?.message || err}`);
      }
    }
  }

  console.log("\n  " + "─".repeat(60));
  if (!aPoser) {
    console.log("  ✅ Tous les index déclarés sont déjà posés.\n");
  } else if (!APPLIQUER) {
    console.log(`  ${aPoser} index à poser. Relancer avec --apply, en heure creuse.\n`);
  } else {
    console.log(`  ${poses} posé(s), ${echecs} échec(s).\n`);
  }

  await conn.close();
  process.exit(echecs ? 1 : 0);
}

main().catch((err) => {
  console.error(`⛔ ${err?.message || err}`);
  process.exit(1);
});
