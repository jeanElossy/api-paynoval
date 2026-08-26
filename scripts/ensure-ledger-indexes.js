// File: scripts/ensure-ledger-indexes.js
/* eslint-disable no-console */
"use strict";

/**
 * Création des index DÉLIBÉRÉS de la base transactions.
 *
 * Le nom du fichier dit « ledger » pour raisons historiques : la liste couvre
 * aussi `transactions` et `provider_webhook_events`. Ce qui les réunit n'est pas
 * la collection, c'est le principe — aucun index de cette base ne se crée tout
 * seul au démarrage, sur une instance et à un moment que personne n'a choisis.
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

  /**
   * ═══ LE SEUL INDEX DE CETTE LISTE QUI NE SERT PAS À LIRE PLUS VITE ═══════
   *
   * C'est une CONTRAINTE D'INTÉGRITÉ, pas une optimisation. Elle remplace la
   * transaction MongoDB quand celle-ci n'est pas disponible (mode dégradé,
   * cluster sans jeu de réplicas) : sans elle, un rejeu écrit le même mouvement
   * deux fois — et comme les DEUX jambes sont doublées, le grand livre reste
   * équilibré. La balance de vérification ne signale rien, alors que le solde
   * comptable du compte vaut le double du vrai. C'est le seul défaut du grand
   * livre qu'aucun de nos autres contrôles ne peut détecter.
   *
   * `partialFilterExpression` est la condition de sûreté, pas une finesse :
   *
   *   - l'index ne couvre que les documents portant réellement une chaîne dans
   *     `dedupKey`. Tout l'historique en est dépourvu, donc la construction ne
   *     voit AUCUN document et se termine instantanément — elle ne peut pas
   *     échouer sur des doublons hérités ;
   *   - les écritures posées sans portée de déduplication (remboursements,
   *     lignes de revenu — voir `services/ledgerService.js`) restent permises.
   *     Un index unique simple les refuserait à partir de la deuxième.
   *
   * ⚠️ À CRÉER AVANT (ou avec) le déploiement qui commence à écrire `dedupKey`.
   * Dans l'autre sens, un doublon écrit entre les deux ferait échouer la
   * construction — et la protection manquerait précisément parce qu'elle a
   * déjà été prise en défaut.
   */
  {
    collection: "ledgerentries",
    keys: { dedupKey: 1 },
    options: {
      name: "dedupKey_unique_partial",
      unique: true,
      partialFilterExpression: { dedupKey: { $type: "string" } },
      background: true,
    },
    why: "déduplication des écritures : empêche le double enregistrement d'un même mouvement en mode dégradé",
  },

  /**
   * ═══ SECOND INDEX D'INTÉGRITÉ DE CETTE LISTE ═══════════════════════════
   *
   * Comme `dedupKey_unique_partial`, ce n'est pas une optimisation : c'est LA
   * garantie qu'un même rappel prestataire ne sera pas traité deux fois. Le
   * rejeu est le comportement normal d'un prestataire de paiement, et un
   * « paiement confirmé » traité deux fois crédite le bénéficiaire deux fois.
   *
   * La clé porte le PRESTATAIRE : deux prestataires peuvent parfaitement
   * émettre le même identifiant d'événement, et les confondre ferait ignorer un
   * règlement réel.
   *
   * Le modèle le déclare aussi. Il est repris ici parce que la déclaration
   * seule ne suffit pas — c'est la leçon du 2026-08-19, où onze index déclarés
   * n'existaient pas en base.
   */
  {
    collection: "provider_webhook_events",
    keys: { provider: 1, eventId: 1 },
    options: { name: "uniq_webhook_provider_event", unique: true, background: true },
    why: "idempotence des rappels prestataire : empêche le double traitement d'un même événement",
  },

  /**
   * ═══ RÉCONCILIATION CONTRE LE PRESTATAIRE (F.3) ════════════════════════
   *
   * Ces deux-là ne sont pas des contraintes : ce sont les deux chemins par
   * lesquels la réconciliation rattache un rappel à une transaction. Les
   * prestataires ne renvoient pas tous la même chose — certains ne connaissent
   * que notre référence, d'autres ne renvoient que l'identifiant technique
   * qu'on leur a passé en métadonnée.
   *
   * Sans eux, `checkSettlementTimeouts` balaie `provider_webhook_events` en
   * entier à chaque transaction en attente. Le balayage tourne une fois par
   * jour sur la base qui porte l'argent : c'est précisément le moment où on ne
   * veut pas de lecture complète de collection.
   */
  {
    collection: "provider_webhook_events",
    keys: { transactionReference: 1, createdAt: -1 },
    options: { name: "transactionReference_1_createdAt_-1", background: true },
    why: "réconciliation : retrouver les rappels d'une transaction par sa référence",
  },
  {
    collection: "provider_webhook_events",
    keys: { transactionId: 1, createdAt: -1 },
    options: { name: "transactionId_1_createdAt_-1", sparse: true, background: true },
    why: "réconciliation : rattachement par identifiant technique, quand le prestataire ne renvoie pas la référence",
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

    /**
     * ⚠️ `indexes()` LÈVE SUR UNE COLLECTION QUI N'EXISTE PAS ENCORE.
     *
     * MongoDB répond « ns does not exist », et le script s'arrêtait net — donc
     * les index déclarés APRÈS celui-là n'étaient jamais créés non plus. Le cas
     * se présente à chaque nouvelle collection, c'est-à-dire précisément quand
     * on a le plus besoin que le script fonctionne.
     *
     * Une collection absente n'a évidemment aucun index : on continue, et
     * `createIndex` la créera au passage.
     */
    let existing = [];
    try {
      existing = await col.indexes();
    } catch (err) {
      if (!/ns does not exist|NamespaceNotFound/i.test(String(err?.message || err))) {
        throw err;
      }
      console.log(`   (collection « ${collection} » encore absente — elle sera créée)`);
    }

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
