// File: src/controllers/internalPaymentsController.js
'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const createError = require('http-errors');

const { getUsersConn, getTxConn } = require('../config/db');
const config = require('../config');
const logger = require('../utils/logger');

const User = require('../models/User')(getUsersConn());
const Balance = require('../models/Balance')(getUsersConn());
const Transaction = require('../models/Transaction')(getTxConn());

const sanitize = (text) =>
  String(text || '').replace(/[<>\\/{};]/g, '').trim();

const ADMIN_EMAIL = config.adminEmail || 'admin@paynoval.com';

/**
 * Détermine le "mode" d'une opération interne.
 *
 * - credit       : crédit wallet uniquement (bonus, cashback, etc.)
 * - debit        : débit wallet + crédit admin (ajustement négatif)
 * - transfer     : fromUser -> toUser
 * - debit_only   : débit wallet uniquement (ex: cagnotte_participation → vault géré ailleurs)
 * - log-only     : aucune écriture sur les balances, juste un log Transaction
 * - generic      : opérations particulières gérées au cas par cas
 */
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
      // 💡 Participation cagnotte :
      // - on DÉBITE le wallet du participant (fromUserId)
      // - le CRÉDIT du coffre (Vault) est géré dans le backend principal (cagnottes)
      //   mais on trace le vault comme "receiver" dans Transaction.
      return { mode: 'debit_only' };

    case 'generic':
    default:
      return { mode: 'generic' };
  }
}

/**
 * Création d’une Transaction interne (log) avec possibilité de forcer
 * le receiver (ID + nom) pour les cas "vault".
 */
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
}) {
  const now = new Date();
  const senderName = senderUser.fullName || senderUser.email;

  const receiverId =
    receiverOverrideId ||
    (receiverUser ? receiverUser._id : senderUser._id);

  const receiverName =
    receiverOverrideName ||
    (receiverUser
      ? receiverUser.fullName || receiverUser.email
      : 'Système PayNoval');

  const decAmount = mongoose.Types.Decimal128.fromString(
    Number(amount).toFixed(2)
  );
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
        // Pour un vault, pas d'email spécifique
        recipientEmail: receiverUser ? receiverUser.email : null,
        country: sanitize(country || senderUser.country || 'Unknown'),
        securityQuestion,
        securityCode,
        destination: 'paynoval',
        funds: 'paynoval',
        status: 'confirmed',
        confirmedAt: now,
        description:
          description || reason || `Opération interne: ${kind}`,
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
    { session }
  );

  return tx;
}

/**
 * POST /api/v1/internal-payments
 */
exports.createInternalPayment = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

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

    const amt = Number(amount);
    if (!amt || Number.isNaN(amt) || amt <= 0) {
      throw createError(400, 'Montant interne invalide.');
    }
    if (amt > 1_000_000_000) {
      throw createError(
        400,
        'Montant interne trop élevé (limite de sécurité).'
      );
    }

    const { mode } = resolveKind(kind);
    const isLogOnly = mode === 'log-only';
    const isDebitOnly = mode === 'debit_only';

    // 🔍 Règles de validation selon le mode
    if (mode === 'transfer') {
      if (!fromUserId || !toUserId) {
        throw createError(
          400,
          'fromUserId et toUserId sont requis pour un transfert interne.'
        );
      }
      if (String(fromUserId) === String(toUserId)) {
        throw createError(
          400,
          'fromUserId et toUserId ne peuvent pas être identiques.'
        );
      }
    }

    if (mode === 'credit' && !toUserId) {
      throw createError(
        400,
        'toUserId est requis pour un crédit interne (bonus, cashback).'
      );
    }

    if ((mode === 'debit' || isDebitOnly) && !fromUserId) {
      throw createError(
        400,
        'fromUserId est requis pour un débit interne.'
      );
    }

    if (mode === 'generic' && !fromUserId && !toUserId) {
      throw createError(
        400,
        'Au moins fromUserId ou toUserId doit être renseigné pour une opération générique.'
      );
    }

    // 👤 Admin "technique"
    const adminUser = await User.findOne({ email: ADMIN_EMAIL })
      .select('_id email fullName country')
      .session(session);

    if (!adminUser) {
      throw createError(
        500,
        `Compte administrateur "${ADMIN_EMAIL}" introuvable.`
      );
    }

    // 👤 Chargement des users
    let fromUser = null;
    let toUser = null;

    if (fromUserId) {
      fromUser = await User.findById(fromUserId)
        .select('_id email fullName country')
        .session(session);
      if (!fromUser) {
        throw createError(404, 'Utilisateur fromUserId introuvable.');
      }
    }

    if (toUserId) {
      toUser = await User.findById(toUserId)
        .select('_id email fullName country')
        .session(session);
      if (!toUser) {
        throw createError(404, 'Utilisateur toUserId introuvable.');
      }
    }

    // Ajustements de rôles selon le mode
    if (mode === 'credit' && !fromUser) {
      fromUser = adminUser;
    }

    if (mode === 'debit' && !toUser) {
      // Pour un "débit classique" on crédite l'admin
      toUser = adminUser;
    }

    if (isDebitOnly) {
      // 💡 cas cagnotte_participation :
      // - fromUser = participant (obligatoire)
      // - pas de crédit sur Balance
      if (!fromUser) {
        throw createError(
          500,
          'fromUser introuvable pour une opération debit_only.'
        );
      }
      // Ici on NE change pas toUser (il peut rester null),
      // car le receiver sera overridé par le vault.
      toUser = null;
    }

    // 🧾 Mode "log-only" (pour compat, pas utilisé pour cagnotte_participation)
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
      });

      await session.commitTransaction();
      session.endSession();

      return res.status(201).json({
        success: true,
        mode: 'log-only',
        transactionId: tx._id.toString(),
        reference: tx.reference,
      });
    }

    // 💰 Mouvements de solde
    // Débit (debit, transfer, debit_only)
    if (mode === 'debit' || mode === 'transfer' || isDebitOnly) {
      const sourceUser = fromUser || adminUser;

      const balanceFrom = await Balance.findOne({ user: sourceUser._id })
        .session(session);

      const currentBalance = balanceFrom
        ? parseFloat(balanceFrom.amount.toString())
        : 0;

      if (currentBalance < amt) {
        throw createError(
          400,
          'Solde insuffisant pour l’opération interne.'
        );
      }

      const updatedFrom = await Balance.findOneAndUpdate(
        { user: sourceUser._id },
        { $inc: { amount: -amt } },
        { new: true, upsert: true, session }
      );

      if (!updatedFrom) {
        throw createError(500, 'Erreur lors du débit du compte interne.');
      }
    }

    // Crédit (credit, transfer) – ⚠️ PAS pour debit_only
    if (mode === 'credit' || mode === 'transfer') {
      const targetUser = toUser || adminUser;

      const updatedTo = await Balance.findOneAndUpdate(
        { user: targetUser._id },
        { $inc: { amount: amt } },
        { new: true, upsert: true, session }
      );

      if (!updatedTo) {
        throw createError(500, 'Erreur lors du crédit du compte interne.');
      }
    }

    // 🧾 Transaction interne pour l’historique
    const senderUser = fromUser || adminUser;
    const receiverUser = toUser || adminUser;

    // 🎯 Override receiver quand c'est une participation cagnotte
    const receiverOverrideId = isDebitOnly
      ? targetVaultId || contextId || null
      : null;

    const receiverOverrideName = isDebitOnly
      ? targetVaultName ||
        (metadata && metadata.vaultName) ||
        'Coffre Cagnotte'
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
    });

    await session.commitTransaction();
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
      await session.abortTransaction();
      session.endSession();
    } catch (e) {
      logger.error('[internal-payments] rollback error:', e);
    }
    return next(err);
  }
};
