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

/** Notifications email, push & in-app */
async function notifyParties(tx, status, session) {
  // Récupère expéditeur & destinataire en parallèle
  const [sender, receiver] = await Promise.all([
    User.findById(tx.sender).session(session),
    User.findById(tx.receiver).session(session)
  ]);

  // Prépare les données communes
  const commonData = {
    transactionId:        tx._id.toString(),
    amount:               tx.amount.toString(),
    localCurrencySymbol:  tx.localCurrencySymbol,            // à définir avant la création de tx
    date:                 new Date().toLocaleString('fr-FR'),
    confirmLink:          `myapp://confirm/${tx._id}?token=${tx.verificationToken}`
  };

  // 1) EMAILS
  // Expéditeur
  if (sender.email) {
    const htmlSender = (() => {
      switch (status) {
        case 'initiated':
          return initiatedSenderTemplate({
            ...commonData,
            nameExpediteur: sender.name,
          });
        case 'confirmed':
          return confirmedSenderTemplate({
            ...commonData,
            nameExpediteur: sender.name,
          });
        case 'cancelled':
          return cancelledSenderTemplate({
            ...commonData,
            nameExpediteur: sender.name,
            reason: tx.cancelReason
          });
      }
    })();

    await sendEmail({
      to:      sender.email,
      subject: `Transaction ${status}`,
      html:    htmlSender
    });
  }

  // Destinataire
  if (receiver.email) {
    const htmlReceiver = (() => {
      switch (status) {
        case 'initiated':
          return initiatedReceiverTemplate({
            ...commonData,
            senderEmail:     sender.email,
            nameDestinataire: receiver.name,
          });
        case 'confirmed':
          return confirmedReceiverTemplate({
            ...commonData,
            nameDestinataire: receiver.name,
          });
        case 'cancelled':
          return cancelledReceiverTemplate({
            ...commonData,
            nameDestinataire: receiver.name,
            reason: tx.cancelReason
          });
      }
    })();

    await sendEmail({
      to:      receiver.email,
      subject: `Transaction ${status}`,
      html:    htmlReceiver
    });
  }

  // 2) PUSH NOTIFICATIONS Expo
  const notifications = [sender, receiver].map(u => {
    if (u?.pushToken && Expo.isExpoPushToken(u.pushToken)) {
      return {
        to:    u.pushToken,
        sound: 'default',
        title: `Transaction ${status}`,
        body:  `Montant : ${commonData.amount} ${commonData.localCurrencySymbol}`,
        data:  commonData
      };
    }
  }).filter(Boolean);

  for (const chunk of expo.chunkPushNotifications(notifications)) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      logger.error('Expo push error:', err);
    }
  }

  // 3) In-app : Outbox + Notification
  const events = [sender, receiver]
    .filter(Boolean)
    .map(u => ({
      service: 'notifications',
      event:   `transaction_${status}`,
      payload: {
        userId: u._id,
        type:   `transaction_${status}`,
        data:   commonData
      }
    }));

  if (events.length) {
    await Outbox.insertMany(events, { session });
    const inAppDocs = events.map(e => ({
      recipient: e.payload.userId,
      type:      e.payload.type,
      data:      e.payload.data,
      read:      false
    }));
    await Notification.insertMany(inAppDocs, { session });
  }
}

/** POST /transactions/initiate */
exports.initiateController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { toEmail, amount, description, transactionFees, localCurrencySymbol } = req.body;
    const senderId = req.user.id;

    const receiver = await User.findOne({ email: sanitize(toEmail) }).session(session);
    if (!receiver) throw createError(404, 'Destinataire introuvable');
    if (receiver._id.toString() === senderId) throw createError(400, 'Auto-transfert impossible');

    const amt  = parseFloat(amount);
    const fees = parseFloat(transactionFees) || 0;
    if (isNaN(amt) || amt <= 0) throw createError(400, 'Montant invalide');

    const sender = await User.findById(senderId).select('balance name').session(session);
    if (!sender) throw createError(404, 'Expéditeur introuvable');

    const balFloat   = parseFloat(sender.balance.toString());
    const totalDebit = amt + fees;
    if (balFloat < totalDebit) {
      throw createError(400, `Solde insuffisant : ${balFloat.toFixed(2)} disponible`);
    }

    const decAmt    = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
    const decFees   = mongoose.Types.Decimal128.fromString(fees.toFixed(2));
    const token     = Transaction().generateVerificationToken();

    const [tx] = await Transaction().create([{
      sender:            sender._id,
      receiver:          receiver._id,
      amount:            decAmt,
      transactionFees:   decFees,
      verificationToken: token,
      description:       sanitize(description),
      localCurrencySymbol,               // on stocke aussi la devise
    }], { session });

    await notifyParties(tx, 'initiated', session);
    await session.commitTransaction();

    res.status(201).json({
      success:           true,
      transactionId:     tx._id,
      verificationToken: token
    });
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
    const { transactionId, token } = req.body;
    const tx = await Transaction().findById(transactionId)
      .select('+verificationToken +transactionFees +localCurrencySymbol')
      .session(session);

    if (!tx || tx.status !== 'pending') {
      throw createError(400, 'Transaction invalide ou déjà traitée');
    }
    if (!tx.verifyToken(sanitize(token))) {
      await notifyParties(tx, 'cancelled', session);
      throw createError(401, 'Code de confirmation incorrect');
    }

    const amtFloat  = parseFloat(tx.amount.toString());
    const feesFloat = parseFloat(tx.transactionFees.toString());
    const totalDebit = amtFloat + feesFloat;

    const sender = await User.findOneAndUpdate(
      { _id: tx.sender, balance: { $gte: totalDebit } },
      { $inc: { balance: mongoose.Types.Decimal128.fromString(`-${totalDebit.toFixed(2)}`) } },
      { new: true, session }
    );
    if (!sender) {
      await notifyParties(tx, 'cancelled', session);
      throw createError(400, 'Solde insuffisant');
    }

    const receiver = await User.findByIdAndUpdate(
      tx.receiver,
      { $inc: { balance: mongoose.Types.Decimal128.fromString(tx.amount.toString()) } },
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
    res.json({ success: true });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};
