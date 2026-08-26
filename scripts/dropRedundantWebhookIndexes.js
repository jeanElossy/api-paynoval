"use strict";

/**
 * ============================================================================
 * RETRAIT DES INDEX REDONDANTS DE `provider_webhook_events`
 * ============================================================================
 *
 * POURQUOI CE SCRIPT EXISTE PLUTÔT QU'UNE COMMANDE JETÉE DANS UN SHELL
 * -------------------------------------------------------------------
 * Supprimer un index est une opération de base irréversible dans l'instant :
 * la reconstruction sur une grosse collection prend du temps, et pendant ce
 * temps les requêtes qui s'appuyaient dessus balaient. Une commande tapée à la
 * main ne laisse ni trace, ni justification, ni moyen de vérifier qu'on a visé
 * juste. Ce fichier porte les trois.
 *
 * CE QU'ON RETIRE, ET POURQUOI C'EST SÛR
 * --------------------------------------
 * **Un index composé sert aussi pour son PRÉFIXE.** `{provider, eventId}`
 * répond à une recherche sur `provider` seul ; `{status, createdAt}` à une
 * recherche sur `status` seul. Les index simples correspondants ne servaient
 * donc jamais — MongoDB choisissait le composé.
 *
 * Ce n'est pas neutre de les garder : chaque index se met à jour à CHAQUE
 * écriture et occupe la mémoire de travail que les index utiles se disputent.
 * Sur cette collection, l'écriture EST le chemin critique — chaque rappel
 * prestataire en produit une.
 *
 *   provider_1              couvert par uniq_webhook_provider_event
 *   status_1                couvert par status_1_createdAt_1
 *   transactionId_1         couvert par transactionId_1_createdAt_-1
 *   transactionReference_1  couvert par transactionReference_1_createdAt_-1
 *
 * ⚠️ CE QU'ON NE RETIRE PAS, ET IL FAUT QUE CE SOIT DIT :
 *   - `rail_1` et `providerReference_1` ne sont préfixes d'AUCUN composé ;
 *   - `uniq_webhook_provider_event` est une CONTRAINTE D'INTÉGRITÉ, pas une
 *     optimisation : c'est elle qui empêche qu'un même rappel soit traité deux
 *     fois, donc qu'un bénéficiaire soit crédité deux fois ;
 *   - `webhook_events_ttl` porte la rétention de 90 jours.
 *
 * Le script REFUSE de toucher à ces quatre-là, même si on le lui demandait :
 * la liste est fermée et vérifiée contre les index réellement présents.
 *
 * ⚠️ LE SCHÉMA A ÉTÉ CORRIGÉ D'ABORD. Tant que `models/ProviderWebhookEvent.js`
 * déclarait `index: true` sur ces champs, Mongoose les recréait au démarrage
 * suivant et le retrait était annulé sans que personne ne le voie. L'ordre est
 * donc : corriger la déclaration, PUIS retirer en base.
 *
 * Usage :
 *   node scripts/dropRedundantWebhookIndexes.js --dry-run   # ce qui serait fait
 *   node scripts/dropRedundantWebhookIndexes.js             # retrait réel
 */

require("dotenv").config();
const mongoose = require("mongoose");

const COLLECTION = "provider_webhook_events";

/** Liste FERMÉE. Chaque entrée nomme le composé qui la rend inutile. */
const REDONDANTS = Object.freeze([
  { nom: "provider_1", couvertPar: "uniq_webhook_provider_event" },
  { nom: "status_1", couvertPar: "status_1_createdAt_1" },
  { nom: "transactionId_1", couvertPar: "transactionId_1_createdAt_-1" },
  { nom: "transactionReference_1", couvertPar: "transactionReference_1_createdAt_-1" },
]);

/** Ne doivent JAMAIS être retirés — vérifié, pas supposé. */
const INTOUCHABLES = Object.freeze([
  "_id_",
  "uniq_webhook_provider_event",
  "webhook_events_ttl",
]);

const DRY_RUN = process.argv.includes("--dry-run");

(async () => {
  const uri = process.env.MONGO_URI_TRANSACTIONS;
  if (!uri) throw new Error("MONGO_URI_TRANSACTIONS manquant");

  const conn = await mongoose.createConnection(uri).asPromise();
  console.log(`\n  Connecté à « ${conn.name} »`);

  const col = conn.collection(COLLECTION);

  let presents;
  try {
    presents = await col.indexes();
  } catch (err) {
    if (/ns does not exist|NamespaceNotFound/i.test(String(err?.message || err))) {
      console.log(`  Collection « ${COLLECTION} » absente — rien à faire.\n`);
      await conn.close();
      process.exit(0);
    }
    throw err;
  }

  const nomsPresents = new Set(presents.map((i) => i.name));

  console.log(`  ${presents.length} index présents · ${await col.countDocuments({})} documents\n`);

  let retires = 0;

  for (const { nom, couvertPar } of REDONDANTS) {
    if (INTOUCHABLES.includes(nom)) {
      // Ceinture et bretelles : la liste est fermée, mais une erreur de saisie
      // sur un index d'intégrité coûterait un double crédit.
      console.log(`  ⛔ ${nom} — INTOUCHABLE, ignoré`);
      continue;
    }

    if (!nomsPresents.has(nom)) {
      console.log(`  ⏭️  ${nom} — déjà absent`);
      continue;
    }

    /**
     * On ne retire un index QUE si celui qui le couvre existe réellement.
     * Retirer `provider_1` alors que le composé n'aurait pas été construit
     * laisserait la collection sans aucun index sur `provider`.
     */
    if (!nomsPresents.has(couvertPar)) {
      console.log(
        `  ⛔ ${nom} — CONSERVÉ : « ${couvertPar} » n'existe pas en base.\n` +
          `       Lancer d'abord scripts/ensure-ledger-indexes.js.`
      );
      continue;
    }

    if (DRY_RUN) {
      console.log(`  (dry-run) ${nom} serait retiré — couvert par ${couvertPar}`);
      continue;
    }

    await col.dropIndex(nom);
    retires += 1;
    console.log(`  ✅ ${nom} retiré — couvert par ${couvertPar}`);
  }

  const restants = await col.indexes();

  console.log(`\n  Index restants (${restants.length}) :`);
  for (const i of restants) {
    const marques = [i.unique ? "UNIQUE" : "", i.expireAfterSeconds ? "TTL" : ""]
      .filter(Boolean)
      .join(" ");
    console.log(`    ${i.name.padEnd(40)} ${JSON.stringify(i.key)} ${marques}`);
  }

  // Contrôle final : les contraintes d'intégrité sont-elles toujours là ?
  const noms = new Set(restants.map((i) => i.name));
  const manquants = INTOUCHABLES.filter((n) => !noms.has(n));

  if (manquants.length) {
    console.error(`\n  ⛔ INDEX D'INTÉGRITÉ MANQUANT : ${manquants.join(", ")}`);
    await conn.close();
    process.exit(1);
  }

  console.log(
    `\n  ${DRY_RUN ? "🔍 Simulation — rien retiré." : `🎉 ${retires} index retiré(s).`}` +
      " Contraintes d'intégrité intactes.\n"
  );

  await conn.close();
  process.exit(0);
})().catch((err) => {
  console.error("\n  💥 Échec :", err.message);
  process.exit(1);
});
