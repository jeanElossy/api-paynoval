"use strict";

/**
 * --------------------------------------------------------------------------
 * Runtime partagé transactions
 * --------------------------------------------------------------------------
 * Rôle :
 * - centraliser les imports cross-module
 * - isoler la logique de connexions Mongo multi-DB
 * - exposer des helpers communs sûrs aux controllers transactionnels
 *
 * Objectif :
 * - éviter les require dupliqués partout
 * - fiabiliser l’usage des sessions Mongo
 * - préparer la séparation correcte TX Core / Users DB
 * --------------------------------------------------------------------------
 */

const mongoose = require("mongoose");
const axios = require("axios");
const config = require("../../../config");
const { getUsersConn, getTxConn } = require("../../../config/db");

/* -------------------------------------------------------------------------- */
/* Connexions                                                                 */
/* -------------------------------------------------------------------------- */

const usersConn = getUsersConn();
const txConn = getTxConn();

/* -------------------------------------------------------------------------- */
/* Modèles                                                                    */
/* -------------------------------------------------------------------------- */

const User = require("../../../models/User")(usersConn);
const Notification = require("../../../models/Notification")(usersConn);
const Outbox = require("../../../models/Outbox")(usersConn);
const Transaction = require("../../../models/Transaction")(txConn);

/**
 * Source de vérité opérationnelle des soldes :
 * - Balance sur usersConn
 * - LedgerEntry sur txConn
 */
const Balance = require("../../../models/Balance")(usersConn);
const LedgerEntry = require("../../../models/LedgerEntry")(txConn);

/* -------------------------------------------------------------------------- */
/* Services                                                                   */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Config runtime                                                             */
/* -------------------------------------------------------------------------- */

const PRINCIPAL_URL = config.principalUrl;
const GATEWAY_URL = config.gatewayUrl;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || config.internalToken || "";

/* -------------------------------------------------------------------------- */
/* Sessions Mongo                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Vérifie si les deux connexions pointent vers le même MongoClient.
 * Si oui, on peut partager une transaction/session entre les deux.
 */
function sameMongoClient(connA, connB) {
  try {
    const a = connA?.getClient?.();
    const b = connB?.getClient?.();
    return !!a && !!b && a === b;
  } catch {
    return false;
  }
}

const CAN_USE_SHARED_SESSION = sameMongoClient(usersConn, txConn);

/**
 * Ouvre une session sur la connexion TX.
 * Fallback mongoose si nécessaire.
 */
async function startTxSession() {
  if (typeof txConn?.startSession === "function") {
    return txConn.startSession();
  }
  return mongoose.startSession();
}

/**
 * Retourne les options de session seulement si elles sont supportées
 * par les deux connexions partagées.
 */
function maybeSessionOpts(session) {
  return CAN_USE_SHARED_SESSION && session ? { session } : {};
}

/**
 * Utilitaire défensif pour fermer une session sans casser le flux.
 */
function safeEndSession(session) {
  try {
    session?.endSession?.();
  } catch {
    // no-op
  }
}

/**
 * Commit défensif.
 */
async function safeCommit(session) {
  if (!CAN_USE_SHARED_SESSION || !session) return;
  await session.commitTransaction();
}

/**
 * Abort défensif.
 */
async function safeAbort(session) {
  if (!CAN_USE_SHARED_SESSION || !session) return;
  try {
    await session.abortTransaction();
  } catch {
    // no-op
  }
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  mongoose,
  axios,
  config,

  usersConn,
  txConn,

  User,
  Notification,
  Outbox,
  Transaction,
  Balance,
  LedgerEntry,

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

  CAN_USE_SHARED_SESSION,
  startTxSession,
  maybeSessionOpts,
  safeCommit,
  safeAbort,
  safeEndSession,
};