// src/controllers/transactionController.js
const mongoose = require('mongoose');
const createError = require('http-errors');

const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Outbox = require('../models/Outbox');
const { sendEmail } = require('../utils/mail');

/**
 * Envoie un email et une notification in-app aux deux parties
 * @param {Object} tx - Document transaction
 * @param {String} status - Nouveau statut (initiated, confirmed, cancelled)
 * @param {Object} session - Session mongoose pour atomicité
 */
async function notifyParties(tx, status, session) {
  // Charger les utilisateurs
  const [sender, receiver] = await Promise.all([
    User.findById(tx.sender).select('email').session(session),
    User.findById(tx.receiver).select('email').session(session)
  ]);

  const subjectMap = {
    initiated: 'Transaction initiée',
    confirmed: 'Transaction confirmée',
    cancelled: 'Transaction annulée'
  };
  const templateMap = {
    initiated: u => `Transaction de ${u.amount} initiée entre ${tx.sender} et ${tx.receiver}.`,
    confirmed: u => `Transaction de ${u.amount} confirmée entre ${tx.sender} et ${tx.receiver}.`,
    cancelled: u => `Transaction de ${u.amount} annulée entre ${tx.sender} et ${tx.receiver}.`
  };

  // Envoyer emails
  if (sender?.email) {
    await sendEmail(
      sender.email,
      subjectMap[status],
      templateMap[status]({ amount: tx.amount.toString() })
    );
  }
  if (receiver?.email) {
    await sendEmail(
      receiver.email,
      subjectMap[status],
      templateMap[status]({ amount: tx.amount.toString() })
    );
  }

  // Créer notifications in-app via Outbox
  const notifPayloads = [sender, receiver]
    .filter(u => u)
    .map(u => ({
      service: 'notifications',
      event: 'notification.created',
      payload: {
        userId: u._id,
        type: `transaction_${status}`,
        data: { transactionId: tx._id, amount: tx.amount.toString(), status }
      }
    }));
  if (notifPayloads.length) {
    await Outbox.create(notifPayloads, { session });
  }
}

/**
 * Démarre une transaction interne entre deux utilisateurs PayNoval.
 */
exports.initiateTransaction = async (req, res, next) => {
  const { receiver, amount } = req.body;
  const senderId = req.user.id;

  if (receiver === senderId) {
    return next(createError(400, "Vous ne pouvez pas transférer vers votre propre compte"));
  }

  const session = await mongoose.startSession();
  try {
    await session.startTransaction();

    const sender = await User.findById(senderId).session(session);
    if (!sender) throw createError(404, "Compte expéditeur introuvable");

    const montantDecimal = mongoose.Types.Decimal128.fromString(amount.toString());
    if (sender.balance.lessThan(montantDecimal)) {
      throw createError(400, "Solde insuffisant");
    }

    const token = Transaction.generateVerificationToken();
    const [tx] = await Transaction.create([
      { sender: senderId, receiver, amount: montantDecimal, verificationToken: token }
    ], { session });

    // Notification pour statut 'initiated'
    await notifyParties(tx, 'initiated', session);

    await session.commitTransaction();
    return res.status(201).json({ transactionId: tx._id });
  } catch (err) {
    await session.abortTransaction();
    return next(err);
  } finally {
    session.endSession();
  }
};

/**
 * Confirme une transaction en attente avec le token fourni.
 */
exports.confirmTransaction = async (req, res, next) => {
  const { transactionId, token } = req.body;
  const session = await mongoose.startSession();

  try {
    await session.startTransaction();

    const tx = await Transaction.findById(transactionId)
      .session(session)
      .select('+verificationToken');
    if (!tx || tx.status !== 'pending') {
      throw createError(400, "Transaction non valide ou déjà traitée");
    }
    if (!tx.verifyToken(token)) {
      // Notifier échec
      await notifyParties(tx, 'cancelled', session);
      throw createError(401, "Code de confirmation incorrect");
    }

    const amount = tx.amount;
    const sender = await User.findOneAndUpdate(
      { _id: tx.sender, balance: { $gte: amount } },
      { $inc: { balance: mongoose.Types.Decimal128.fromString(`-${amount.toString()}`) } },
      { session, new: true }
    );
    if (!sender) {
      await notifyParties(tx, 'cancelled', session);
      throw createError(400, "Solde insuffisant ou compte expéditeur introuvable");
    }

    const receiver = await User.findByIdAndUpdate(
      tx.receiver,
      { $inc: { balance: amount } },
      { session, new: true }
    );
    if (!receiver) {
      await notifyParties(tx, 'cancelled', session);
      throw createError(404, "Compte destinataire introuvable");
    }

    tx.status = 'confirmed';
    tx.confirmedAt = new Date();
    await tx.save({ session });

    // Notification pour statut 'confirmed'
    await notifyParties(tx, 'confirmed', session);

    await session.commitTransaction();
    return res.json({ success: true });
  } catch (err) {
    await session.abortTransaction();
    return next(err);
  } finally {
    session.endSession();
  }
};
