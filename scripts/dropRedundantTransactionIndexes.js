"use strict";

/**
 * ============================================================================
 * RETRAIT DES 10 INDEX REDONDANTS PAR PRÉFIXE DE `transactions` — A5.3
 * ============================================================================
 *
 * POURQUOI, ET CE QUE ÇA COÛTE DE NE PAS LE FAIRE
 * -----------------------------------------------
 * `transactions` portait **53 index sur la limite MongoDB de 64**, pour
 * 140,5 Mo d'index sur 48,2 Mo de données : l'index pèse trois fois la donnée.
 * Chacun se met à jour à CHAQUE écriture — et sur cette collection, l'écriture
 * est le chemin de l'argent : `initiate` en produit une, et l'utilisateur
 * attend pendant ce temps.
 *
 * Mesuré sur le banc (`docs/load/bench/index-cost.js`, 20 000 insertions,
 * 6 répétitions en ORDRE ALTERNÉ, médiane) :
 *
 *     53 index → 0,210 ms/document
 *     43 index → 0,162 ms/document      soit −23,0 % de coût d'écriture
 *
 * ⚠️ L'ordre alterné n'est pas une coquetterie : une première série, mesurée
 * toujours « tous les index d'abord », donnait un faux −31,4 % — le second
 * essai profitait d'un cache chaud.
 *
 * CE QU'ON RETIRE, ET POURQUOI C'EST SÛR
 * --------------------------------------
 * **Un index composé sert aussi pour son PRÉFIXE.** MongoDB utilise
 * `{ userId: 1, createdAt: -1 }` pour répondre à une recherche sur `userId`
 * seul. L'index simple `{ userId: 1 }` ne sert donc jamais : il est payé à
 * chaque écriture et n'est lu par personne.
 *
 * Les dix, avec le composé qui les couvre — la première clé du composé EST le
 * champ, c'est la seule condition qui rende le retrait sûr :
 *
 *   userId_1                  ← userId_1_createdAt_-1
 *   flow_1                    ← flow_1_status_1_createdAt_-1
 *   sender_1                  ← sender_1_createdAt_-1
 *   receiver_1                ← receiver_1_createdAt_-1
 *   provider_1                ← provider_1_providerStatus_1_createdAt_-1
 *   status_1                  ← status_1_createdAt_-1
 *   archived_1                ← archived_1_createdAt_-1
 *   context_1                 ← context_1_status_1_createdAt_-1
 *   treasuryRevenueCredited_1 ← treasuryRevenueCredited_1_createdAt_-1
 *   treasuryUserId_1          ← treasuryUserId_1_treasurySystemType_1_createdAt_-1
 *
 * ⚠️ CE QU'ON NE RETIRE PAS, ET IL FAUT QUE CE SOIT DIT
 * -----------------------------------------------------
 * Aucun index UNIQUE, aucun index PARTIEL, aucun TTL. Ce sont des CONTRAINTES
 * D'INTÉGRITÉ ou des politiques de rétention, pas des optimisations : retirer
 * l'un d'eux ne rendrait pas une requête lente, il rendrait un double paiement
 * possible. Le script REFUSE d'y toucher, et le vérifie CONTRE LA BASE — pas
 * contre une liste écrite ici — avant chaque suppression.
 *
 * ⚠️ LE SCHÉMA A ÉTÉ CORRIGÉ D'ABORD, ET L'ORDRE N'EST PAS NÉGOCIABLE.
 * Tant que `models/Transaction.js` déclarait `index: true` sur ces dix champs,
 * le prochain `npm run indexes:apply` les recréait et le retrait était annulé
 * sans que personne ne le voie. Ce script REFUSE DE TOURNER si la déclaration
 * est encore là.
 *
 * Usage :
 *   node scripts/dropRedundantTransactionIndexes.js            # SIMULATION
 *   node scripts/dropRedundantTransactionIndexes.js --apply    # retrait réel
 *
 * Le défaut est la simulation — comme `ensureIndexes.js`, et pour la même
 * raison : ce qui touche une base financière ne doit pas être le comportement
 * par défaut d'une commande tapée trop vite.
 */

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const config = require("../src/config");

const COLLECTION = "transactions";

/** Liste FERMÉE. Chaque entrée nomme le composé qui la rend inutile. */
const REDONDANTS = Object.freeze([
  { nom: "userId_1", champ: "userId", couvertPar: "userId_1_createdAt_-1" },
  { nom: "flow_1", champ: "flow", couvertPar: "flow_1_status_1_createdAt_-1" },
  { nom: "sender_1", champ: "sender", couvertPar: "sender_1_createdAt_-1" },
  { nom: "receiver_1", champ: "receiver", couvertPar: "receiver_1_createdAt_-1" },
  {
    nom: "provider_1",
    champ: "provider",
    couvertPar: "provider_1_providerStatus_1_createdAt_-1",
  },
  { nom: "status_1", champ: "status", couvertPar: "status_1_createdAt_-1" },
  { nom: "archived_1", champ: "archived", couvertPar: "archived_1_createdAt_-1" },
  { nom: "context_1", champ: "context", couvertPar: "context_1_status_1_createdAt_-1" },
  {
    nom: "treasuryRevenueCredited_1",
    champ: "treasuryRevenueCredited",
    couvertPar: "treasuryRevenueCredited_1_createdAt_-1",
  },
  {
    nom: "treasuryUserId_1",
    champ: "treasuryUserId",
    couvertPar: "treasuryUserId_1_treasurySystemType_1_createdAt_-1",
  },
]);

const APPLIQUER = process.argv.includes("--apply");

/**
 * Le composé couvre-t-il VRAIMENT le simple ?
 *
 * ⚠️ ON NE SE FIE PAS AU NOM. `sender_1_idempotencyKey_1` et
 * `userId_1_reference_1` portent eux aussi le champ en tête ; il suffirait
 * d'une faute de frappe dans la liste ci-dessus pour viser un composé qui ne
 * couvre pas. On lit donc la CLÉ RÉELLE en base et on vérifie que le champ est
 * bien la PREMIÈRE, ce qui est l'unique condition du préfixe.
 */
function couvertureReelle(indexCompose, champ) {
  const cles = Object.keys(indexCompose.key || {});
  return cles.length > 1 && cles[0] === champ;
}

/**
 * Un index d'intégrité ou de rétention ne se retire pas, jamais.
 * Vérifié sur le document d'index LU EN BASE, pas sur une liste écrite ici.
 */
function estIntouchable(index) {
  return Boolean(
    index.name === "_id_" ||
      index.unique ||
      index.partialFilterExpression ||
      index.expireAfterSeconds !== undefined
  );
}

/**
 * GARDE D'ORDRE : le schéma ne doit plus déclarer ces index.
 *
 * Sans elle, ce script « réussit » et le prochain démarrage ou
 * `npm run indexes:apply` recrée tout — un retrait qui s'annule tout seul est
 * pire que pas de retrait : on croit l'avoir fait.
 */
function schemaEncoreFautif() {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "models", "Transaction.js"),
    "utf8"
  );

  const lignes = src.split("\n");
  const fautifs = [];

  for (const { champ } of REDONDANTS) {
    // On cherche `champ: {` puis un `index: true` avant la fermeture du bloc.
    const debut = lignes.findIndex((l) => new RegExp(`^\\s{4}${champ}:\\s*\\{`).test(l));
    if (debut === -1) continue;

    for (let i = debut; i < Math.min(lignes.length, debut + 40); i += 1) {
      if (/^\s{4}\},?\s*$/.test(lignes[i]) && i > debut) break;
      if (/^\s*index:\s*true,?\s*$/.test(lignes[i])) {
        fautifs.push(`${champ} (ligne ${i + 1})`);
        break;
      }
    }
  }

  return fautifs;
}

async function main() {
  const fautifs = schemaEncoreFautif();

  if (fautifs.length) {
    console.error(
      `\n  ⛔ REFUS — le schéma déclare encore \`index: true\` sur : ${fautifs.join(", ")}.\n` +
        `     Les retirer en base maintenant serait ANNULÉ au prochain\n` +
        `     \`npm run indexes:apply\`, sans le moindre message.\n` +
        `     Corriger \`src/models/Transaction.js\` d'abord.\n`
    );
    process.exit(1);
  }

  config.load({ strict: false });

  const uri = config.mongo?.transactions;
  if (!uri) {
    console.error("  ⛔ MONGO_URI_TRANSACTIONS absent. Rien n'est tenté.");
    process.exit(1);
  }

  const conn = await mongoose
    .createConnection(uri, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false })
    .asPromise();

  console.log(`\n  Connecté à « ${conn.name} » — ${APPLIQUER ? "RETRAIT RÉEL" : "SIMULATION (--apply pour retirer)"}`);

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

  const parNom = new Map(presents.map((i) => [i.name, i]));

  console.log(`  ${presents.length} index présents · ${await col.estimatedDocumentCount()} documents\n`);

  let retires = 0;
  let conserves = 0;

  for (const { nom, champ, couvertPar } of REDONDANTS) {
    const simple = parNom.get(nom);

    if (!simple) {
      console.log(`  ⏭️  ${nom.padEnd(28)} déjà absent`);
      continue;
    }

    if (estIntouchable(simple)) {
      console.log(
        `  ⛔ ${nom.padEnd(28)} CONSERVÉ : contrainte d'intégrité ou rétention (lu en base)`
      );
      conserves += 1;
      continue;
    }

    const compose = parNom.get(couvertPar);

    if (!compose) {
      console.log(
        `  ⛔ ${nom.padEnd(28)} CONSERVÉ : « ${couvertPar} » n'existe pas en base.\n` +
          `     Lancer d'abord \`npm run indexes:apply\`.`
      );
      conserves += 1;
      continue;
    }

    if (!couvertureReelle(compose, champ)) {
      console.log(
        `  ⛔ ${nom.padEnd(28)} CONSERVÉ : « ${couvertPar} » ne commence PAS par \`${champ}\`\n` +
          `     (clé réelle : ${JSON.stringify(compose.key)}). Il ne le couvre donc pas.`
      );
      conserves += 1;
      continue;
    }

    if (!APPLIQUER) {
      console.log(`  (simulation) ${nom.padEnd(28)} serait retiré — couvert par ${couvertPar}`);
      continue;
    }

    await col.dropIndex(nom);
    retires += 1;
    console.log(`  ✅ ${nom.padEnd(28)} retiré — couvert par ${couvertPar}`);
  }

  const restants = await col.indexes();

  /**
   * CONTRÔLE FINAL : aucune contrainte d'intégrité n'a disparu.
   *
   * On compare les index UNIQUES / PARTIELS / TTL d'avant et d'après. Un écart
   * fait sortir en échec : c'est le filet qui manquait à toute suppression
   * d'index faite à la main.
   */
  const empreinte = (liste) =>
    liste
      .filter(estIntouchable)
      .map((i) => i.name)
      .sort()
      .join(",");

  if (empreinte(presents) !== empreinte(restants)) {
    console.error(
      `\n  ⛔ UNE CONTRAINTE D'INTÉGRITÉ A DISPARU.\n` +
        `     avant : ${empreinte(presents)}\n` +
        `     après : ${empreinte(restants)}\n`
    );
    await conn.close();
    process.exit(1);
  }

  console.log(
    `\n  ${presents.length} → ${restants.length} index` +
      (APPLIQUER ? ` · ${retires} retiré(s), ${conserves} conservé(s)` : " (simulation)") +
      `\n  Contraintes d'intégrité intactes : ${restants.filter(estIntouchable).length} (inchangé).\n`
  );

  await conn.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n  💥 Échec : ${err?.message || err}`);
  process.exit(1);
});
