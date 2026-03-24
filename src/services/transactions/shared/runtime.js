"use strict";

/**
 * --------------------------------------------------------------------------
 * Runtime partagé transactions (LAZY / SAFE)
 * --------------------------------------------------------------------------
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
} = require("../../../services/ledgerService");

const {
  normalizePricingSnapshot,
  buildTreasuryRevenueBreakdown,
  roundMoney,
} = require("../../../services/pricingSnapshotNormalizer");

const { assertTransition } = require("../../../services/transactionStateMachine");

let _usersConn = null;
let _txConn = null;

let _User = null;
let _Device = null;
let _Notification = null;
let _Outbox = null;
let _Transaction = null;
let _Balance = null;
let _LedgerEntry = null;

function getUsersConnectionSafe() {
  if (_usersConn) return _usersConn;
  _usersConn = db.getUsersConn();
  return _usersConn;
}

function getTxConnectionSafe() {
  if (_txConn) return _txConn;
  _txConn = db.getTxConn();
  return _txConn;
}

function getUserModel() {
  if (_User) return _User;
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
  _Notification = require("../../../models/Notification")(getUsersConnectionSafe());
  return _Notification;
}

function getOutboxModel() {
  if (_Outbox) return _Outbox;
  _Outbox = require("../../../models/Outbox")(getUsersConnectionSafe());
  return _Outbox;
}

function getTransactionModel() {
  if (_Transaction) return _Transaction;
  _Transaction = require("../../../models/Transaction")(getTxConnectionSafe());
  return _Transaction;
}

function getBalanceModel() {
  if (_Balance) return _Balance;
  _Balance = require("../../../models/TxWalletBalance")(getUsersConnectionSafe());
  return _Balance;
}

function getLedgerEntryModel() {
  if (_LedgerEntry) return _LedgerEntry;
  _LedgerEntry = require("../../../models/LedgerEntry")(getTxConnectionSafe());
  return _LedgerEntry;
}

const PRINCIPAL_URL = config.principalUrl;
const GATEWAY_URL = config.gatewayUrl;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || config.internalToken || "";

/* -------------------------------------------------------------------------- */
/* Treasury runtime                                                           */
/* -------------------------------------------------------------------------- */

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

    canUseSharedSession,
    startTxSession,
    maybeSessionOpts,
    safeCommit,
    safeAbort,
    safeEndSession,
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

  resolveTreasuryFromSystemType: { get: () => resolveTreasuryFromSystemType },
  getTreasuryUserIdBySystemType: { get: () => getTreasuryUserIdBySystemType },
  normalizeTreasurySystemType: { get: () => normalizeTreasurySystemType },
  TREASURY_SYSTEM_TYPES: { get: () => TREASURY_SYSTEM_TYPES },
  TREASURY_ENV_BY_SYSTEM_TYPE: { get: () => TREASURY_ENV_BY_SYSTEM_TYPE },
  assertTreasuryConfig: { get: () => assertTreasuryConfig },

  normalizePricingSnapshot: { get: () => normalizePricingSnapshot },
  buildTreasuryRevenueBreakdown: { get: () => buildTreasuryRevenueBreakdown },
  roundMoney: { get: () => roundMoney },

  assertTransition: { get: () => assertTransition },

  PRINCIPAL_URL: { get: () => PRINCIPAL_URL },
  GATEWAY_URL: { get: () => GATEWAY_URL },
  INTERNAL_TOKEN: { get: () => INTERNAL_TOKEN },

  usersConn: { get: () => getUsersConnectionSafe() },
  txConn: { get: () => getTxConnectionSafe() },

  User: { get: () => getUserModel() },
  Device: { get: () => getDeviceModel() },
  Notification: { get: () => getNotificationModel() },
  Outbox: { get: () => getOutboxModel() },
  Transaction: { get: () => getTransactionModel() },
  Balance: { get: () => getBalanceModel() },
  LedgerEntry: { get: () => getLedgerEntryModel() },

  getUsersConnectionSafe: { get: () => getUsersConnectionSafe },
  getTxConnectionSafe: { get: () => getTxConnectionSafe },

  getUserModel: { get: () => getUserModel },
  getDeviceModel: { get: () => getDeviceModel },
  getNotificationModel: { get: () => getNotificationModel },
  getOutboxModel: { get: () => getOutboxModel },
  getTransactionModel: { get: () => getTransactionModel },
  getBalanceModel: { get: () => getBalanceModel },
  getLedgerEntryModel: { get: () => getLedgerEntryModel },

  canUseSharedSession: { get: () => canUseSharedSession },
  startTxSession: { get: () => startTxSession },
  maybeSessionOpts: { get: () => maybeSessionOpts },
  safeCommit: { get: () => safeCommit },
  safeAbort: { get: () => safeAbort },
  safeEndSession: { get: () => safeEndSession },

  getRuntime: { get: () => getRuntime },
});

module.exports = runtime;