// src/controllers/transactionController.js
const mongoose = require('mongoose');
const createError = require('http-errors');
const { Expo } = require('expo-server-sdk');
const expo = new Expo();

const Transaction = require('../models/Transaction');
const User        = require('../models/User');
const Outbox      = require('../models/Outbox');
const { sendEmail } = require('../utils/mail');
const {
  initiatedTemplate,
  confirmedTemplate,
  cancelledTemplate
} = require('../utils/emailTemplates');

// Helper to sanitize strings
const sanitize = text =>
  text
    .toString()
    .replace(/[<>\\/{};]/g, '')
    .trim();

async function notifyParties(tx, status, session) {
  // Fetch sender and receiver
  const [sender, receiver] = await Promise.all([
    User.findById(tx.sender)
      .select('email pushToken')
      .session(session),
    User.findById(tx.receiver)
      .select('email pushToken')
      .session(session)
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
    amount:        tx.amount.toString(),
    senderEmail:   sender?.email || '',
    receiverEmail: receiver?.email || '',
    date:          new Date().toLocaleString('fr-FR')
  };

  // Send HTML emails
  for (const userObj of [sender, receiver]) {
    if (userObj?.email) {
      const html = templateMap[status](commonData);
      await sendEmail({ to: userObj.email, subject, html });
    }
  }

  // Prepare push notifications
  const messages = [];
  for (const userObj of [sender, receiver]) {
    if (userObj?.pushToken && Expo.isExpoPushToken(userObj.pushToken)) {
      messages.push({
        to:    userObj.pushToken,
        sound: 'default',
        title: subject,
        body:  `Montant : ${commonData.amount} €`,
        data:  { transactionId: commonData.transactionId, status }
      });
    }
  }
  // Send in chunks
  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (pushErr) {
      console.error('Erreur Expo push :', pushErr);
    }
  }

  // In-app notifications via Outbox
  const events = [sender, receiver]
    .filter(u => u)
    .map(u => ({
      service: 'notifications',
      event:   'notification.created',
      payload: {
        userId: u._id,
        type:   `transaction_${status}`,
        data:   commonData
      }
    }));
  if (events.length) {
    await Outbox.insertMany(events, { session });
  }
}

// Initiate a new transaction
exports.initiateController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const { toEmail, amount, description } = req.body;
    const senderId = req.user.id;

    // Find receiver by email
    const receiver = await User.findOne({ email: sanitize(toEmail) })
      .session(session);
    if (!receiver) throw createError(404, 'Destinataire introuvable');

    if (receiver._id.toString() === senderId) {
      throw createError(400, 'Impossible de transférer vers votre propre compte');
    }

    const decAmount = mongoose.Types.Decimal128.fromString(
      parseFloat(amount).toFixed(2)
    );

    // Check sender balance
    const sender = await User.findById(senderId).session(session);
    if (!sender) throw createError(404, 'Expéditeur introuvable');
    if (sender.balance.lessThan(decAmount)) {
      throw createError(400, 'Solde insuffisant');
    }

    // Create transaction
    const token = Transaction.generateVerificationToken();
    const [tx] = await Transaction.create(
      [{
        sender:            senderId,
        receiver:          receiver._id,
        amount:            decAmount,
        verificationToken: token,
        description:       sanitize(description)
      }],
      { session }
    );

    // Notify parties
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

// Confirm an existing transaction
exports.confirmController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const { transactionId, token } = req.body;
    const tx = await Transaction.findById(transactionId)
      .select('+verificationToken')
      .session(session);
    if (!tx || tx.status !== 'pending') {
      throw createError(400, 'Transaction invalide ou déjà traitée');
    }

    if (!tx.verifyToken(sanitize(token))) {
      await notifyParties(tx, 'cancelled', session);
      throw createError(401, 'Code de confirmation incorrect');
    }

    const decAmount = tx.amount;

    // Debit sender
    const sender = await User.findOneAndUpdate(
      { _id: tx.sender, balance: { $gte: decAmount } },
      { $inc: { balance: mongoose.Types.Decimal128.fromString(`-${decAmount.toString()}`) } },
      { new: true, session }
    );
    if (!sender) {
      await notifyParties(tx, 'cancelled', session);
      throw createError(400, 'Solde insuffisant ou expéditeur introuvable');
    }

    // Credit receiver
    const receiver = await User.findByIdAndUpdate(
      tx.receiver,
      { $inc: { balance: decAmount } },
      { new: true, session }
    );
    if (!receiver) {
      await notifyParties(tx, 'cancelled', session);
      throw createError(404, 'Destinataire introuvable');
    }

    tx.status      = 'confirmed';
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
