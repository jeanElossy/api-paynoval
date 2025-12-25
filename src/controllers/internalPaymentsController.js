// File: src/controllers/internalPaymentsController.js
'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const createError = require('http-errors');

const { getUsersConn, getTxConn } = require('../config/db');
const config = require('../config');
const logger = require('../utils/logger');

const usersConn = getUsersConn();
const txConn = getTxConn();

const User = require('../models/User')(usersConn);
const Balance = require('../models/Balance')(usersConn);
const Transaction = require('../models/Transaction')(txConn);

const sanitize = (text) => String(text || '').replace(/[<>\\/{};]/g, '').trim();
const ADMIN_EMAIL = config.adminEmail || 'admin@paynoval.com';

/* ------------------------------------------------------------------ */
/* Multi-conn session safety                                           */
/* ------------------------------------------------------------------ */
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

async function startTxSession() {
  if (!CAN_USE_SHARED_SESSION) return null;
  if (typeof txConn?.startSession === 'function') return txConn.startSession();
  return mongoose.startSession();
}

function maybeSessionOpts(session) {
  return session ? { session } : {};
}

function isValidObjectId(v) {
  return mongoose.Types.ObjectId.isValid(String(v || ''));
}

/* ------------------------------------------------------------------ */
/* Kind resolver                                                       */
/* ------------------------------------------------------------------ */
function resolveKind(kind) {
  switch (kind) {
    case 'bonus':
    case 'cashback':
    case 'adjustment_credit':
    case 'cagnotte_withdrawal':
      return { mode: 'credit' };

    case 'adjustment_debit':
      return { mode: 'debit' };

    case 'purchase':
      return { mode: 'transfer' };

    case 'cagnotte_participation':
      return { mode: 'debit_only' };

    case 'generic':
    default:
      return { mode: 'generic' };
  }
}

function getCorrelationId(req) {
  return (
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    crypto.randomBytes(8).toString('hex')
  );
}

function ensureDbReady() {
  // 1 = connected
  const usersReady = usersConn?.readyState === 1;
  const txReady = txConn?.readyState === 1;
  return { usersReady, txReady, usersState: usersConn?.readyState, txState: txConn?.readyState };
}

/**
 * IdempotencyKey: header "Idempotency-Key" (ou "idempotency-key")
 * fallback metadata.idempotencyKey
 */
function getIdempotencyKey(req, metadata) {
  const h =
    req.headers['idempotency-key'] ||
    req.headers['Idempotency-Key'] ||
    req.headers['x-idempotency-key'] ||
    null;

  return (h && String(h).trim()) ||
    (metadata && metadata.idempotencyKey ? String(metadata.idempotencyKey).trim() : null);
}

async function createInternalTransactionDocument({
  session,
  kind,
  senderUser,
  receiverUser,
  amount,
  currencySymbol,
  country,
  reason,
  description,
  context,
  contextId,
  orderId,
  metadata,
  receiverOverrideId,
  receiverOverrideName,
  idempotencyKey,
}) {
  const now = new Date();
  const senderName = senderUser.fullName || senderUser.email;

  const receiverId = receiverOverrideId || (receiverUser ? receiverUser._id : senderUser._id);

  const receiverName =
    receiverOverrideName ||
    (receiverUser ? receiverUser.fullName || receiverUser.email : 'Système PayNoval');

  const decAmount = mongoose.Types.Decimal128.fromString(Number(amount).toFixed(2));
  const decFees = mongoose.Types.Decimal128.fromString('0.00');
  const decNet = decAmount;
  const decLocal = decAmount;
  const decExchange = mongoose.Types.Decimal128.fromString('1');

  const reference = crypto.randomBytes(8).toString('hex').toUpperCase();

  const txMetadata = Object.assign({}, metadata || {}, {
    internal: true,
    operationKind: kind,
    context: context || null,
    contextId: contextId || null,
    receiverType: receiverOverrideId ? 'vault' : 'user',
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

  const securityQuestion = `INTERNAL:${kind}`;
  const securityCode = crypto.randomBytes(8).toString('hex');

  const [tx] = await Transaction.create(
    [
      {
        reference,
        sender: senderUser._id,
        receiver: receiverId,
        amount: decAmount,
        transactionFees: decFees,
        netAmount: decNet,
        senderCurrencySymbol: sanitize(currencySymbol),
        exchangeRate: decExchange,
        localAmount: decLocal,
        localCurrencySymbol: sanitize(currencySymbol),
        senderName,
        senderEmail: senderUser.email,
        nameDestinataire: receiverName,
        recipientEmail: receiverUser ? receiverUser.email : null,
        country: sanitize(country || senderUser.country || 'Unknown'),
        securityQuestion,
        securityCode,
        destination: 'paynoval',
        funds: 'paynoval',
        status: 'confirmed',
        confirmedAt: now,
        description: description || reason || `Opération interne: ${kind}`,
        orderId: orderId || null,
        metadata: txMetadata,
        feeSnapshot: {
          kind,
          internal: true,
          appliedFees: 0,
          netAfterFees: Number(amount),
          currency: currencySymbol,
        },
        feeId: null,
        attemptCount: 0,
        lastAttemptAt: null,
        lockedUntil: null,
        archived: false,
      },
    ],
    maybeSessionOpts(session)
  );

  return tx;
}

/**
 * POST /api/v1/internal-payments
 */
exports.createInternalPayment = async (req, res, next) => {
  const correlationId = getCorrelationId(req);

  // ✅ timeout serveur (évite request infinie)
  res.setTimeout(70_000);

  // ✅ DB readiness (fail fast)
  const db = ensureDbReady();
  if (!db.usersReady || !db.txReady) {
    logger.error('[internal-payments] DB not ready', { correlationId, ...db });
    return res.status(503).json({
      success: false,
      error: 'Base de données indisponible (connexion en cours). Réessayez.',
      details: { correlationId, db },
    });
  }

  const session = await startTxSession();
  let debited = false;
  let credited = false;
  let debitUserId = null;
  let creditUserId = null;
  let debitAmount = 0;
  let creditAmount = 0;

  try {
    if (session) session.startTransaction();

    const {
      kind,
      amount,
      currencySymbol,
      fromUserId,
      toUserId,
      reason,
      description,
      country,
      context,
      contextId,
      orderId,
      metadata,
      targetVaultId,
      targetVaultName,
    } = req.body;

    const idempotencyKey = getIdempotencyKey(req, metadata);

    logger.info('[internal-payments] start', {
      correlationId,
      kind,
      amount,
      currencySymbol,
      fromUserId,
      toUserId,
      context,
      contextId,
      orderId,
      idempotencyKey,
    });

    const amt = Number(amount);
    if (!amt || Number.isNaN(amt) || amt <= 0) throw createError(400, 'Montant interne invalide.');
    if (amt > 1_000_000_000) throw createError(400, 'Montant interne trop élevé (limite de sécurité).');

    const { mode } = resolveKind(kind);
    const isLogOnly = mode === 'log-only';
    const isDebitOnly = mode === 'debit_only';

    // ✅ Idempotency
    if (idempotencyKey) {
      const existing = await Transaction.findOne({ 'metadata.idempotencyKey': idempotencyKey })
        .select('_id reference metadata sender receiver amount status confirmedAt')
        .lean()
        .session(session || null);

      if (existing) {
        if (session) await session.commitTransaction();
        if (session) session.endSession();

        logger.warn('[internal-payments] idempotent-hit', { correlationId, idempotencyKey, txId: existing._id });

        return res.status(200).json({
          success: true,
          idempotent: true,
          transactionId: String(existing._id),
          reference: existing.reference,
          kind,
          mode,
        });
      }
    }

    // 🔍 Validations selon mode
    if (mode === 'transfer') {
      if (!fromUserId || !toUserId) throw createError(400, 'fromUserId et toUserId sont requis pour un transfert interne.');
      if (String(fromUserId) === String(toUserId)) throw createError(400, 'fromUserId et toUserId ne peuvent pas être identiques.');
    }

    if (mode === 'credit' && !toUserId) throw createError(400, 'toUserId est requis pour un crédit interne (bonus, cashback).');

    if ((mode === 'debit' || isDebitOnly) && !fromUserId) throw createError(400, 'fromUserId est requis pour un débit interne.');

    if (mode === 'generic' && !fromUserId && !toUserId) {
      throw createError(400, 'Au moins fromUserId ou toUserId doit être renseigné pour une opération générique.');
    }

    // ✅ Pour cagnotte_participation, on veut un vaultId traçable (ObjectId)
    // - targetVaultId prioritaire
    // - sinon contextId si c'est un ObjectId
    const vaultIdCandidate = isDebitOnly
      ? (isValidObjectId(targetVaultId) ? String(targetVaultId) : (isValidObjectId(contextId) ? String(contextId) : null))
      : null;

    if (kind === 'cagnotte_participation' && !vaultIdCandidate) {
      throw createError(
        400,
        'Participation cagnotte: targetVaultId (ObjectId) requis (ou contextId doit être un ObjectId).'
      );
    }

    logger.info('[internal-payments] load-admin', { correlationId });

    const adminUser = await User.findOne({ email: ADMIN_EMAIL })
      .select('_id email fullName country')
      .session(session || null);

    if (!adminUser) throw createError(500, `Compte administrateur "${ADMIN_EMAIL}" introuvable.`);

    let fromUser = null;
    let toUser = null;

    if (fromUserId) {
      logger.info('[internal-payments] load-fromUser', { correlationId, fromUserId });
      fromUser = await User.findById(fromUserId).select('_id email fullName country').session(session || null);
      if (!fromUser) throw createError(404, 'Utilisateur fromUserId introuvable.');
    }

    if (toUserId) {
      logger.info('[internal-payments] load-toUser', { correlationId, toUserId });
      toUser = await User.findById(toUserId).select('_id email fullName country').session(session || null);
      if (!toUser) throw createError(404, 'Utilisateur toUserId introuvable.');
    }

    // Ajustements
    if (mode === 'credit' && !fromUser) fromUser = adminUser;
    if (mode === 'debit' && !toUser) toUser = adminUser;

    if (isDebitOnly) {
      if (!fromUser) throw createError(500, 'fromUser introuvable pour une opération debit_only.');
      toUser = null; // pas de crédit user
    }

    // 🧾 Log-only
    if (isLogOnly) {
      const sender = fromUser || adminUser;
      const receiver = adminUser;

      const tx = await createInternalTransactionDocument({
        session,
        kind,
        senderUser: sender,
        receiverUser: receiver,
        amount: amt,
        currencySymbol,
        country,
        reason,
        description,
        context,
        contextId,
        orderId,
        metadata,
        receiverOverrideId: null,
        receiverOverrideName: null,
        idempotencyKey,
      });

      if (session) await session.commitTransaction();
      if (session) session.endSession();

      return res.status(201).json({
        success: true,
        mode: 'log-only',
        transactionId: tx._id.toString(),
        reference: tx.reference,
      });
    }

    // 💰 Débit (debit, transfer, debit_only)
    if (mode === 'debit' || mode === 'transfer' || isDebitOnly) {
      const sourceUser = fromUser || adminUser;

      logger.info('[internal-payments] debit(atomique)', {
        correlationId,
        userId: String(sourceUser._id),
        amt,
      });

      await Balance.withdrawFromBalance(sourceUser._id, amt, maybeSessionOpts(session));
      debited = true;
      debitUserId = String(sourceUser._id);
      debitAmount = amt;
    }

    // ✅ Crédit (credit, transfer) – PAS pour debit_only
    if (mode === 'credit' || mode === 'transfer') {
      const targetUser = toUser || adminUser;

      logger.info('[internal-payments] credit', {
        correlationId,
        userId: String(targetUser._id),
        amt,
      });

      await Balance.addToBalance(targetUser._id, amt, maybeSessionOpts(session));
      credited = true;
      creditUserId = String(targetUser._id);
      creditAmount = amt;
    }

    const senderUser = fromUser || adminUser;
    const receiverUser = toUser || adminUser;

    // ✅ IMPORTANT : on ne met receiverOverrideId QUE si ObjectId valide
    const receiverOverrideId = isDebitOnly ? vaultIdCandidate : null;
    const receiverOverrideName = isDebitOnly
      ? (targetVaultName || (metadata && metadata.vaultName) || 'Coffre Cagnotte')
      : null;

    logger.info('[internal-payments] create-tx-doc', { correlationId, receiverOverrideId, receiverOverrideName });

    const tx = await createInternalTransactionDocument({
      session,
      kind,
      senderUser,
      receiverUser,
      amount: amt,
      currencySymbol,
      country,
      reason,
      description,
      context,
      contextId,
      orderId,
      metadata,
      receiverOverrideId,
      receiverOverrideName,
      idempotencyKey,
    });

    if (session) await session.commitTransaction();
    if (session) session.endSession();

    logger.info('[internal-payments] done', { correlationId, txId: String(tx._id), ref: tx.reference });

    return res.status(201).json({
      success: true,
      transactionId: tx._id.toString(),
      reference: tx.reference,
      kind,
      mode,
    });
  } catch (err) {
    // Rollback si transaction possible
    try {
      if (session) await session.abortTransaction();
    } catch (e) {
      logger.error('[internal-payments] rollback error', { message: e?.message || e });
    } finally {
      if (session) session.endSession();
    }

    // ✅ Compensation si on n'a PAS de transaction Mongo multi-db
    // (ex: débit fait, mais erreur ensuite)
    if (!CAN_USE_SHARED_SESSION && debited && debitUserId && debitAmount > 0) {
      try {
        logger.warn('[internal-payments] compensate(refund) after error', {
          debitUserId,
          debitAmount,
        });
        await Balance.addToBalance(debitUserId, debitAmount);
      } catch (e) {
        logger.error('[internal-payments] compensate failed', { message: e?.message || e });
      }
    }

    logger.error('[internal-payments] error', {
      correlationId,
      message: err.message,
      stack: err.stack,
    });

    return next(err);
  }
};
