// src/controllers/transactionController.js
const mongoose     = require('mongoose');
const createError  = require('http-errors');
const { Expo }     = require('expo-server-sdk');
const expo          = new Expo();

const Transaction   = require('../models/Transaction');
const User          = require('../models/User');
const Outbox        = require('../models/Outbox');
const { sendEmail } = require('../utils/mail');
const {
  initiatedTemplate,
  confirmedTemplate,
  cancelledTemplate
} = require('../utils/emailTemplates');

/**
 * Envoie notifications email, push (Expo) et in-app aux deux parties
 */
async function notifyParties(tx, status, session) {
  // Récupération des users
  const [sender, receiver] = await Promise.all([
    User.findById(tx.sender).select('email expoPushToken').session(session),
    User.findById(tx.receiver).select('email expoPushToken').session(session)
  ]);

  const subjectMap = {
    initiated: 'Transaction initiée',
    confirmed: 'Transaction confirmée',
    cancelled: 'Transaction annulée'
  };
  const templateMap = {
    initiated: initiatedTemplate,
    confirmed: confirmedTemplate,
    cancelled: cancelledTemplate
  };
  const subject = subjectMap[status];

  const commonData = {
    transactionId: tx._id.toString(),
    amount: tx.amount.toString(),
    senderEmail: sender?.email || '',
    receiverEmail: receiver?.email || '',
    date: new Date().toLocaleString('fr-FR')
  };

  // Emails
  for (const u of [sender, receiver]) {
    if (u?.email) {
      const html = templateMap[status](commonData);
      await sendEmail({ to: u.email, subject, html });
    }
  }

  // Push Expo
  const messages = [];
  for (const u of [sender, receiver]) {
    if (u?.expoPushToken && Expo.isExpoPushToken(u.expoPushToken)) {
      messages.push({
        to: u.expoPushToken,
        sound: 'default',
        title: subject,
        body: `Montant : ${commonData.amount} €`,
        data: { transactionId: commonData.transactionId, status }
      });
    }
  }
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      console.log('Push receipts :', receipts);
    } catch (err) {
      console.error('Erreur Expo push :', err);
    }
  }

  // Notifications in-app via Outbox
  const events = [sender, receiver]
    .filter(u => u)
    .map(u => ({
      service: 'notifications',
      event: 'notification.created',
      payload: {
        userId: u._id,
        type: `transaction_${status}`,
        data: commonData
      }
    }));
  if (events.length) {
    await Outbox.insertMany(events, { session });
  }
}

/**
 * Démarre une transaction interne
 */
exports.initiateTransaction = async (req, res, next) => {
  const { receiver, amount } = req.body;
  const senderId = req.user.id;
  if (receiver === senderId) {
    return next(createError(400, 'Vous ne pouvez pas transférer vers votre propre compte'));
  }
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const sender = await User.findById(senderId).session(session);
    if (!sender) throw createError(404, 'Expéditeur introuvable');
    const decAmount = mongoose.Types.Decimal128.fromString(amount.toString());
    if (sender.balance.lessThan(decAmount)) {
      throw createError(400, 'Solde insuffisant');
    }
    const token = Transaction.generateVerificationToken();
    const [tx] = await Transaction.create([
      { sender: senderId, receiver, amount: decAmount, verificationToken: token }
    ], { session });
    await notifyParties(tx, 'initiated', session);
    await session.commitTransaction();
    return res.status(201).json({ success: true, transactionId: tx._id });
  } catch (err) {
    await session.abortTransaction();
    return next(err);
  } finally {
    session.endSession();
  }
};

/**
 * Confirme une transaction existante
 */
exports.confirmTransaction = async (req, res, next) => {
  const { transactionId, token } = req.body;
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const tx = await Transaction.findById(transactionId)
      .session(session)
      .select('+verificationToken');
    if (!tx || tx.status !== 'pending') {
      throw createError(400, 'Transaction invalide ou déjà traitée');
    }
    if (!tx.verifyToken(token)) {
      await notifyParties(tx, 'cancelled', session);
      throw createError(401, 'Code de confirmation incorrect');
    }
    const decAmount = tx.amount;
    const sender = await User.findOneAndUpdate(
      { _id: tx.sender, balance: { $gte: decAmount } },
      { $inc: { balance: mongoose.Types.Decimal128.fromString(`-${decAmount.toString()}`) } },
      { session, new: true }
    );
    if (!sender) {
      await notifyParties(tx, 'cancelled', session);
      throw createError(400, 'Solde insuffisant ou expéditeur introuvable');
    }
    const receiver = await User.findByIdAndUpdate(
      tx.receiver,
      { $inc: { balance: decAmount } },
      { session, new: true }
    );
    if (!receiver) {
      await notifyParties(tx, 'cancelled', session);
      throw createError(404, 'Destinataire introuvable');
    }
    tx.status = 'confirmed';
    tx.confirmedAt = new Date();
    await tx.save({ session });
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
