const mongoose      = require('mongoose');
const createError   = require('http-errors');
const { Expo }      = require('expo-server-sdk');
const expo          = new Expo();

const { getTxConn } = require('../config/db');
const Transaction   = () => getTxConn().model('Transaction'); // utilise txConn
const logger        = require('../utils/logger');

// User est lié à la connexion par défaut → Base Users
const User         = require('../models/User');
const Outbox       = require('../models/Outbox');
const Notification = require('../models/Notification');
const { sendEmail } = require('../utils/mail');
const {
    initiatedTemplate,
    confirmedTemplate,
    cancelledTemplate
} = require('../utils/emailTemplates');

const sanitize = text =>
    text.toString().replace(/[<>\\/{};]/g, '').trim();

/** Notifications email, push & in-app */
async function notifyParties(tx, status, session) {
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
    logger.error(`Pas de template pour "${status}"`);
    return;
  }

  const commonData = {
    transactionId: tx._id.toString(),
    amount:        tx.amount.toString(),
    fees:          tx.transactionFees?.toString() || '0.00',
    senderEmail:   sender?.email || '',
    receiverEmail: receiver?.email || '',
    date:          new Date().toLocaleString('fr-FR'),
    token:         tx.verificationToken,
    confirmLink:   `myapp://confirm/${tx._id}?token=${tx.verificationToken}`
  };

  // emails
  for (const u of [sender, receiver]) {
    if (u?.email) {
      const html = templateFn(commonData);
      await sendEmail({ to: u.email, subject, html });
    }
  }

  // push Expo
  const messages = [];
  for (const u of [sender, receiver]) {
    if (u?.pushToken && Expo.isExpoPushToken(u.pushToken)) {
      messages.push({
        to:    u.pushToken,
        sound: 'default',
        title: subject,
        body:  `Montant : ${commonData.amount} €`,
        data:  commonData
      });
    }
  }
  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      logger.error('Expo push error:', err);
    }
  }

  // in-app via Outbox
  const events = [sender, receiver]
    .filter(Boolean)
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

    // === création immédiate en base pour notifications in-app ===
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
    const { toEmail, amount, description, transactionFees } = req.body;
    const senderId = req.user.id;

    // lookup destinataire dans la base Users
    const receiver = await User.findOne({ email: sanitize(toEmail) }).session(session);
    if (!receiver) throw createError(404, 'Destinataire introuvable');
    if (receiver._id.toString() === senderId) {
      throw createError(400, 'Vous ne pouvez pas vous auto-transférer');
    }

    // parse & valider montants
    const amt  = parseFloat(amount);
    const fees = parseFloat(transactionFees) || 0;
    if (isNaN(amt) || amt <= 0) throw createError(400, 'Montant invalide');
    if (isNaN(fees) || fees < 0) throw createError(400, 'Frais invalides');

    // récupérer solde depuis la base Users
    const sender = await User.findById(senderId).select('balance').session(session);
    if (!sender) throw createError(404, 'Expéditeur introuvable');
    const balFloat   = parseFloat(sender.balance.toString());
    const totalDebit = amt + fees;

    logger.debug(`Solde Users : ${balFloat.toFixed(2)}€, Total débit : ${totalDebit.toFixed(2)}€`);

    if (balFloat < totalDebit) {
      throw createError(
        400,
        `Solde insuffisant : ${balFloat.toFixed(2)}€ disponibles, ${totalDebit.toFixed(2)}€ requis`
      );
    }

    // convertir en Decimal128 pour la base Transactions
    const decAmt    = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
    const decFees   = mongoose.Types.Decimal128.fromString(fees.toFixed(2));
    const token     = Transaction().generateVerificationToken();

    // créer la transaction dans la base Transactions
    const [tx] = await Transaction().create([{        
      sender,
      receiver: receiver._id,
      amount: decAmt,
      transactionFees: decFees,
      verificationToken: token,
      description: sanitize(description)
    }], { session });

    // notifier expéditeur & destinataire
    await notifyParties(tx, 'initiated', session);

    await session.commitTransaction();
    return res.status(201).json({ success: true, transactionId: tx._id, verificationToken: token });
  } catch (err) {
    await session.abortTransaction();
    return next(err);
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
        .select('+verificationToken +transactionFees')
        .session(session);

        if (!tx || tx.status !== 'pending') {
        throw createError(400, 'Transaction invalide ou déjà traitée');
        }
        if (!tx.verifyToken(sanitize(token))) {
        await notifyParties(tx, 'cancelled', session);
        throw createError(401, 'Code de confirmation incorrect');
        }

        // Débit total = amount + fees
        const amtFloat  = parseFloat(tx.amount.toString());
        const feesFloat = parseFloat(tx.transactionFees.toString());
        const totalDebit = amtFloat + feesFloat;

        // Enlever montant + frais de l'expéditeur dans la base Users
        const sender = await User.findOneAndUpdate(
        { _id: tx.sender, balance: { $gte: totalDebit } },
        { $inc: { balance: mongoose.Types.Decimal128.fromString(`-${totalDebit.toFixed(2)}`) } },
        { new: true, session }
        );
        if (!sender) {
        await notifyParties(tx, 'cancelled', session);
        throw createError(400, 'Solde insuffisant ou expéditeur introuvable');
        }

        // Créditer uniquement le montant au destinataire
        const receiver = await User.findByIdAndUpdate(
        tx.receiver,
        { $inc: { balance: mongoose.Types.Decimal128.fromString(tx.amount.toString()) } },
        { new: true, session }
        );
        if (!receiver) {
        await notifyParties(tx, 'cancelled', session);
        throw createError(404, 'Destinataire introuvable');
        }

        // Marquer transaction comme confirmée
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
