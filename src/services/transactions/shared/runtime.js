"use strict";

/**
 * --------------------------------------------------------------------------
 * Runtime partagé transactions (LAZY / SAFE)
 * --------------------------------------------------------------------------
 * Objectif :
 * - ne jamais exiger les connexions Mongo au chargement du module
 * - éviter le crash Render si les controllers sont importés avant bootstrap DB
 * - exposer des accès lazy/cachés aux connexions, modèles et services
 * --------------------------------------------------------------------------
 */

const mongoose = require("mongoose");
const axios = require("axios");
const config = require("../../../config");
const db = require("../../../config/db");

const validationService = require("../../../services/validationService");
const { logTransaction } = require("../../../services/aml");
const logger = require("../../../logger");
const { notifyTransactionViaGateway } = require("../../../services/notifyGateway");
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
  creditAdminRevenue,
  chargeCancellationFee,
  createLedgerEntry,
} = require("../../../services/ledgerService");

const {
  normalizePricingSnapshot,
  buildAdminRevenueBreakdown,
  roundMoney,
} = require("../../../services/pricingSnapshotNormalizer");

const { assertTransition } = require("../../../services/transactionStateMachine");

let _usersConn = null;
let _txConn = null;

let _User = null;
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
  _Balance = require("../../../models/Balance")(getUsersConnectionSafe());
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
  } catch {
    // no-op
  }
}

async function safeCommit(session) {
  if (!canUseSharedSession() || !session) return;
  await session.commitTransaction();
}

async function safeAbort(session) {
  if (!canUseSharedSession() || !session) return;
  try {
    await session.abortTransaction();
  } catch {
    // no-op
  }
}

function getRuntime() {
  return {
    mongoose,
    axios,
    config,

    usersConn: getUsersConnectionSafe(),
    txConn: getTxConnectionSafe(),

    User: getUserModel(),
    Notification: getNotificationModel(),
    Outbox: getOutboxModel(),
    Transaction: getTransactionModel(),
    Balance: getBalanceModel(),
    LedgerEntry: getLedgerEntryModel(),

    validationService,
    logTransaction,
    logger,
    notifyTransactionViaGateway,
    convertAmount,
    normCur,
    generateTransactionRef,

    reserveSenderFunds,
    captureSenderReserve,
    releaseSenderReserve,
    creditReceiverFunds,
    debitReceiverFunds,
    refundSenderFunds,
    creditAdminRevenue,
    chargeCancellationFee,
    createLedgerEntry,

    normalizePricingSnapshot,
    buildAdminRevenueBreakdown,
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

module.exports = {
  mongoose,
  axios,
  config,

  validationService,
  logTransaction,
  logger,
  notifyTransactionViaGateway,
  convertAmount,
  normCur,
  generateTransactionRef,

  reserveSenderFunds,
  captureSenderReserve,
  releaseSenderReserve,
  creditReceiverFunds,
  debitReceiverFunds,
  refundSenderFunds,
  creditAdminRevenue,
  chargeCancellationFee,
  createLedgerEntry,

  normalizePricingSnapshot,
  buildAdminRevenueBreakdown,
  roundMoney,

  assertTransition,

  PRINCIPAL_URL,
  GATEWAY_URL,
  INTERNAL_TOKEN,

  getUsersConnectionSafe,
  getTxConnectionSafe,

  getUserModel,
  getNotificationModel,
  getOutboxModel,
  getTransactionModel,
  getBalanceModel,
  getLedgerEntryModel,

  canUseSharedSession,
  startTxSession,
  maybeSessionOpts,
  safeCommit,
  safeAbort,
  safeEndSession,

  getRuntime,
};