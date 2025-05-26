// src/controllers/transactionsController.js

const mongoose      = require('mongoose');
const createError   = require('http-errors');
const { Expo }      = require('expo-server-sdk');
const expo          = new Expo();

const { getTxConn } = require('../config/db');
const Transaction   = () => getTxConn().model('Transaction');
const logger        = require('../utils/logger');

const User         = require('../models/User');
const Outbox       = require('../models/Outbox');
const Notification = require('../models/Notification');
const { sendEmail } = require('../utils/mail');
const {
  initiatedSenderTemplate,
  initiatedReceiverTemplate,
  confirmedSenderTemplate,
  confirmedReceiverTemplate,
  cancelledSenderTemplate,
  cancelledReceiverTemplate
} = require('../utils/emailTemplates');

const sanitize = text =>
  text.toString().replace(/[<>\\/{};]/g, '').trim();

/**
 * Notifications email, push & in-app
 * @param {Document} tx - Transaction Mongoose document
 * @param {string} status - 'initiated' | 'confirmed' | 'cancelled'
 * @param {ClientSession} session - Mongoose session
 * @param {string} senderCurrency - symbole de la devise de l'expéditeur
 */

async function notifyParties(tx, status, session, senderCurrency) {
  // 1) Récupération de l’expéditeur (profil principal) et du destinataire (DB Transactions)
  const sender = await User.findById(tx.sender)
    .select('email pushToken firstName lastName')
    .session(session);
  const receiver = await User.findById(tx.receiver)
    .select('email pushToken')
    .session(session);

  // 2) Préparer la date et les liens de confirmation
  const commonDate = new Date().toLocaleString('fr-FR');
  const confirmLinkMobile = `panoval://confirm/${tx._id}?token=${tx.verificationToken}`;
  const confirmLinkWeb    = `https://panoval.com/confirm/${tx._id}?token=${tx.verificationToken}`;

  // 3) Construire le nom complet de l’expéditeur
  const fullNameSender = [sender.firstName, sender.lastName]
    .filter(Boolean)
    .join(' ');

  // 4) Préparer les données spécifiques à chaque partie
  const dataSender = {
    transactionId: tx._id.toString(),
    amount:        tx.amount.toString(),
    currency:      senderCurrency,
    name:          fullNameSender,
    date:          commonDate
  };

  const dataReceiver = {
    transactionId: tx._id.toString(),
    amount:        tx.localAmount.toString(),
    currency:      tx.localCurrencySymbol,
    name:          tx.nameDestinataire,
    senderEmail:   sender.email,
    date:          commonDate,
    confirmLink:   confirmLinkMobile
  };

  // 5) Envoi des emails
  if (sender.email) {
    let htmlSender;
    switch (status) {
      case 'initiated':
        htmlSender = initiatedSenderTemplate(dataSender);
        break;
      case 'confirmed':
        htmlSender = confirmedSenderTemplate(dataSender);
        break;
      case 'cancelled':
        htmlSender = cancelledSenderTemplate({ ...dataSender, reason: tx.cancelReason });
        break;
    }
    await sendEmail({
      to:      sender.email,
      subject: `Transaction ${status}`,
      html:    htmlSender
    });
  }

  if (receiver.email) {
    let htmlReceiver;
    switch (status) {
      case 'initiated':
        htmlReceiver = initiatedReceiverTemplate(dataReceiver);
        break;
      case 'confirmed':
        htmlReceiver = confirmedReceiverTemplate(dataReceiver);
        break;
      case 'cancelled':
        htmlReceiver = cancelledReceiverTemplate({ ...dataReceiver, reason: tx.cancelReason });
        break;
    }
    await sendEmail({
      to:      receiver.email,
      subject: `Transaction ${status}`,
      html:    htmlReceiver
    });
  }

  // 6) Push notifications via Expo
  const messages = [sender, receiver].reduce((acc, user) => {
    const isSender = user._id.equals(sender._id);
    const payload  = isSender ? dataSender : dataReceiver;
    if (user.pushToken && Expo.isExpoPushToken(user.pushToken)) {
      acc.push({
        to:    user.pushToken,
        sound: 'default',
        title: `Transaction ${status}`,
        body:  `Montant : ${payload.amount} ${payload.currency}`,
        data:  payload
      });
    }
    return acc;
  }, []);
  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      logger.error('Expo push error:', err);
    }
  }

  // 7) Notifications in-app via Outbox & Notification
  const events = [sender, receiver].map(user => {
    const payload = user._id.equals(sender._id) ? dataSender : dataReceiver;
    return {
      service: 'notifications',
      event:   `transaction_${status}`,
      payload: { userId: user._id, type: `transaction_${status}`, data: payload }
    };
  });

  await Outbox.insertMany(events, { session });
  const inAppDocs = events.map(e => ({
    recipient: e.payload.userId,
    type:      e.payload.type,
    data:      e.payload.data,
    read:      false
  }));
  await Notification.insertMany(inAppDocs, { session });
}


/** POST /transactions/initiate */
exports.initiateController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const {
      toEmail,
      amount,
      description,
      transactionFees,
      localAmount,
      localCurrencySymbol,
      recipientInfo,
      senderCurrencySymbol
    } = req.body;
    const senderId = req.user.id;

    const receiver = await User.findOne({ email: sanitize(toEmail) }).session(session);
    if (!receiver) throw createError(404, 'Destinataire introuvable');
    if (receiver._id.toString() === senderId) throw createError(400, 'Auto-transfert impossible');

    const amt  = parseFloat(amount);
    const fees = parseFloat(transactionFees) || 0;
    if (isNaN(amt) || amt <= 0) throw createError(400, 'Montant invalide');

    const sender = await User.findById(senderId).select('balance firstName').session(session);
    if (!sender) throw createError(404, 'Expéditeur introuvable');

    const balFloat = parseFloat(sender.balance.toString());
    if (balFloat < amt + fees) throw createError(400, `Solde insuffisant : ${balFloat.toFixed(2)} disponible`);

    const decAmt      = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
    const decFees     = mongoose.Types.Decimal128.fromString(fees.toFixed(2));
    const decLocalAmt = mongoose.Types.Decimal128.fromString(localAmount.toFixed(2));
    const token       = Transaction().generateVerificationToken();
    const nameDest    = sanitize(recipientInfo.name) || receiver.firstName;

    const [tx] = await Transaction().create([{ sender: sender._id, receiver: receiver._id, amount: decAmt, transactionFees: decFees, localAmount: decLocalAmt, localCurrencySymbol, nameDestinataire: nameDest, verificationToken: token, description: sanitize(description) }], { session });

    await notifyParties(tx, 'initiated', session, senderCurrencySymbol);
    await session.commitTransaction();
    res.status(201).json({ success: true, transactionId: tx._id, verificationToken: token });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

/** POST /transactions/confirm */
exports.confirmController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { transactionId, token, senderCurrencySymbol } = req.body;
    const tx = await Transaction().findById(transactionId)
      .select('+verificationToken +transactionFees +localCurrencySymbol +nameDestinataire +localAmount')
      .session(session);

    if (!tx || tx.status !== 'pending') throw createError(400, 'Transaction invalide ou déjà traitée');
    if (!tx.verifyToken(sanitize(token))) {
      await notifyParties(tx, 'cancelled', session, senderCurrencySymbol);
      throw createError(401, 'Code de confirmation incorrect');
    }

    const amtFloat  = parseFloat(tx.amount.toString());
    const feesFloat = parseFloat(tx.transactionFees.toString());
    const totalDebit = amtFloat + feesFloat;

    const sender = await User.findOneAndUpdate({ _id: tx.sender, balance: { $gte: totalDebit } }, { $inc: { balance: mongoose.Types.Decimal128.fromString(`-${totalDebit.toFixed(2)}`) } }, { new: true, session });
    if (!sender) { await notifyParties(tx, 'cancelled', session, senderCurrencySymbol); throw createError(400, 'Solde insuffisant'); }

    const receiver = await User.findByIdAndUpdate(tx.receiver, { $inc: { balance: mongoose.Types.Decimal128.fromString(tx.amount.toString()) } }, { new: true, session });
    if (!receiver) { await notifyParties(tx, 'cancelled', session, senderCurrencySymbol); throw createError(404, 'Destinataire introuvable'); }

    tx.status      = 'confirmed';
    tx.confirmedAt = new Date();
    await tx.save({ session });

    await notifyParties(tx, 'confirmed', session, senderCurrencySymbol);
    await session.commitTransaction();
    res.json({ success: true });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};
