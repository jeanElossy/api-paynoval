// src/controllers/transactionsController.js
const mongoose          = require('mongoose');
const createError       = require('http-errors');
const { Expo }          = require('expo-server-sdk');
const expo              = new Expo();
const { getTxConn }     = require('../config/db');
const TransactionModel  = () => getTxConn().model('Transaction');
const Balance           = require('../models/Balance');
const User              = require('../models/User');
const Outbox            = require('../models/Outbox');
const Notification      = require('../models/Notification');
const { sendEmail }     = require('../utils/mail');
const {
  initiatedSenderTemplate,
  initiatedReceiverTemplate,
  confirmedSenderTemplate,
  confirmedReceiverTemplate,
  cancelledSenderTemplate,
  cancelledReceiverTemplate
} = require('../utils/emailTemplates');
const { convertAmount } = require('../tools/currency');


// ─── CONST & HELPERS ─────────────────────────────────────────────────────────
const sanitize        = text => String(text || '').replace(/[<>\\/{};]/g, '').trim();
const MAX_DESC_LENGTH = 500;


/**
 * notifyParties: envoie notifications email, push & in-app pour expéditeur et destinataire
 */


async function notifyParties(tx, status, session, senderCurrency) {
  try {
    const subjectMap = { 
      initiated: 'Transaction en attente', 
      confirmed: 'Transaction confirmée', 
      cancelled: 'Transaction annulée' 
    };
    const emailSubject = subjectMap[status] || `Transaction ${status}`;
    const [sender, receiver] = await Promise.all([
      User.findById(tx.sender).select('email pushToken fullName').lean(),
      User.findById(tx.receiver).select('email pushToken fullName').lean()
    ]);

    const dateStr = new Date().toLocaleString('fr-FR');
    const webLink  = `https://panoval.com/confirm/${tx._id}?token=${tx.verificationToken}`;
    const mobileLink = `panoval://confirm/${tx._id}?token=${tx.verificationToken}`;

    const dataSender = {
      transactionId: tx._id.toString(),
      amount:        tx.amount.toString(),
      currency:      senderCurrency,
      name:          sender.fullName,
      senderEmail:   sender.email,
      receiverEmail: tx.recipientEmail || receiver.email,
      date:          dateStr,
      confirmLinkWeb: webLink,
      country:       tx.country,
      securityQuestion: tx.securityQuestion
    };
    const dataReceiver = {
      transactionId:  tx._id.toString(),
      amount:         tx.localAmount.toString(),
      currency:       tx.localCurrencySymbol,
      name:           tx.nameDestinataire,
      receiverEmail:  tx.recipientEmail,
      senderEmail:    sender.email,
      date:           dateStr,
      confirmLink:    mobileLink,
      country:        tx.country,
      securityQuestion: tx.securityQuestion,
      senderName:     sender.fullName
    };

    // --- Emails ---
    if (sender.email) {
      const html = {
        initiated: initiatedSenderTemplate,
        confirmed: confirmedSenderTemplate,
        cancelled: cancelledSenderTemplate
      }[status](status === 'cancelled' ? { ...dataSender, reason: tx.cancelReason } : dataSender);
      await sendEmail({ to: sender.email, subject: emailSubject, html });
    }
    if (receiver.email) {
      const html = {
        initiated: initiatedReceiverTemplate,
        confirmed: confirmedReceiverTemplate,
        cancelled: cancelledReceiverTemplate
      }[status](status === 'cancelled' ? { ...dataReceiver, reason: tx.cancelReason } : dataReceiver);
      await sendEmail({ to: receiver.email, subject: emailSubject, html });
    }

    // --- Push ---
    const pushMessages = [];
    [sender, receiver].forEach(u => {
      if (u.pushToken && Expo.isExpoPushToken(u.pushToken)) {
        const payload = u._id.toString() === sender._id.toString() ? dataSender : dataReceiver;
        pushMessages.push({ to: u.pushToken, sound: 'default', title: emailSubject, body: `Montant : ${payload.amount} ${payload.currency}`, data: payload });
      }
    });
    for (const chunk of expo.chunkPushNotifications(pushMessages)) {
      try { await expo.sendPushNotificationsAsync(chunk); } catch (e) { console.error(e); }
    }

    // --- In-app & Outbox ---
    const events = [sender, receiver].map(u => ({ service: 'notifications', event: `transaction_${status}`, payload: { userId: u._id, type: `transaction_${status}`, data: u._id.toString() === sender._id.toString() ? dataSender : dataReceiver } }));
    await Outbox.insertMany(events, { session });
    const inAppDocs = events.map(e => ({ recipient: e.payload.userId, type: e.payload.type, data: e.payload.data, read: false }));
    await Notification.insertMany(inAppDocs, { session });
  } catch (err) {
    console.error('notifyParties error:', err);
  }
}


// ─── LIST ─────────────────────────────────────────────────────────────────────

exports.listInternal = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const Transaction = TransactionModel();
    const txs = await Transaction.find({ sender: userId }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, count: txs.length, data: txs });
  } catch (err) {
    next(err);
  }
};


/**
 * Récupère une transaction par ID
 * Récupère une transaction par ID (uniquement si elle appartient au destinataire connecté)
 */

exports.getTransactionController = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  // On recherche la transaction dont l’_id est id et dont le destinataire (toUserId) correspond à l’utilisateur connecté
  const tx = await TransactionModel().findOne({ _id: id, toUserId: userId }).lean();

  if (!tx) {
    // Soit la transaction n’existe pas, soit elle n’appartient pas à cet utilisateur en tant que destinataire
    return res.status(404).json({
      success: false,
      message: 'Transaction non trouvée'
    });
  }

  return res.status(200).json({
    success: true,
    data: tx
  });
});



// ─── INITIATE ─────────────────────────────────────────────────────────────────

exports.initiateInternal = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { toEmail, amount, transactionFees = 0, senderCurrencySymbol, localCurrencySymbol, recipientInfo = {}, description = '', question, securityCode, destination, funds, country } = req.body;
    if (!sanitize(toEmail)) throw createError(400, 'Email du destinataire requis');
    if (!question || !securityCode) throw createError(400, 'Question et code de sécurité requis');
    if (!destination || !funds || !country) throw createError(400, 'Données de transaction incomplètes');
    if (description.length > MAX_DESC_LENGTH) throw createError(400, 'Description trop longue');

    const senderId   = req.user.id;
    const senderUser = await User.findById(senderId).select('fullName email').lean();
    if (!senderUser) throw createError(403, 'Utilisateur invalide');

    const receiver = await User.findOne({ email: sanitize(toEmail) }).lean();
    if (!receiver) throw createError(404, 'Destinataire introuvable');
    if (receiver._id.toString() === senderId) throw createError(400, 'Auto-transfert impossible');

    const amt  = parseFloat(amount);
    const fees = parseFloat(transactionFees);
    if (isNaN(amt) || amt <= 0) throw createError(400, 'Montant invalide');
    if (isNaN(fees) || fees < 0) throw createError(400, 'Frais invalides');
    const total = amt + fees;

    // Vérifier et débiter le solde de l'expéditeur
    const balDoc = await Balance.findOne({ user: senderId }).session(session);
    const balanceFloat = balDoc?.amount ?? 0;
    if (balanceFloat < total) throw createError(400, `Solde insuffisant : ${balanceFloat.toFixed(2)}`);

    const debited = await Balance.findOneAndUpdate(
      { user: senderId },
      { $inc: { amount: -total } },
      { new: true, session }
    );
    if (!debited) throw createError(500, 'Erreur lors du débit');

    // Calcul des montants locaux via currency service
    const { rate, converted } = await convertAmount(senderCurrencySymbol, localCurrencySymbol, amt);

    // Préparation des valeurs décimales
    const decAmt      = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
    const decFees     = mongoose.Types.Decimal128.fromString(fees.toFixed(2));
    const decLocal    = mongoose.Types.Decimal128.fromString(converted.toFixed(2));
    const decExchange = mongoose.Types.Decimal128.fromString(rate.toString());
    const nameDest    = sanitize(recipientInfo.name) || senderUser.fullName;

    // Création de la transaction
    const [tx] = await TransactionModel().create([{
      sender:               senderUser._id,
      receiver:             receiver._id,
      amount:               decAmt,
      transactionFees:      decFees,
      senderCurrencySymbol: sanitize(senderCurrencySymbol),
      exchangeRate:         decExchange,
      localAmount:          decLocal,
      localCurrencySymbol:  sanitize(localCurrencySymbol),
      nameDestinataire:     nameDest,
      recipientEmail:       sanitize(toEmail),
      country:              sanitize(country),
      description:          sanitize(description),
      securityQuestion:     sanitize(question),
      securityCode:         sanitize(securityCode),
      destination:          sanitize(destination),
      funds:                sanitize(funds),
      status:               'pending'
    }], { session });

    // Notifications "initiated"
    await notifyParties(tx, 'initiated', session, senderCurrencySymbol);

    await session.commitTransaction();
    res.status(201).json({ success: true, transactionId: tx._id.toString() });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};


// ─── CONFIRM ──────────────────────────────────────────────────────────────────

exports.confirmController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { transactionId, securityCode } = req.body;
    if (!transactionId || !securityCode) throw createError(400, 'Paramètres manquants');

    const tx = await TransactionModel().findById(transactionId)
      .select('+securityCode +localAmount +senderCurrencySymbol +receiver +sender')
      .session(session);
    if (!tx || tx.status !== 'pending') throw createError(400, 'Transaction invalide ou déjà traitée');
    if (String(tx.receiver) !== String(req.user.id)) throw createError(403, 'Vous n’êtes pas le destinataire');

    if (sanitize(securityCode) !== tx.securityCode) {
      await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
      throw createError(401, 'Code de sécurité incorrect');
    }

    // Créditer le destinataire avec le montant local
    const localAmtFloat = parseFloat(tx.localAmount.toString());
    const credited = await Balance.findOneAndUpdate(
      { user: tx.receiver },
      { $inc: { amount: localAmtFloat } },
      { new: true, upsert: true, session }
    );
    if (!credited) throw createError(500, 'Erreur lors du crédit');

    tx.status      = 'confirmed';
    tx.confirmedAt = new Date();
    await tx.save({ session });

    // Notifications "confirmed"
    await notifyParties(tx, 'confirmed', session, tx.senderCurrencySymbol);

    await session.commitTransaction();
    res.json({ success: true });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

// ─── CANCEL ───────────────────────────────────────────────────────────────────


exports.cancelController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { transactionId, reason = 'Annulé', senderCurrencySymbol } = req.body;
    if (!transactionId) throw createError(400, 'ID de transaction requis');

    const tx = await TransactionModel().findById(transactionId)
      .select('+amount +transactionFees +sender +receiver')
      .session(session);
    if (!tx || tx.status !== 'pending') throw createError(400, 'Transaction invalide ou déjà traitée');

    const userId     = String(req.user.id);
    const senderId   = String(tx.sender);
    const receiverId = String(tx.receiver);
    if (userId !== senderId && userId !== receiverId) throw createError(403, 'Vous n’êtes pas autorisé à annuler');

    const amtFloat  = parseFloat(tx.amount.toString());
    const feesFloat = parseFloat(tx.transactionFees.toString());
    const gross     = amtFloat + feesFloat;
    const netRefund = parseFloat((gross * 0.99).toFixed(2));

    await Balance.findOneAndUpdate(
      { user: tx.sender },
      { $inc: { amount: netRefund } },
      { new: true, upsert: true, session }
    );

    tx.status        = 'cancelled';
    tx.cancelledAt   = new Date();
    tx.cancelReason  = `${userId===receiverId?'Annulé par le destinataire':'Annulé par l’expéditeur'} : ${sanitize(reason)}`;
    await tx.save({ session });

    await notifyParties(tx, 'cancelled', session, senderCurrencySymbol);

    await session.commitTransaction();
    res.json({ success: true, refunded: netRefund });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};
