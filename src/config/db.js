// // File: src/config/db.js
// 'use strict';

// const mongoose = require('mongoose');
// const config = require('../config');

// let txConn = null;

// /**
//  * Options mongoose robustes (Render + Mongo Atlas)
//  */
// function buildMongooseOpts() {
//   return {
//     useNewUrlParser: true,
//     useUnifiedTopology: true,

//     // ✅ Evite les "hang" de 30s quand Mongo n'est pas joignable
//     serverSelectionTimeoutMS: 8000,
//     connectTimeoutMS: 8000,

//     // ✅ sockets
//     socketTimeoutMS: 45000,

//     // ✅ pool
//     maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 15),
//     minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 0),

//     // ✅ keep-alive (utile sur Render)
//     heartbeatFrequencyMS: 10000,
//   };
// }

// function attachConnLogs(conn, name = 'mongo') {
//   if (!conn) return;

//   conn.on('connected', () => {
//     // conn.name existe après handshake
//     // eslint-disable-next-line no-console
//     console.log(`✅ [DB:${name}] connected → ${conn.name || 'unknown'}`);
//   });

//   conn.on('error', (err) => {
//     // eslint-disable-next-line no-console
//     console.error(`❌ [DB:${name}] error:`, err?.message || err);
//   });

//   conn.on('disconnected', () => {
//     // eslint-disable-next-line no-console
//     console.warn(`⚠️ [DB:${name}] disconnected`);
//   });

//   conn.on('reconnected', () => {
//     // eslint-disable-next-line no-console
//     console.log(`🔁 [DB:${name}] reconnected`);
//   });
// }

// /**
//  * Initialise les connexions Mongoose :
//  * - Connexion principale (mongoose) → Users (mongoose.connection)
//  * - Connexion secondaire (txConn)   → Transactions/Outbox/Notification
//  */
// async function connectTransactionsDB() {
//   const { users: uriUsers, transactions: uriTx } = config.mongo || {};

//   if (!uriUsers) throw new Error('⚠️ MONGO_URI_USERS non défini (config.mongo.users)');
//   if (!uriTx) throw new Error('⚠️ MONGO_URI_TRANSACTIONS non défini (config.mongo.transactions)');

//   const opts = buildMongooseOpts();

//   // 1) Connexion principale (Users)
//   if (mongoose.connection.readyState === 0) {
//     attachConnLogs(mongoose.connection, 'users-main');
//     await mongoose.connect(uriUsers, opts);

//     // eslint-disable-next-line no-console
//     console.log(`✅ DB Users connectée : ${mongoose.connection.name}`);

//     // Charge modèles liés à la DB users
//     require('../models/User')();
//     require('../models/Device')(mongoose.connection);


//   } else {
//     // eslint-disable-next-line no-console
//     console.log(`ℹ️ DB Users déjà connectée (state=${mongoose.connection.readyState})`);
//   }

//   // 2) Connexion txConn (Transactions)
//   if (!txConn || txConn.readyState !== 1) {
//     // si existait mais down → on recrée
//     txConn = mongoose.createConnection(uriTx, opts);
//     attachConnLogs(txConn, 'transactions');

//     // Attendre la connexion
//     await txConn.asPromise();

//     // eslint-disable-next-line no-console
//     console.log(`✅ DB Transactions connectée : ${txConn.name}`);

//     // ⚠️ Important: on enregistre les modèles sur txConn
//     require('../models/User')(txConn);
//     require('../models/Transaction')(txConn);
//     require('../models/Outbox')(txConn);
//     require('../models/Notification')(txConn);
//     require('../models/LedgerEntry')(txConn);
//     require('../models/TxWalletBalance')(txConn);
//   } else {
//     // eslint-disable-next-line no-console
//     console.log(`ℹ️ DB Transactions déjà connectée (state=${txConn.readyState})`);
//   }
// }

// /**
//  * Récupère la connexion transactionnelle (fail si non initialisée)
//  */
// function getTxConn() {
//   if (!txConn) {
//     throw new Error("Transactions DB non initialisée. Appelez connectTransactionsDB() d'abord.");
//   }
//   return txConn;
// }

// /**
//  * Récupère la connexion Users principale (mongoose)
//  */
// function getUsersConn() {
//   return mongoose.connection;
// }

// module.exports = { connectTransactionsDB, getTxConn, getUsersConn };





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
  await connectTxDB(uriTx, opts);

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