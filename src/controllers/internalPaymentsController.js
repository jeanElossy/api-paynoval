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

  return (h && String(h).trim()) || (metadata && metadata.idempotencyKey ? String(metadata.idempotencyKey).trim() : null);
}

/**
 * Sessions multi-conn:
 * - si usersConn et txConn partagent le même client Mongo => transaction possible
 * - sinon => on ne passe pas de session (best effort)
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

async function startTxSession() {
  if (typeof txConn?.startSession === 'function') return txConn.startSession();
  return mongoose.startSession();
}

function maybeSessionOpts(session) {
  return CAN_USE_SHARED_SESSION && session ? { session } : {};
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

  // ✅ receiver doit rester ObjectId (schema Transaction.receiver = ObjectId)
  // On autorise receiverOverrideId uniquement si ObjectId valide, sinon fallback sur receiverUser/_admin
  const safeOverride =
    receiverOverrideId && mongoose.Types.ObjectId.isValid(String(receiverOverrideId))
      ? String(receiverOverrideId)
      : null;

  const receiverId = safeOverride || (receiverUser ? receiverUser._id : senderUser._id);

  const receiverName =
    receiverOverrideName ||
    (receiverUser
      ? receiverUser.fullName || receiverUser.email
      : 'Système PayNoval');

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
    receiverType: safeOverride ? 'vault' : 'user',
    ...(safeOverride ? { targetVaultId: safeOverride } : {}),
    ...(receiverOverrideName ? { targetVaultName: receiverOverrideName } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

  const securityQuestion = `INTERNAL:${kind}`;
  const securityCode = crypto.randomBytes(8).toString('hex');

  const [tx] = await Transaction.create(
    [
      {
        reference,
        sender: senderUser._id,
        receiver: receiverId, // ✅ toujours ObjectId string/castable
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

  res.setTimeout(70_000);

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

  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

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
      CAN_USE_SHARED_SESSION,
    });

    const amt = Number(amount);
    if (!amt || Number.isNaN(amt) || amt <= 0) {
      throw createError(400, 'Montant interne invalide.');
    }
    if (amt > 1_000_000_000) {
      throw createError(400, 'Montant interne trop élevé (limite de sécurité).');
    }

    const { mode } = resolveKind(kind);
    const isDebitOnly = mode === 'debit_only';

    const sessOpts = maybeSessionOpts(session);

    // ✅ Idempotency
    if (idempotencyKey) {
      const existing = await Transaction.findOne({ 'metadata.idempotencyKey': idempotencyKey })
        .select('_id reference metadata sender receiver amount status confirmedAt')
        .lean()
        .session(sessOpts.session || null);

      if (existing) {
        if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
        session.endSession();

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

    // Validations selon mode
    if (mode === 'transfer') {
      if (!fromUserId || !toUserId) {
        throw createError(400, 'fromUserId et toUserId sont requis pour un transfert interne.');
      }
      if (String(fromUserId) === String(toUserId)) {
        throw createError(400, 'fromUserId et toUserId ne peuvent pas être identiques.');
      }
    }

    if (mode === 'credit' && !toUserId) {
      throw createError(400, 'toUserId est requis pour un crédit interne (bonus, cashback).');
    }

    if ((mode === 'debit' || isDebitOnly) && !fromUserId) {
      throw createError(400, 'fromUserId est requis pour un débit interne.');
    }

    if (mode === 'generic' && !fromUserId && !toUserId) {
      throw createError(400, 'Au moins fromUserId ou toUserId doit être renseigné pour une opération générique.');
    }

    const adminUser = await User.findOne({ email: ADMIN_EMAIL })
      .select('_id email fullName country')
      .session(sessOpts.session || null);

    if (!adminUser) {
      throw createError(500, `Compte administrateur "${ADMIN_EMAIL}" introuvable.`);
    }

    let fromUser = null;
    let toUser = null;

    if (fromUserId) {
      fromUser = await User.findById(fromUserId)
        .select('_id email fullName country')
        .session(sessOpts.session || null);
      if (!fromUser) throw createError(404, 'Utilisateur fromUserId introuvable.');
    }

    if (toUserId) {
      toUser = await User.findById(toUserId)
        .select('_id email fullName country')
        .session(sessOpts.session || null);
      if (!toUser) throw createError(404, 'Utilisateur toUserId introuvable.');
    }

    // Ajustements selon mode
    if (mode === 'credit' && !fromUser) fromUser = adminUser;
    if (mode === 'debit' && !toUser) toUser = adminUser;

    if (isDebitOnly) {
      if (!fromUser) throw createError(500, 'fromUser introuvable pour une opération debit_only.');
      toUser = null;
    }

    // 💰 Débit (debit, transfer, debit_only)
    if (mode === 'debit' || mode === 'transfer' || isDebitOnly) {
      const sourceUser = fromUser || adminUser;

      const balanceFrom = await Balance.findOne({ user: sourceUser._id })
        .session(sessOpts.session || null);

      const currentBalance = balanceFrom ? parseFloat(balanceFrom.amount.toString()) : 0;
      if (currentBalance < amt) throw createError(400, 'Solde insuffisant pour l’opération interne.');

      const updatedFrom = await Balance.findOneAndUpdate(
        { user: sourceUser._id },
        { $inc: { amount: -amt } },
        { new: true, upsert: true, ...sessOpts }
      );

      if (!updatedFrom) throw createError(500, 'Erreur lors du débit du compte interne.');
    }

    // ✅ Crédit (credit, transfer) – PAS pour debit_only
    if (mode === 'credit' || mode === 'transfer') {
      const targetUser = toUser || adminUser;

      const updatedTo = await Balance.findOneAndUpdate(
        { user: targetUser._id },
        { $inc: { amount: amt } },
        { new: true, upsert: true, ...sessOpts }
      );

      if (!updatedTo) throw createError(500, 'Erreur lors du crédit du compte interne.');
    }

    const senderUser = fromUser || adminUser;
    const receiverUser = toUser || adminUser;

    // ✅ vault receiver override safe: seulement targetVaultId (MongoId), JAMAIS contextId libre
    const receiverOverrideId =
      isDebitOnly && targetVaultId && mongoose.Types.ObjectId.isValid(String(targetVaultId))
        ? String(targetVaultId)
        : null;

    const receiverOverrideName = isDebitOnly
      ? (targetVaultName || (metadata && metadata.vaultName) || 'Coffre Cagnotte')
      : null;

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

    if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
    session.endSession();

    return res.status(201).json({
      success: true,
      transactionId: tx._id.toString(),
      reference: tx.reference,
      kind,
      mode,
    });
  } catch (err) {
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
      session.endSession();
    } catch (e) {
      logger.error('[internal-payments] rollback error', { message: e?.message || e });
    }

    logger.error('[internal-payments] error', {
      correlationId,
      message: err.message,
      stack: err.stack,
    });

    return next(err);
  }
};
