// "use strict";

// /**
//  * Runtime partagé transactions (LAZY / SAFE)
//  * - Balance => wallet utilisateur TX
//  * - SystemBalance => wallet système / treasury TX
//  */

// const mongoose = require("mongoose");
// const axios = require("axios");
// const config = require("../../../config");
// const db = require("../../../config/db");

// const validationService = require("../../../services/validationService");
// const { logTransaction } = require("../../../services/aml");
// const logger = require("../../../logger");
// const { convertAmount } = require("../../../tools/currency");
// const { normCur } = require("../../../utils/currency");
// const generateTransactionRef = require("../../../utils/generateRef");

// const {
//   reserveSenderFunds,
//   captureSenderReserve,
//   releaseSenderReserve,
//   creditReceiverFunds,
//   debitReceiverFunds,
//   refundSenderFunds,
//   creditTreasuryRevenue,
//   chargeCancellationFee,
//   createLedgerEntry,
//   resolveTreasuryFromSystemType,
//   getTreasuryUserIdBySystemType,
//   normalizeTreasurySystemType,
//   TREASURY_SYSTEM_TYPES,
//   creditSystemWallet,
//   debitSystemWallet,
// } = require("../../../services/ledgerService");

// const {
//   normalizePricingSnapshot,
//   buildTreasuryRevenueBreakdown,
//   roundMoney,
// } = require("../../../services/pricingSnapshotNormalizer");

// const { assertTransition } = require("../../../services/transactionStateMachine");

// let _usersConn = null;
// let _txConn = null;

// let _User = null;
// let _Device = null;
// let _Notification = null;
// let _Outbox = null;
// let _Transaction = null;
// let _UserWalletBalance = null;
// let _SystemBalance = null;
// let _LedgerEntry = null;

// function getUsersConnectionSafe() {
//   if (_usersConn) return _usersConn;
//   _usersConn = db.getUsersConn();
//   return _usersConn;
// }

// function getTxConnectionSafe() {
//   if (_txConn) return _txConn;
//   _txConn = db.getTxConn();
//   return _txConn;
// }

// function getUserModel() {
//   if (_User) return _User;
//   _User = require("../../../models/User")(getUsersConnectionSafe());
//   return _User;
// }

// function getDeviceModel() {
//   if (_Device) return _Device;
//   _Device = require("../../../models/Device")(getUsersConnectionSafe());
//   return _Device;
// }

// function getNotificationModel() {
//   if (_Notification) return _Notification;
//   _Notification = require("../../../models/Notification")(getUsersConnectionSafe());
//   return _Notification;
// }

// function getOutboxModel() {
//   if (_Outbox) return _Outbox;
//   _Outbox = require("../../../models/Outbox")(getUsersConnectionSafe());
//   return _Outbox;
// }

// function getTransactionModel() {
//   if (_Transaction) return _Transaction;
//   _Transaction = require("../../../models/Transaction")(getTxConnectionSafe());
//   return _Transaction;
// }

// function getUserWalletBalanceModel() {
//   if (_UserWalletBalance) return _UserWalletBalance;
//   _UserWalletBalance = require("../../../models/TxWalletBalance")(getTxConnectionSafe());
//   return _UserWalletBalance;
// }

// function getSystemBalanceModel() {
//   if (_SystemBalance) return _SystemBalance;
//   try {
//     _SystemBalance = require("../../../models/TxSystemBalance")(getTxConnectionSafe());
//   } catch {
//     _SystemBalance = null;
//   }
//   return _SystemBalance;
// }

// function getBalanceModel() {
//   return getUserWalletBalanceModel();
// }

// function getLedgerEntryModel() {
//   if (_LedgerEntry) return _LedgerEntry;
//   _LedgerEntry = require("../../../models/LedgerEntry")(getTxConnectionSafe());
//   return _LedgerEntry;
// }

// const PRINCIPAL_URL = config.principalUrl;
// const GATEWAY_URL = config.gatewayUrl;
// const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || config.internalToken || "";

// function clean(value) {
//   return String(value || "").trim();
// }

// const TREASURY_ENV_BY_SYSTEM_TYPE = Object.freeze({
//   REFERRAL_TREASURY: clean(process.env.REFERRAL_TREASURY_USER_ID),
//   FEES_TREASURY: clean(process.env.FEES_TREASURY_USER_ID),
//   OPERATIONS_TREASURY: clean(process.env.OPERATIONS_TREASURY_USER_ID),
//   CAGNOTTE_FEES_TREASURY: clean(process.env.CAGNOTTE_FEES_TREASURY_USER_ID),
//   FX_MARGIN_TREASURY: clean(process.env.FX_MARGIN_TREASURY_USER_ID),
// });

// function sameMongoClient(connA, connB) {
//   try {
//     const a = connA?.getClient?.();
//     const b = connB?.getClient?.();
//     return !!a && !!b && a === b;
//   } catch {
//     return false;
//   }
// }

// function canUseSharedSession() {
//   try {
//     return sameMongoClient(getUsersConnectionSafe(), getTxConnectionSafe());
//   } catch {
//     return false;
//   }
// }

// const CAN_USE_SHARED_SESSION = canUseSharedSession();

// async function startTxSession() {
//   const txConn = getTxConnectionSafe();
//   if (typeof txConn?.startSession === "function") {
//     return txConn.startSession();
//   }
//   return mongoose.startSession();
// }

// function maybeSessionOpts(session) {
//   return canUseSharedSession() && session ? { session } : {};
// }

// function safeEndSession(session) {
//   try {
//     session?.endSession?.();
//   } catch {}
// }

// async function safeCommit(session) {
//   if (!canUseSharedSession() || !session) return;
//   await session.commitTransaction();
// }

// async function safeAbort(session) {
//   if (!canUseSharedSession() || !session) return;
//   try {
//     await session.abortTransaction();
//   } catch {}
// }

// function assertTreasuryConfig() {
//   const missing = [];

//   for (const systemType of Object.keys(TREASURY_ENV_BY_SYSTEM_TYPE)) {
//     if (!TREASURY_ENV_BY_SYSTEM_TYPE[systemType]) {
//       missing.push(systemType);
//     }
//   }

//   if (missing.length) {
//     throw new Error(`Variables treasury manquantes: ${missing.join(", ")}`);
//   }

//   return true;
// }

// function getRuntime() {
//   return {
//     mongoose,
//     axios,
//     config,

//     usersConn: getUsersConnectionSafe(),
//     txConn: getTxConnectionSafe(),

//     User: getUserModel(),
//     Device: getDeviceModel(),
//     Notification: getNotificationModel(),
//     Outbox: getOutboxModel(),
//     Transaction: getTransactionModel(),
//     Balance: getBalanceModel(),
//     UserWalletBalance: getUserWalletBalanceModel(),
//     SystemBalance: getSystemBalanceModel(),
//     LedgerEntry: getLedgerEntryModel(),

//     validationService,
//     logTransaction,
//     logger,
//     convertAmount,
//     normCur,
//     generateTransactionRef,

//     reserveSenderFunds,
//     captureSenderReserve,
//     releaseSenderReserve,
//     creditReceiverFunds,
//     debitReceiverFunds,
//     refundSenderFunds,
//     creditTreasuryRevenue,
//     chargeCancellationFee,
//     createLedgerEntry,
//     creditSystemWallet,
//     debitSystemWallet,

//     resolveTreasuryFromSystemType,
//     getTreasuryUserIdBySystemType,
//     normalizeTreasurySystemType,
//     TREASURY_SYSTEM_TYPES,
//     TREASURY_ENV_BY_SYSTEM_TYPE,
//     assertTreasuryConfig,

//     normalizePricingSnapshot,
//     buildTreasuryRevenueBreakdown,
//     roundMoney,

//     assertTransition,

//     PRINCIPAL_URL,
//     GATEWAY_URL,
//     INTERNAL_TOKEN,

//     CAN_USE_SHARED_SESSION,
//     canUseSharedSession,
//     startTxSession,
//     maybeSessionOpts,
//     safeCommit,
//     safeAbort,
//     safeEndSession,
//   };
// }

// const runtime = {};

// Object.defineProperties(runtime, {
//   mongoose: { get: () => mongoose },
//   axios: { get: () => axios },
//   config: { get: () => config },

//   validationService: { get: () => validationService },
//   logTransaction: { get: () => logTransaction },
//   logger: { get: () => logger },
//   convertAmount: { get: () => convertAmount },
//   normCur: { get: () => normCur },
//   generateTransactionRef: { get: () => generateTransactionRef },

//   reserveSenderFunds: { get: () => reserveSenderFunds },
//   captureSenderReserve: { get: () => captureSenderReserve },
//   releaseSenderReserve: { get: () => releaseSenderReserve },
//   creditReceiverFunds: { get: () => creditReceiverFunds },
//   debitReceiverFunds: { get: () => debitReceiverFunds },
//   refundSenderFunds: { get: () => refundSenderFunds },
//   creditTreasuryRevenue: { get: () => creditTreasuryRevenue },
//   chargeCancellationFee: { get: () => chargeCancellationFee },
//   createLedgerEntry: { get: () => createLedgerEntry },
//   creditSystemWallet: { get: () => creditSystemWallet },
//   debitSystemWallet: { get: () => debitSystemWallet },

//   resolveTreasuryFromSystemType: { get: () => resolveTreasuryFromSystemType },
//   getTreasuryUserIdBySystemType: { get: () => getTreasuryUserIdBySystemType },
//   normalizeTreasurySystemType: { get: () => normalizeTreasurySystemType },
//   TREASURY_SYSTEM_TYPES: { get: () => TREASURY_SYSTEM_TYPES },
//   TREASURY_ENV_BY_SYSTEM_TYPE: { get: () => TREASURY_ENV_BY_SYSTEM_TYPE },
//   assertTreasuryConfig: { get: () => assertTreasuryConfig },

//   normalizePricingSnapshot: { get: () => normalizePricingSnapshot },
//   buildTreasuryRevenueBreakdown: { get: () => buildTreasuryRevenueBreakdown },
//   roundMoney: { get: () => roundMoney },

//   assertTransition: { get: () => assertTransition },

//   PRINCIPAL_URL: { get: () => PRINCIPAL_URL },
//   GATEWAY_URL: { get: () => GATEWAY_URL },
//   INTERNAL_TOKEN: { get: () => INTERNAL_TOKEN },

//   CAN_USE_SHARED_SESSION: { get: () => CAN_USE_SHARED_SESSION },
//   usersConn: { get: () => getUsersConnectionSafe() },
//   txConn: { get: () => getTxConnectionSafe() },

//   User: { get: () => getUserModel() },
//   Device: { get: () => getDeviceModel() },
//   Notification: { get: () => getNotificationModel() },
//   Outbox: { get: () => getOutboxModel() },
//   Transaction: { get: () => getTransactionModel() },
//   Balance: { get: () => getBalanceModel() },
//   UserWalletBalance: { get: () => getUserWalletBalanceModel() },
//   SystemBalance: { get: () => getSystemBalanceModel() },
//   LedgerEntry: { get: () => getLedgerEntryModel() },

//   getUsersConnectionSafe: { get: () => getUsersConnectionSafe },
//   getTxConnectionSafe: { get: () => getTxConnectionSafe },

//   getUserModel: { get: () => getUserModel },
//   getDeviceModel: { get: () => getDeviceModel },
//   getNotificationModel: { get: () => getNotificationModel },
//   getOutboxModel: { get: () => getOutboxModel },
//   getTransactionModel: { get: () => getTransactionModel },
//   getBalanceModel: { get: () => getBalanceModel },
//   getUserWalletBalanceModel: { get: () => getUserWalletBalanceModel },
//   getSystemBalanceModel: { get: () => getSystemBalanceModel },
//   getLedgerEntryModel: { get: () => getLedgerEntryModel },

//   canUseSharedSession: { get: () => canUseSharedSession },
//   startTxSession: { get: () => startTxSession },
//   maybeSessionOpts: { get: () => maybeSessionOpts },
//   safeCommit: { get: () => safeCommit },
//   safeAbort: { get: () => safeAbort },
//   safeEndSession: { get: () => safeEndSession },

//   getRuntime: { get: () => getRuntime },
// });

// module.exports = runtime;








"use strict";

/**
 * Runtime partagé transactions (LAZY / SAFE)
 *
 * Règles :
 * - User / Device => DB principale Users
 * - Transaction / Outbox / Notification / Ledger / Wallets => DB Transactions
 * - Balance utilisateur => TxWalletBalance
 * - Balance système / treasury => TxSystemBalance
 */

const mongoose = require("mongoose");
const axios = require("axios");
const config = require("../../../config");
const db = require("../../../config/db");

const validationService = require("../../../services/validationService");
const { logTransaction } = require("../../../services/aml");
const logger = require("../../../logger");
const { convertAmount } = require("../../../tools/currency");
const { normCur } = require("../../../utils/currency");
const generateTransactionRef = require("../../../utils/generateRef");

const {
  reserveSenderFunds,
  captureSenderReserve,
  releaseSenderReserve,
  creditReceiverFunds,
  debitReceiverFunds,
  refundSenderFunds,
  creditTreasuryRevenue,
  chargeCancellationFee,
  createLedgerEntry,
  resolveTreasuryFromSystemType,
  getTreasuryUserIdBySystemType,
  normalizeTreasurySystemType,
  TREASURY_SYSTEM_TYPES,
  creditSystemWallet,
  debitSystemWallet,
} = require("../../../services/ledgerService");

const {
  normalizePricingSnapshot,
  buildTreasuryRevenueBreakdown,
  roundMoney,
} = require("../../../services/pricingSnapshotNormalizer");

const {
  assertTransition,
} = require("../../../services/transactionStateMachine");

let _usersConn = null;
let _txConn = null;

let _User = null;
let _Device = null;
let _Notification = null;
let _Outbox = null;
let _Transaction = null;
let _UserWalletBalance = null;
let _SystemBalance = null;
let _LedgerEntry = null;

const PRINCIPAL_URL = config.principalUrl;
const GATEWAY_URL = config.gatewayUrl;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || config.internalToken || "";

function clean(value) {
  return String(value || "").trim();
}

const TREASURY_ENV_BY_SYSTEM_TYPE = Object.freeze({
  REFERRAL_TREASURY: clean(process.env.REFERRAL_TREASURY_USER_ID),
  FEES_TREASURY: clean(process.env.FEES_TREASURY_USER_ID),
  OPERATIONS_TREASURY: clean(process.env.OPERATIONS_TREASURY_USER_ID),
  CAGNOTTE_FEES_TREASURY: clean(process.env.CAGNOTTE_FEES_TREASURY_USER_ID),
  FX_MARGIN_TREASURY: clean(process.env.FX_MARGIN_TREASURY_USER_ID),
});

function getUsersConnectionSafe() {
  if (_usersConn && _usersConn.readyState === 1) {
    return _usersConn;
  }

  _usersConn = db.getUsersConn();
  return _usersConn;
}

function getTxConnectionSafe() {
  if (_txConn && _txConn.readyState === 1) {
    return _txConn;
  }

  _txConn = db.getTxConn();
  return _txConn;
}

function getUserModel() {
  if (_User) return _User;

  /**
   * IMPORTANT :
   * User doit pointer vers la DB principale Users.
   * C’est ce modèle qui permet au tx-core de lire :
   * - country
   * - currency
   * - accountStatus
   * - isBlocked
   * - hiddenFromTransfers
   * - isSystem
   * - systemType
   */
  _User = require("../../../models/User")(getUsersConnectionSafe());
  return _User;
}

function getDeviceModel() {
  if (_Device) return _Device;

  _Device = require("../../../models/Device")(getUsersConnectionSafe());
  return _Device;
}

function getNotificationModel() {
  if (_Notification) return _Notification;

  /**
   * Dans ton db.js, Notification est enregistré sur txConn.
   * Donc ici on doit aussi le charger depuis txConn.
   */
  _Notification = require("../../../models/Notification")(getTxConnectionSafe());
  return _Notification;
}

function getOutboxModel() {
  if (_Outbox) return _Outbox;

  /**
   * Dans ton db.js, Outbox est enregistré sur txConn.
   * Donc ici on doit aussi le charger depuis txConn.
   */
  _Outbox = require("../../../models/Outbox")(getTxConnectionSafe());
  return _Outbox;
}

function getTransactionModel() {
  if (_Transaction) return _Transaction;

  _Transaction = require("../../../models/Transaction")(getTxConnectionSafe());
  return _Transaction;
}

function getUserWalletBalanceModel() {
  if (_UserWalletBalance) return _UserWalletBalance;

  _UserWalletBalance = require("../../../models/TxWalletBalance")(
    getTxConnectionSafe()
  );

  return _UserWalletBalance;
}

function getSystemBalanceModel() {
  if (_SystemBalance) return _SystemBalance;

  try {
    _SystemBalance = require("../../../models/TxSystemBalance")(
      getTxConnectionSafe()
    );
  } catch (err) {
    logger?.warn?.("[runtime] TxSystemBalance model indisponible", {
      message: err?.message || String(err),
    });

    _SystemBalance = null;
  }

  return _SystemBalance;
}

function getBalanceModel() {
  return getUserWalletBalanceModel();
}

function getLedgerEntryModel() {
  if (_LedgerEntry) return _LedgerEntry;

  _LedgerEntry = require("../../../models/LedgerEntry")(getTxConnectionSafe());
  return _LedgerEntry;
}

function sameMongoClient(connA, connB) {
  try {
    const a = connA?.getClient?.();
    const b = connB?.getClient?.();

    return !!a && !!b && a === b;
  } catch {
    return false;
  }
}

function canUseSharedSession() {
  try {
    return sameMongoClient(getUsersConnectionSafe(), getTxConnectionSafe());
  } catch {
    return false;
  }
}

async function startTxSession() {
  const txConn = getTxConnectionSafe();

  if (typeof txConn?.startSession === "function") {
    return txConn.startSession();
  }

  return mongoose.startSession();
}

function maybeSessionOpts(session) {
  return canUseSharedSession() && session ? { session } : {};
}

function safeEndSession(session) {
  try {
    session?.endSession?.();
  } catch {}
}

async function safeCommit(session) {
  if (!canUseSharedSession() || !session) return;

  await session.commitTransaction();
}

async function safeAbort(session) {
  if (!canUseSharedSession() || !session) return;

  try {
    await session.abortTransaction();
  } catch {}
}

function assertTreasuryConfig() {
  const missing = [];

  for (const systemType of Object.keys(TREASURY_ENV_BY_SYSTEM_TYPE)) {
    if (!TREASURY_ENV_BY_SYSTEM_TYPE[systemType]) {
      missing.push(systemType);
    }
  }

  if (missing.length) {
    throw new Error(
      `Variables treasury manquantes: ${missing.join(", ")}`
    );
  }

  return true;
}

function getRuntime() {
  return {
    mongoose,
    axios,
    config,

    usersConn: getUsersConnectionSafe(),
    txConn: getTxConnectionSafe(),

    User: getUserModel(),
    Device: getDeviceModel(),
    Notification: getNotificationModel(),
    Outbox: getOutboxModel(),
    Transaction: getTransactionModel(),
    Balance: getBalanceModel(),
    UserWalletBalance: getUserWalletBalanceModel(),
    SystemBalance: getSystemBalanceModel(),
    LedgerEntry: getLedgerEntryModel(),

    validationService,
    logTransaction,
    logger,
    convertAmount,
    normCur,
    generateTransactionRef,

    reserveSenderFunds,
    captureSenderReserve,
    releaseSenderReserve,
    creditReceiverFunds,
    debitReceiverFunds,
    refundSenderFunds,
    creditTreasuryRevenue,
    chargeCancellationFee,
    createLedgerEntry,
    creditSystemWallet,
    debitSystemWallet,

    resolveTreasuryFromSystemType,
    getTreasuryUserIdBySystemType,
    normalizeTreasurySystemType,
    TREASURY_SYSTEM_TYPES,
    TREASURY_ENV_BY_SYSTEM_TYPE,
    assertTreasuryConfig,

    normalizePricingSnapshot,
    buildTreasuryRevenueBreakdown,
    roundMoney,

    assertTransition,

    PRINCIPAL_URL,
    GATEWAY_URL,
    INTERNAL_TOKEN,

    CAN_USE_SHARED_SESSION: canUseSharedSession(),
    canUseSharedSession,
    startTxSession,
    maybeSessionOpts,
    safeCommit,
    safeAbort,
    safeEndSession,

    getUsersConnectionSafe,
    getTxConnectionSafe,

    getUserModel,
    getDeviceModel,
    getNotificationModel,
    getOutboxModel,
    getTransactionModel,
    getBalanceModel,
    getUserWalletBalanceModel,
    getSystemBalanceModel,
    getLedgerEntryModel,
  };
}

const runtime = {};

Object.defineProperties(runtime, {
  mongoose: { get: () => mongoose },
  axios: { get: () => axios },
  config: { get: () => config },

  validationService: { get: () => validationService },
  logTransaction: { get: () => logTransaction },
  logger: { get: () => logger },
  convertAmount: { get: () => convertAmount },
  normCur: { get: () => normCur },
  generateTransactionRef: { get: () => generateTransactionRef },

  reserveSenderFunds: { get: () => reserveSenderFunds },
  captureSenderReserve: { get: () => captureSenderReserve },
  releaseSenderReserve: { get: () => releaseSenderReserve },
  creditReceiverFunds: { get: () => creditReceiverFunds },
  debitReceiverFunds: { get: () => debitReceiverFunds },
  refundSenderFunds: { get: () => refundSenderFunds },
  creditTreasuryRevenue: { get: () => creditTreasuryRevenue },
  chargeCancellationFee: { get: () => chargeCancellationFee },
  createLedgerEntry: { get: () => createLedgerEntry },
  creditSystemWallet: { get: () => creditSystemWallet },
  debitSystemWallet: { get: () => debitSystemWallet },

  resolveTreasuryFromSystemType: {
    get: () => resolveTreasuryFromSystemType,
  },
  getTreasuryUserIdBySystemType: {
    get: () => getTreasuryUserIdBySystemType,
  },
  normalizeTreasurySystemType: {
    get: () => normalizeTreasurySystemType,
  },
  TREASURY_SYSTEM_TYPES: {
    get: () => TREASURY_SYSTEM_TYPES,
  },
  TREASURY_ENV_BY_SYSTEM_TYPE: {
    get: () => TREASURY_ENV_BY_SYSTEM_TYPE,
  },
  assertTreasuryConfig: {
    get: () => assertTreasuryConfig,
  },

  normalizePricingSnapshot: {
    get: () => normalizePricingSnapshot,
  },
  buildTreasuryRevenueBreakdown: {
    get: () => buildTreasuryRevenueBreakdown,
  },
  roundMoney: {
    get: () => roundMoney,
  },

  assertTransition: {
    get: () => assertTransition,
  },

  PRINCIPAL_URL: {
    get: () => PRINCIPAL_URL,
  },
  GATEWAY_URL: {
    get: () => GATEWAY_URL,
  },
  INTERNAL_TOKEN: {
    get: () => INTERNAL_TOKEN,
  },

  /**
   * Important :
   * Ne pas figer CAN_USE_SHARED_SESSION au chargement du fichier.
   * Les connexions peuvent ne pas être prêtes au moment du require().
   */
  CAN_USE_SHARED_SESSION: {
    get: () => canUseSharedSession(),
  },

  usersConn: {
    get: () => getUsersConnectionSafe(),
  },
  txConn: {
    get: () => getTxConnectionSafe(),
  },

  User: {
    get: () => getUserModel(),
  },
  Device: {
    get: () => getDeviceModel(),
  },
  Notification: {
    get: () => getNotificationModel(),
  },
  Outbox: {
    get: () => getOutboxModel(),
  },
  Transaction: {
    get: () => getTransactionModel(),
  },
  Balance: {
    get: () => getBalanceModel(),
  },
  UserWalletBalance: {
    get: () => getUserWalletBalanceModel(),
  },
  SystemBalance: {
    get: () => getSystemBalanceModel(),
  },
  LedgerEntry: {
    get: () => getLedgerEntryModel(),
  },

  getUsersConnectionSafe: {
    get: () => getUsersConnectionSafe,
  },
  getTxConnectionSafe: {
    get: () => getTxConnectionSafe,
  },

  getUserModel: {
    get: () => getUserModel,
  },
  getDeviceModel: {
    get: () => getDeviceModel,
  },
  getNotificationModel: {
    get: () => getNotificationModel,
  },
  getOutboxModel: {
    get: () => getOutboxModel,
  },
  getTransactionModel: {
    get: () => getTransactionModel,
  },
  getBalanceModel: {
    get: () => getBalanceModel,
  },
  getUserWalletBalanceModel: {
    get: () => getUserWalletBalanceModel,
  },
  getSystemBalanceModel: {
    get: () => getSystemBalanceModel,
  },
  getLedgerEntryModel: {
    get: () => getLedgerEntryModel,
  },

  canUseSharedSession: {
    get: () => canUseSharedSession,
  },
  startTxSession: {
    get: () => startTxSession,
  },
  maybeSessionOpts: {
    get: () => maybeSessionOpts,
  },
  safeCommit: {
    get: () => safeCommit,
  },
  safeAbort: {
    get: () => safeAbort,
  },
  safeEndSession: {
    get: () => safeEndSession,
  },

  getRuntime: {
    get: () => getRuntime,
  },
});

module.exports = runtime;