"use strict";

const mongoose = require("mongoose");
const config = require("../config");

let txConn = null;
let pricingConn = null;

function buildMongooseOpts() {
  return {
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 8000),
    connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 8000),
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 45000),

    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 15),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 0),

    heartbeatFrequencyMS: Number(process.env.MONGO_HEARTBEAT_MS || 10000),
    retryWrites: true,

    /**
     * ⚠️ AUCUN INDEX NE SE CRÉE AU DÉMARRAGE. Ces deux lignes valent une
     * politique, pas une optimisation.
     *
     * Mongoose vaut `autoIndex: true` par défaut. Tant que ce défaut tenait,
     * CHAQUE démarrage d'une instance lançait un `createIndexes` sur les dix
     * modèles de cette connexion — donc sur Atlas, en production, à un moment
     * et sur une instance que personne n'avait choisis. Trois conséquences :
     *
     *   1. une déclaration d'index égarée dans un schéma partait en production
     *      sans revue, au premier redéploiement ;
     *   2. sur une grosse collection, la construction est une opération lourde
     *      déclenchée au pire moment — le démarrage, quand l'instance doit
     *      justement se rendre disponible ;
     *   3. `scripts/ensure-ledger-indexes.js` avait dû être écrit POUR
     *      contourner ce défaut (son en-tête le dit : « autoIndex n'est
     *      désactivé nulle part »). Le contournement devient inutile : c'est
     *      maintenant la règle générale.
     *
     * `autoCreate: false` ferme la même porte pour la CRÉATION DE COLLECTION :
     * sans lui, une faute de frappe sur un nom de modèle fabrique une
     * collection vide en production au lieu d'échouer bruyamment.
     *
     * Les index se posent désormais par script explicite, en heure creuse, et
     * `services/indexAudit.js` signale au démarrage tout index déclaré mais
     * absent — un manque doit crier, pas se rattraper en douce.
     */
    autoIndex: false,
    autoCreate: false,
  };
}

function attachConnLogs(conn, name = "mongo") {
  if (!conn || conn.__paynovalLogsAttached) return;

  conn.__paynovalLogsAttached = true;

  conn.on("connected", () => {
    console.log(`✅ [DB:${name}] connected → ${conn.name || "unknown"}`);
  });

  conn.on("error", (err) => {
    console.error(`❌ [DB:${name}] error:`, err?.message || err);
  });

  conn.on("disconnected", () => {
    console.warn(`⚠️ [DB:${name}] disconnected`);
  });

  conn.on("reconnected", () => {
    console.log(`🔁 [DB:${name}] reconnected`);
  });
}

/**
 * Instrumente le pool de connexions d'une connexion Mongoose (§41).
 *
 * ⚠️ APPELÉ APRÈS LA CONNEXION, JAMAIS AVANT : `conn.getClient()` rend
 * `undefined` tant que le pilote n'a pas construit son `MongoClient`, et
 * s'abonner à rien produirait des jauges plates qu'on prendrait pour un pool au
 * repos. `trackPool` le dit explicitement si le client manque.
 *
 * Les deux connexions partagent souvent le même client (`useDb`) : `trackPool`
 * dédoublonne par identité de client, sinon chaque événement serait compté deux
 * fois.
 */
function attachPoolMetrics(conn, name) {
  try {
    require("../services/mongoPoolMetrics").trackPool(conn?.getClient?.(), name, {
      logger: console,
    });
  } catch (err) {
    // Une métrique ne doit jamais empêcher une connexion à la base.
    console.warn(
      `⚠️ [metrics] pool Mongo « ${name} » non instrumenté : ${err?.message || err}`
    );
  }
}

function registerUsersModels(conn) {
  require("../models/User")(conn);
  require("../models/Device")(conn);
}

function registerTransactionModels(conn) {
  require("../models/User")(conn);
  require("../models/Transaction")(conn);
  require("../models/Outbox")(conn);
  require("../models/Notification")(conn);
  require("../models/LedgerEntry")(conn);
  require("../models/TxWalletBalance")(conn);
  require("../models/ReferralPayout")(conn);
  require("../models/ReferralClawback")(conn);
  require("../models/IdempotencyRecord")(conn);

  /**
   * ⚠️ LE BUS D'ÉVÉNEMENTS VIT DANS LA BASE DES TRANSACTIONS, ET C'EST LA
   * CONDITION DE SA CORRECTION.
   *
   * `domain_events` est écrit DANS la transaction qui change l'état. Le placer
   * ailleurs — par exemple à côté de `outboxes`, dans la base des utilisateurs —
   * ne donnerait l'atomicité que tant que les deux connexions partagent leur
   * `MongoClient`. C'est vrai aujourd'hui ; ce n'est pas une garantie, et le
   * motif « outbox transactionnel » ne vaut que par sa garantie.
   *
   * `processed_events` l'accompagne : le dédoublonnage des consommateurs se lit
   * et s'écrit à chaque message, il n'a rien à faire à un aller-retour de plus.
   */
  require("../models/DomainEvent")(conn);
  require("../models/ProcessedEvent")(conn);

  /**
   * La confiance d'un numéro de dépôt AUTORISE un encaissement : elle vit avec
   * les transactions qu'elle conditionne, pas dans la base des utilisateurs.
   * C'est l'erreur qu'`AMLLog` a commise — déclaré en `mongoose.model()`
   * global, il atterrit loin des transactions qu'il décrit, et le rattraper
   * demandera une migration.
   */
  require("../models/TrustedDepositNumber")(conn);

  /**
   * ⚠️ ENREGISTRÉS ICI PARCE QUE L'ENREGISTREMENT PARESSEUX EST UNE BOMBE À
   * RETARDEMENT D'ORDRE DE DÉMARRAGE.
   *
   * `ProviderWebhookEvent` n'était résolu que par `webhookEventStore`, au
   * PREMIER rappel prestataire reçu. Tant qu'aucun n'était arrivé, le modèle
   * n'existait pas sur la connexion — et la réconciliation, qui le cherche par
   * `conn.models`, échouait sur « Modèle non enregistré ».
   *
   * Le défaut ne se voyait pas en développement (on reçoit un webhook avant de
   * réconcilier) et se serait manifesté en production sur une instance
   * fraîchement redémarrée : le balayage nocturne aurait planté, et — le worker
   * enregistrant les échecs — on l'aurait su. Mais sur une instance qui reçoit
   * les webhooks, il serait passé : donc un contrôle qui marche ou pas selon
   * l'instance qui gagne le verrou. C'est exactement le genre de dépendance
   * implicite qui rend un système imprévisible.
   *
   * Les modèles de la base transactions se déclarent au même endroit. Pas
   * d'exception.
   */
  require("../models/ProviderWebhookEvent")(conn);
  require("../models/ReconciliationRun")(conn);
  require("../models/CronLock")(conn);

  /**
   * Règlement d'une participation à une cagnotte par LIEN PUBLIC (payeur sans
   * compte). Déclaré ici comme les autres, et pour la même raison : un modèle
   * résolu paresseusement n'existe que si un premier appel l'a créé, et la
   * réconciliation — qui le cherche par `conn.models` — échouerait sur les
   * instances qui n'en ont jamais reçu. Un contrôle qui marche ou pas selon
   * l'instance qui gagne le verrou n'est pas un contrôle.
   */
  require("../models/CagnotteExternalSettlement")(conn);

  /**
   * Le reste du domaine cagnotte, pour la même raison. Les trois règlements
   * historiques n'étaient résolus qu'au premier appel — donc absents de
   * l'audit et de la pose d'index sur une instance fraîche. La position du
   * coffre porte l'index unique qui empêche deux positions pour un même coffre :
   * elle ne peut pas dépendre de l'ordre d'arrivée des requêtes.
   */
  require("../models/CagnotteSettlement")(conn);
  require("../models/CagnotteVaultWithdrawalSettlement")(conn);
  require("../models/CagnotteVaultPosition")(conn);
  require("../models/CagnotteQuote")(conn);
  require("../models/CagnotteRefundSettlement")(conn);

  /**
   * Intention d'encaissement — l'argent qui ENTRE. Même raison d'être déclarée
   * ici : le rapprochement prestataire la cherche par `conn.models`, et une
   * instance qui n'a encore reçu aucun encaissement ne l'aurait pas.
   */
  require("../models/CollectionIntent")(conn);

  /**
   * ⚠️ Ces deux modèles étaient chargés dans des `try {} catch {}` VIDES.
   * Corrigé le 2026-09-02.
   *
   * `TxSystemBalance` existe : son `require` est désormais direct, comme les
   * autres. S'il casse un jour, on veut que le démarrage le dise — un modèle
   * absent doit crier, pas disparaître (règle B.1).
   *
   * `TreasuryLedgerEntry` a été RETIRÉ : `src/models/TreasuryLedgerEntry.js`
   * n'existe pas. Son `require` échouait donc à CHAQUE démarrage, et le
   * `catch {}` rendait cet échec parfaitement silencieux.
   *
   * Pourquoi cela comptait : cette fonction est exportée (voir plus bas)
   * précisément pour donner à `scripts/ensureIndexes.js` et à
   * `services/indexAudit.js` la liste EXACTE des modèles portés par la
   * connexion transactions. Un modèle qui disparaît en silence de cette liste
   * disparaît aussi de l'audit d'index et de la pose d'index — c'est-à-dire du
   * seul filet qui reste depuis `autoIndex: false`.
   *
   * Si un jour `TreasuryLedgerEntry` est créé, sa ligne se rajoute ici comme
   * les autres : un `require` nu, sans filet.
   */
  require("../models/TxSystemBalance")(conn);
}

/**
 * ============================================================================
 * MODÈLES DE LA BASE TARIFICATION
 * ============================================================================
 *
 * Les huit modèles du domaine des prix, déplacés depuis l'API Gateway le
 * 2026-09-10. Déclarés ICI et non paresseusement, pour la même raison que les
 * modèles de la base transactions : un modèle résolu au premier appel n'existe
 * pas sur les instances qui n'ont encore servi aucun devis, et tout ce qui le
 * cherche par `conn.models` — audit d'index, pose d'index, rapprochement —
 * échoue alors sur « modèle non enregistré », de façon imprévisible d'une
 * instance à l'autre.
 */
function registerPricingModels(conn) {
  require("../models/pricing/PricingRule")(conn);
  require("../models/pricing/PricingRuleVersion")(conn);
  require("../models/pricing/PricingQuote")(conn);
  require("../models/pricing/PricingCoverageGap")(conn);
  require("../models/pricing/PricingChangeRequest")(conn);
  require("../models/pricing/Fee")(conn);
  require("../models/pricing/FxRule")(conn);
  require("../models/pricing/ExchangeRate")(conn);
}

async function connectUsersDB(uriUsers, opts) {
  if (mongoose.connection.readyState === 1) {
    console.log(`ℹ️ DB Users déjà connectée : ${mongoose.connection.name}`);
    registerUsersModels(mongoose.connection);
    return mongoose.connection;
  }

  if (mongoose.connection.readyState === 2) {
    console.log("ℹ️ DB Users connexion en cours...");
    await mongoose.connection.asPromise();
    registerUsersModels(mongoose.connection);
    return mongoose.connection;
  }

  attachConnLogs(mongoose.connection, "users-main");

  await mongoose.connect(uriUsers, opts);

  console.log(`✅ DB Users connectée : ${mongoose.connection.name}`);

  registerUsersModels(mongoose.connection);

  return mongoose.connection;
}

async function connectTxDB(uriTx, opts) {
  if (txConn && txConn.readyState === 1) {
    console.log(`ℹ️ DB Transactions déjà connectée : ${txConn.name}`);
    registerTransactionModels(txConn);
    return txConn;
  }

  if (txConn && txConn.readyState === 2) {
    console.log("ℹ️ DB Transactions connexion en cours...");
    await txConn.asPromise();
    registerTransactionModels(txConn);
    return txConn;
  }

  txConn = mongoose.createConnection(uriTx, opts);

  attachConnLogs(txConn, "transactions");

  await txConn.asPromise();

  console.log(`✅ DB Transactions connectée : ${txConn.name}`);

  registerTransactionModels(txConn);

  return txConn;
}

/**
 * ============================================================================
 * UN SEUL CLIENT MONGO POUR DEUX BASES — CONDITION DE L'ATOMICITÉ
 * ============================================================================
 *
 * Une transaction MongoDB ne vaut que dans les limites d'UN `MongoClient`. Or
 * ce service ouvrait deux clients : `mongoose.connect()` pour la base des
 * utilisateurs, `mongoose.createConnection()` pour celle des transactions.
 * `canUseSharedSession()` (voir `services/transactions/shared/runtime.js`)
 * compare l'identité du client — elle renvoyait donc **toujours** `false`, et
 * tout le mouvement d'argent tournait sans transaction, silencieusement, alors
 * même que les deux bases vivent sur le même cluster.
 *
 * `useDb()` règle cela : la connexion enfant réutilise le client du parent. Une
 * transaction couvre alors réellement les deux bases (vérifié : écriture
 * croisée puis annulation, aucun résidu).
 *
 * Le partage n'est tenté que si les deux URI ne diffèrent QUE par le nom de la
 * base — même serveur, mêmes identifiants, mêmes options. Deux clusters
 * distincts, ou deux comptes aux droits différents, retombent sur l'ancien
 * comportement : mieux vaut le mode dégradé qu'une connexion qui ment sur ses
 * privilèges.
 *
 * `MONGO_SHARE_CLIENT=off` restaure l'ancien comportement sans redéploiement,
 * si le passage aux transactions réelles devait révéler un effet de bord.
 */
function splitMongoUri(uri) {
  const m = /^(mongodb(?:\+srv)?:\/\/[^/]+)\/([^?]*)(\?.*)?$/.exec(
    String(uri || "").trim()
  );

  if (!m) return null;

  // `authority` porte les identifiants : il sert à COMPARER, jamais à journaliser.
  return {
    authority: m[1],
    dbName: decodeURIComponent(m[2] || ""),
    query: m[3] || "",
  };
}

function canShareMongoClient(uriUsers, uriTx) {
  if (String(process.env.MONGO_SHARE_CLIENT || "auto").toLowerCase() === "off") {
    return false;
  }

  const a = splitMongoUri(uriUsers);
  const b = splitMongoUri(uriTx);

  return !!(
    a &&
    b &&
    a.authority === b.authority &&
    a.query === b.query &&
    a.dbName &&
    b.dbName
  );
}

/**
 * Journalise le régime effectif. Le mode dégradé était jusqu'ici invisible :
 * personne ne pouvait savoir, en lisant les journaux de démarrage, que l'argent
 * bougeait sans transaction. C'est désormais dit explicitement.
 */
function logSessionMode() {
  const shared =
    !!txConn &&
    typeof txConn.getClient === "function" &&
    mongoose.connection.getClient?.() === txConn.getClient();

  if (shared) {
    console.log("✅ Transactions Mongo ACTIVES — atomicité inter-bases disponible");
  } else {
    console.warn(
      "⚠️ Transactions Mongo INACTIVES — clients distincts. Les écritures " +
        "croisées Users/Transactions ne sont PAS atomiques. Les garanties " +
        "reposent alors sur les index uniques et les registres d'idempotence."
    );
  }
}

async function connectTransactionsDB() {
  const { users: uriUsers, transactions: uriTx } = config.mongo || {};

  if (!uriUsers) {
    throw new Error("⚠️ MONGO_URI_USERS non défini (config.mongo.users)");
  }

  if (!uriTx) {
    throw new Error("⚠️ MONGO_URI_TRANSACTIONS non défini (config.mongo.transactions)");
  }

  const opts = buildMongooseOpts();

  await connectUsersDB(uriUsers, opts);

  attachPoolMetrics(mongoose.connection, "users");

  if (txConn && txConn.readyState === 1) {
    registerTransactionModels(txConn);
  } else if (canShareMongoClient(uriUsers, uriTx)) {
    const { dbName } = splitMongoUri(uriTx);

    // `useCache` garantit qu'un second appel rend la MÊME connexion, et non
    // une nouvelle : la fonction doit rester idempotente.
    txConn = mongoose.connection.useDb(dbName, { useCache: true });

    console.log(`✅ DB Transactions sur le client partagé : ${txConn.name}`);
    registerTransactionModels(txConn);
  } else {
    await connectTxDB(uriTx, opts);
  }

  attachPoolMetrics(txConn, "transactions");

  /* ══════════════════════════════════════════════════════════════════════════
   * BASE TARIFICATION
   * ══════════════════════════════════════════════════════════════════════════
   *
   * Ouverte APRÈS la base transactions et par le MÊME mécanisme : si son URI
   * partage hôte et identifiants avec celle des utilisateurs, on réutilise le
   * `MongoClient` déjà établi (`useDb`) plutôt que d'ouvrir un second pool.
   *
   * ⚠️ La tarification n'a PAS besoin de partager une session transactionnelle
   * avec le grand livre, et ne doit pas prétendre le faire. Un devis est LU
   * avant le mouvement, figé dans un `PricingQuote`, puis référencé par son
   * identifiant au moment de l'écriture comptable. C'est la forme de Stripe :
   * le montant des frais est arrêté à la création de l'intention, pas
   * recalculé au moment de débiter — sinon le prix affiché au client et le prix
   * prélevé peuvent diverger sans que personne ne le voie.
   */
  const uriPricing = (config.mongo || {}).pricing;

  if (!uriPricing) {
    /**
     * Règle B.6 : on annonce l'absence AVEC sa conséquence. Le service démarre
     * — les chemins qui ne tarifient pas restent servis — mais tout devis
     * échouera, et il faut que ce soit lisible au déploiement plutôt que
     * découvert par un utilisateur dont le virement échoue.
     */
    console.error(
      "❌ MONGO_URI_PRICING absente — CONSÉQUENCE : aucun devis ne pourra être " +
        "calculé, toute transaction nécessitant une tarification échouera. " +
        "Aucun repli n'est appliqué (règle B.2)."
    );
  } else if (pricingConn && pricingConn.readyState === 1) {
    registerPricingModels(pricingConn);
  } else if (canShareMongoClient(uriUsers, uriPricing)) {
    const { dbName } = splitMongoUri(uriPricing);

    pricingConn = mongoose.connection.useDb(dbName, { useCache: true });

    console.log(`✅ DB Tarification sur le client partagé : ${pricingConn.name}`);
    registerPricingModels(pricingConn);
  } else {
    pricingConn = mongoose.createConnection(uriPricing, opts);
    attachConnLogs(pricingConn, "pricing");

    await pricingConn.asPromise();

    console.log(`✅ DB Tarification connectée : ${pricingConn.name}`);
    registerPricingModels(pricingConn);
  }

  if (pricingConn) attachPoolMetrics(pricingConn, "pricing");

  logSessionMode();

  return {
    usersConn: mongoose.connection,
    txConn,
    pricingConn,
  };
}

/**
 * Connexion de la base tarification.
 *
 * ⚠️ LÈVE si elle n'est pas initialisée, au lieu de rendre `null`. Un appelant
 * qui reçoit `null` écrit `conn?.models?.X` et obtient `undefined`, puis un
 * devis vide, puis un prix de zéro. Sur un chemin d'argent, l'absence de base
 * doit arrêter l'opération, pas la laisser continuer sans prix (règle B.2).
 */
function getPricingConn() {
  if (!pricingConn) {
    throw new Error(
      "Base tarification non initialisée : aucun devis ne peut être calculé. " +
        "Vérifier MONGO_URI_PRICING."
    );
  }

  return pricingConn;
}

/** Modèle de la base tarification, ou une erreur nommée. */
function getPricingModel(modelName) {
  const conn = getPricingConn();

  if (!conn.models[modelName]) {
    throw new Error(`Modèle ${modelName} non enregistré sur la base tarification`);
  }

  return conn.models[modelName];
}

function getTxConn() {
  if (!txConn) {
    throw new Error("Transactions DB non initialisée. Appelez connectTransactionsDB() d'abord.");
  }

  return txConn;
}

function getUsersConn() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("Users DB non initialisée. Appelez connectTransactionsDB() d'abord.");
  }

  return mongoose.connection;
}

function getUsersModel() {
  const conn = getUsersConn();
  return conn.models.User || require("../models/User")(conn);
}

function getTxUserModel() {
  const conn = getTxConn();
  return conn.models.User || require("../models/User")(conn);
}

function getTxModel(modelName) {
  const conn = getTxConn();

  if (!conn.models[modelName]) {
    throw new Error(`Modèle ${modelName} non enregistré sur txConn`);
  }

  return conn.models[modelName];
}

module.exports = {
  connectTransactionsDB,
  registerPricingModels,
  getPricingConn,
  getPricingModel,

  /**
   * Exporté pour `scripts/ensureIndexes.js`, qui doit connaître la liste
   * EXACTE des modèles portés par la connexion transactions afin d'en
   * comparer les index. La dupliquer dans le script l'aurait laissée diverger
   * en silence : un modèle ajouté ici, et l'audit d'index cesse de le voir
   * sans que rien ne le signale.
   */
  registerTransactionModels,

  getTxConn,
  getUsersConn,
  getUsersModel,
  getTxUserModel,
  getTxModel,
};