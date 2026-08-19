"use strict";

const mongoose = require("mongoose");
const config = require("../config");

let txConn = null;

function buildMongooseOpts() {
  return {
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 8000),
    connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 8000),
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 45000),

    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 15),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 0),

    heartbeatFrequencyMS: Number(process.env.MONGO_HEARTBEAT_MS || 10000),
    retryWrites: true,
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
  require("../models/IdempotencyRecord")(conn);

  try {
    require("../models/TxSystemBalance")(conn);
  } catch {}

  try {
    require("../models/TreasuryLedgerEntry")(conn);
  } catch {}
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

  logSessionMode();

  return {
    usersConn: mongoose.connection,
    txConn,
  };
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
  getTxConn,
  getUsersConn,
  getUsersModel,
  getTxUserModel,
  getTxModel,
};