// src/controllers/transactionController.js
const mongoose   = require('mongoose');
const createError = require('http-errors');
const { Expo }   = require('expo-server-sdk');
const expo        = new Expo();

// On récupère la connexion transactions sans l'initialiser trop tôt
const db = require('../config/db');
function getTransactionModel() {
  if (!db.txConn) {
    throw new Error('Transactions DB non initialisée');
  }
  return db.txConn.model('Transaction');
}

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

/**
 * Notify both sender and receiver via email, push and in-app
 */
async function notifyParties(tx, status, session) {
  const Transaction = getTransactionModel();

  const [sender, receiver] = await Promise.all([
    User.findById(tx.sender).select('email pushToken').session(session),
    User.findById(tx.receiver).select('email pushToken').session(session)
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
  const subject    = subjectMap[status];
  const templateFn = templateMap[status];
  if (typeof templateFn !== 'function') {
    console.error(`Pas de template pour le status: ${status}`);
    return;
  }

  const commonData = {
    transactionId: tx._id.toString(),
    amount:        tx.amount.toString(),
    senderEmail:   sender?.email || '',
    receiverEmail: receiver?.email || '',
    date:          new Date().toLocaleString('fr-FR'),
    token:         tx.verificationToken,
    confirmLink:   `myapp://confirm/${tx._id}?token=${tx.verificationToken}`
  };

  // Emails
  for (const userObj of [sender, receiver]) {
    if (userObj?.email) {
      const html = templateFn(commonData);
      await sendEmail({ to: userObj.email, subject, html });
    }
  }

  // Push
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
  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      console.error('Erreur Expo push :', err);
    }
  }

  // In-app
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

/**
 * Initiate a new transaction
 */
exports.initiateController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const Transaction = getTransactionModel();

    const { toEmail, amount, description, transactionFees } = req.body;
    const senderId = req.user.id;

    // Receiver
    const receiver = await User.findOne({ email: sanitize(toEmail) }).session(session);
    if (!receiver) throw createError(404, 'Destinataire introuvable');
    if (receiver._id.toString() === senderId) {
      throw createError(400, 'Impossible de transférer vers votre propre compte');
    }

    // Montants
    const amountFloat = parseFloat(amount);
    const feesFloat   = parseFloat(transactionFees) || 0;
    if (isNaN(amountFloat) || amountFloat <= 0) throw createError(400, 'Montant invalide');
    if (isNaN(feesFloat)   || feesFloat < 0)   throw createError(400, 'Frais invalides');

    const totalDebitFloat = amountFloat + feesFloat;
    const decAmount = mongoose.Types.Decimal128.fromString(amountFloat.toFixed(2));
    const decFees   = mongoose.Types.Decimal128.fromString(feesFloat.toFixed(2));

    // Sender
    const sender = await User.findById(senderId).session(session);
    if (!sender) throw createError(404, 'Expéditeur introuvable');
    const currentBalance = parseFloat(sender.balance.toString());
    if (currentBalance < totalDebitFloat) {
      throw createError(400, 'Solde insuffisant');
    }

    // Create
    const token = Transaction.generateVerificationToken();
    const [tx] = await Transaction.create([{
      sender, receiver: receiver._id,
      amount: decAmount, transactionFees: decFees,
      verificationToken: token,
      description: sanitize(description)
    }], { session });

    // Notify
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
 * Confirm an existing transaction
 */
exports.confirmController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const Transaction = getTransactionModel();

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
    const sender = await User.findOneAndUpdate(
      { _id: tx.sender, balance: { $gte: decAmount } },
      { $inc: { balance: mongoose.Types.Decimal128.fromString(`-${decAmount.toString()}`) } },
      { new: true, session }
    );
    if (!sender) {
      await notifyParties(tx, 'cancelled', session);
      throw createError(400, 'Solde insuffisant ou expéditeur introuvable');
    }

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
