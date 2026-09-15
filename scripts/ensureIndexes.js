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
 *   node scripts/ensureIndexes.js                        # SIMULATION (défaut)
 *   node scripts/ensureIndexes.js --apply                # pose TOUT
 *   node scripts/ensureIndexes.js --only=DomainEvent,ProcessedEvent --apply
 *   node scripts/ensureIndexes.js --only=CagnotteSettlement --apply --convert
 *                                                        # + convertit en place un index DIVERGENT
 *
 * Le défaut est la simulation, et c'est délibéré : sur une grosse collection,
 * une construction d'index lancée par mégarde se paie en latence de production.
 * Ce qui coûte cher ne doit pas être le comportement par défaut.
 *
 * ── Pourquoi `--only` existe ──────────────────────────────────────────────
 *
 * L'en-tête de ce script dit « en heure creuse, on suit la construction, on
 * l'interrompt si elle pèse ». Cela suppose de pouvoir poser PAR TRANCHES —
 * or il n'y avait que « tout ou rien », et 56 index à poser au 2026-09-10.
 *
 * Concrètement : quelqu'un qui veut poser les cinq index d'un sous-système
 * qu'il vient d'ajouter n'a pas à décider en même temps du sort de cinquante et
 * un index sur des collections qu'il n'a pas regardées. Un outil qui force à
 * tout faire d'un coup ne se lance pas — et les index restent absents.
 *
 * ⚠️ `--only` FILTRE, il n'INVENTE rien : un nom de modèle inconnu fait échouer
 * le script au lieu de poser zéro index en annonçant un succès.
 */

const mongoose = require("mongoose");
const config = require("../src/config");
const {
  comparerIndex,
  empreinteIndex,
  diagnostiquerDivergence,
  commandesConversion,
} = require("../src/services/indexAudit");

const APPLIQUER = process.argv.includes("--apply");

/**
 * `--convert` : convertit EN PLACE un index de même clé mais d'une autre
 * nature (simple → unique, simple → TTL), par `collMod`. Drapeau à part, car
 * ses deux conséquences ne s'activent pas en posant de simples index : rendre
 * un index TTL PURGE les documents hors rétention, et rendre un index unique
 * échoue s'il existe des doublons.
 */
const CONVERTIR = process.argv.includes("--convert");

/**
 * Un index de même clé existe déjà, d'une autre nature : `createIndex`
 * échouerait sur un message brut du serveur. On ne le tente pas ; on dit ce
 * qu'il faut faire, et on le fait sous `--convert`.
 *
 * @returns {Promise<"converti"|"echec"|"non-traite">}
 */
async function traiterDivergence({ conn, modele, cle, divergence }) {
  const collection = modele.collection.collectionName;

  if (!divergence.conversion) {
    console.log(
      `       ⚠️  divergent — « ${divergence.nomReel} » : ${divergence.raison}. À traiter à la main ; rien n'est tenté.`
    );
    return "non-traite";
  }

  const commandes = commandesConversion(collection, cle, divergence);
  const nature = divergence.conversion === "unique" ? "UNIQUE" : "TTL";
  console.log(`       ⚠️  divergent — « ${divergence.nomReel} » existe, mais pas ${nature}. Conversion en place :`);
  for (const commande of commandes) console.log(`         db.runCommand(${JSON.stringify(commande)})`);

  if (divergence.conversion === "ttl") {
    // Rendre un index TTL purge aussitôt ce qui dépasse la rétention : c'est
    // une suppression de documents, elle se chiffre AVANT d'être décidée.
    const [champ] = Object.keys(cle);
    const seuil = new Date(Date.now() - divergence.expireAfterSeconds * 1000);
    const purges = await modele.collection.countDocuments({ [champ]: { $lt: seuil } });
    console.log(`         ⚠️  purgera ${purges} document(s) antérieur(s) au ${seuil.toISOString()}`);
  }

  if (!APPLIQUER || !CONVERTIR) {
    if (APPLIQUER) console.log("       ⏭️  non converti — relancer avec --apply --convert");
    return "non-traite";
  }

  let etapes = 0;
  try {
    for (const commande of commandes) {
      await conn.db.command(commande);
      etapes += 1;
    }
    console.log("       ✅ converti");
    return "converti";
  } catch (err) {
    console.log(`       ⛔ échec : ${err?.message || err}`);
    if (divergence.conversion === "unique" && etapes === 1) {
      console.log(
        "       ↳ l'index refuse déjà tout NOUVEAU doublon (prepareUnique). Résoudre les doublons existants, puis relancer."
      );
    }
    return "echec";
  }
}

/** `--only=A,B` → Set(["A","B"]) ; absent → `null` (aucun filtre). */
const SEULEMENT = (() => {
  const arg = process.argv.find((a) => a.startsWith("--only="));
  if (!arg) return null;

  const noms = arg
    .slice("--only=".length)
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  if (!noms.length) {
    console.error("⛔ `--only=` est vide. Rien n'est tenté.");
    process.exit(1);
  }

  return new Set(noms);
})();

async function main() {
  config.load({ strict: false });

  if (CONVERTIR && !APPLIQUER) {
    console.error("⛔ `--convert` exige `--apply` : sans lui, rien ne serait écrit. Rien n'est tenté.");
    process.exit(1);
  }

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
  let convertis = 0;
  let nonTraites = 0;

  if (SEULEMENT) {
    /**
     * ⚠️ ON VÉRIFIE QUE CHAQUE NOM DEMANDÉ EXISTE, ET ON S'ARRÊTE SINON.
     *
     * Une faute de frappe — « DomainEvents » au lieu de « DomainEvent » — ferait
     * sinon poser zéro index et afficher « 0 à poser », c'est-à-dire un succès
     * apparent. L'exploitant conclurait que les index sont en place. C'est la
     * classe de panne la plus chère : celle qui a l'air d'avoir marché.
     */
    const connus = new Set(Object.keys(conn.models));
    const inconnus = [...SEULEMENT].filter((n) => !connus.has(n));

    if (inconnus.length) {
      console.error(
        `\n  ⛔ Modèle(s) inconnu(s) : ${inconnus.join(", ")}` +
          `\n     Modèles disponibles : ${[...connus].sort().join(", ")}\n`
      );

      await conn.close();
      process.exit(1);
    }

    console.log(`  Filtre --only : ${[...SEULEMENT].join(", ")}`);
    console.log("  " + "─".repeat(60));
  }

  for (const nom of Object.keys(conn.models)) {
    if (SEULEMENT && !SEULEMENT.has(nom)) continue;

    const modele = conn.models[nom];
    const declares = modele.schema.indexes();
    if (!declares.length) continue;

    let indexReels = [];
    try {
      indexReels = await modele.collection.indexes();
    } catch {
      // Collection encore inexistante : tous les index sont à poser.
      indexReels = [];
    }
    const reels = indexReels.map((i) => empreinteIndex(i.key, i));

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

      const divergence = diagnostiquerDivergence(cle, options, indexReels);
      if (divergence) {
        const issue = await traiterDivergence({ conn, modele, cle, divergence });
        if (issue === "converti") convertis += 1;
        else if (issue === "echec") echecs += 1;
        else nonTraites += 1;
        continue;
      }

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
    console.log("  ✅ Tous les index DÉCLARÉS AU SCHÉMA sont déjà posés.");
  } else if (!APPLIQUER) {
    console.log(
      `  ${aPoser} index à poser, dont ${nonTraites} divergent(s). Relancer avec --apply, en heure creuse` +
        (nonTraites ? " (--convert pour convertir les divergents)." : ".")
    );
  } else {
    console.log(
      `  ${poses} posé(s), ${convertis} converti(s), ${echecs} échec(s), ${nonTraites} divergent(s) non traité(s).`
    );
  }

  /**
   * ⚠️ CE SCRIPT NE COUVRE PAS TOUT, ET LE TAIRE EST PIRE QUE NE RIEN DIRE.
   *
   * Il ne pose que les index DÉCLARÉS AUX SCHÉMAS. HUIT index vivent
   * délibérément hors schéma, dans `ensure-ledger-indexes.js` — quatre sur
   * `ledgerentries`, un sur `transactions`, trois sur
   * `provider_webhook_events` — dont
   * `dedupKey_unique_partial`, l'index UNIQUE qui empêche le double
   * enregistrement d'une écriture au grand livre, et
   * `uniq_webhook_provider_event`, celui qui rend un rappel prestataire
   * idempotent. Ce sont les invariants 3 et 10.
   *
   * Le message « ✅ tous les index sont posés » se lisait donc comme un feu
   * vert général sur une base où l'unicité du grand livre était absente.
   * Constaté le 2026-08-28 sur le banc de charge : après `npm run
   * indexes:apply` sur une base neuve, `ledgerentries` portait 11 index sur
   * 15, et une requête de série journalière triait 59 380 documents en
   * mémoire pour en rendre 20 (101 ms). Une fois l'autre script passé :
   * 20 documents examinés, 10 ms.
   *
   * C'est la faute déjà commise une fois par `indexAudit.empreinteIndex()`
   * (voir A2) : un garde incomplet qui annonce une couverture complète produit
   * exactement la garantie fictive qu'il était censé empêcher.
   */
  console.log(`
  ⚠️ Ce script ne pose QUE les index déclarés aux schémas.
     HUIT index vivent hors schéma — dont l'unicité du grand livre
     (\`dedupKey_unique_partial\`) et celle des rappels prestataires
     (\`uniq_webhook_provider_event\`). Ils se posent par :

         npm run indexes:ledger

     Tant que cette commande n'a pas tourné, la base ne porte pas
     les invariants 3 et 10, quoi que dise la ligne ci-dessus.
`);

  await conn.close();
  // Un divergent laissé en l'état est une garantie déclarée que la base ne
  // porte pas : ce n'est pas un succès.
  process.exit(echecs || (APPLIQUER && nonTraites) ? 1 : 0);
}

main().catch((err) => {
  console.error(`⛔ ${err?.message || err}`);
  process.exit(1);
});
