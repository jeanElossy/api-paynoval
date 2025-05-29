// const mongoose        = require('mongoose');
// const createError     = require('http-errors');
// const { Expo }        = require('expo-server-sdk');
// const expo            = new Expo();
// const { getTxConn }   = require('../config/db');
// const TransactionModel = () => getTxConn().model('Transaction');
// const logger          = require('../utils/logger');

// const User            = require('../models/User');
// const Outbox          = require('../models/Outbox');
// const Notification    = require('../models/Notification');
// const { sendEmail }   = require('../utils/mail');
// const {
//   initiatedSenderTemplate,
//   initiatedReceiverTemplate,
//   confirmedSenderTemplate,
//   confirmedReceiverTemplate,
//   cancelledSenderTemplate,
//   cancelledReceiverTemplate
// } = require('../utils/emailTemplates');

// // Constants
// const sanitize        = text => text.toString().replace(/[<>\\/{};]/g, '').trim();
// const MAX_DESC_LENGTH = 500;

// /**
//  * Envoie notifications email, push & in-app
//  */
// async function notifyParties(tx, status, session, senderCurrency) {
//   try {
//     const subjectMap = {
//       initiated: 'Transaction en attente',
//       confirmed: 'Transaction confirmée',
//       cancelled: 'Transaction annulée'
//     };
//     const emailSubject = subjectMap[status] || `Transaction ${status}`;

//     const [sender, receiver] = await Promise.all([
//       User.findById(tx.sender).select('email pushToken fullName').lean(),
//       User.findById(tx.receiver).select('email pushToken').lean()
//     ]);

//     const dateStr    = new Date().toLocaleString('fr-FR');
//     const webLink    = `https://panoval.com/confirm/${tx._id}?token=${tx.verificationToken}`;
//     const mobileLink = `panoval://confirm/${tx._id}?token=${tx.verificationToken}`;

//     // Donnee expediteur
//     const dataSender = {
//       transactionId:    tx._id.toString(),
//       amount:           tx.amount.toString(),
//       currency:         senderCurrency,
//       name:             sender.fullName,
//       senderEmail:      sender.email,
//       receiverEmail:    tx.recipientEmail || receiver.email,
//       date:             dateStr,
//       confirmLinkWeb:   webLink,
//       country:          tx.country,
//       securityQuestion: tx.securityQuestion
//     };

//     // Donnee destinataire
//     const dataReceiver = {
//       transactionId:    tx._id.toString(),
//       amount:           tx.localAmount.toString(),
//       currency:         tx.localCurrencySymbol,
//       name:             tx.nameDestinataire,
//       receiverEmail:    tx.recipientEmail,
//       senderEmail:      sender.email,
//       date:             dateStr,
//       confirmLink:      mobileLink,
//       country:          tx.country,
//       securityQuestion: tx.securityQuestion,
//       senderName:        sender.fullName,     
//     };

//     // Emails
//     // email expediteur
//     if (sender.email) {
//       const htmlSender = {
//         initiated: initiatedSenderTemplate,
//         confirmed: confirmedSenderTemplate,
//         cancelled: cancelledSenderTemplate
//       }[status]((status === 'cancelled') ? { ...dataSender, reason: tx.cancelReason } : dataSender);
//       await sendEmail({ to: sender.email, subject: emailSubject, html: htmlSender });
//     }
//     // email destinataire
//     if (receiver.email) {
//       const htmlReceiver = {
//         initiated: initiatedReceiverTemplate,
//         confirmed: confirmedReceiverTemplate,
//         cancelled: cancelledReceiverTemplate
//       }[status]((status === 'cancelled') ? { ...dataReceiver, reason: tx.cancelReason } : dataReceiver);
//       await sendEmail({ to: receiver.email, subject: emailSubject, html: htmlReceiver });
//     }

//     // Push notifications
//     const pushMessages = [];
//     [sender, receiver].forEach(user => {
//       if (user.pushToken && Expo.isExpoPushToken(user.pushToken)) {
//         const payload = (user._id.toString() === sender._id.toString()) ? dataSender : dataReceiver;
//         pushMessages.push({ to: user.pushToken, sound: 'default', title: emailSubject, body: `Montant : ${payload.amount} ${payload.currency}`, data: payload });
//       }
//     });
//     for (const chunk of expo.chunkPushNotifications(pushMessages)) {
//       try { await expo.sendPushNotificationsAsync(chunk); } catch (err) { logger.error('Expo push error:', err); }
//     }

//     // Outbox & in-app notifications
//     const events = [sender, receiver].map(user => {
//       const payload = (user._id.toString() === sender._id.toString()) ? dataSender : dataReceiver;
//       return { service: 'notifications', event: `transaction_${status}`, payload: { userId: user._id, type: `transaction_${status}`, data: payload } };
//     });
//     await Outbox.insertMany(events, { session });
//     const inAppDocs = events.map(e => ({ recipient: e.payload.userId, type: e.payload.type, data: e.payload.data, read: false }));
//     await Notification.insertMany(inAppDocs, { session });

//   } catch (err) {
//     logger.error('notifyParties error:', err);
//     // Ne pas bloquer la transaction pour une erreur de notification
//   }
// }

// /**
//  * GET /api/v1/transactions
//  * Liste les transactions internes de l’utilisateur connecté
//  */
// exports.listInternal = async (req, res, next) => {
//   try {
//     const userId      = req.user.id;
//     const Transaction = TransactionModel();
//     const txs         = await Transaction.find({ sender: userId }).sort({ createdAt: -1 }).lean();
//     res.json({ success: true, count: txs.length, data: txs });
//   } catch (err) {
//     next(err);
//   }
// };

// /**
//  * POST /api/v1/transactions/initiate
//  * Flux interne PayNoVal → PayNoVal
//  */
// exports.initiateInternal = async (req, res, next) => {
//     const session = await mongoose.startSession();
//     try {
//     session.startTransaction();
//     const {
//         toEmail,
//         amount,
//         transactionFees     = 0,
//         localAmount,
//         localCurrencySymbol,
//         recipientInfo       = {},
//         senderCurrencySymbol,
//         description         = '',
//         question,
//         securityCode,
//         destination,
//         funds,
//         country
//     } = req.body;
//     const recipientEmail = sanitize(recipientInfo.email);

//     // validations
//     if (description.length > MAX_DESC_LENGTH) {
//         throw createError(400, 'Description trop longue');
//     }
//     if (!question || !securityCode) {
//         throw createError(400, 'Question et code de sécurité requis');
//     }
//     if (!destination) {
//         throw createError(400, 'Destination non spécifiée');
//     }
//     if (!funds) {
//         throw createError(400, 'Méthode de fonds non spécifiée');
//     }
//     if (!recipientEmail) {
//         throw createError(400, 'Email du destinataire requis');
//     }
//     if (!country) {
//         throw createError(400, 'Pays de destination requis');
//     }

//     const senderId = req.user.id;
//     const receiver = await User.findOne({ email: sanitize(toEmail) }).lean();
//     if (!receiver) throw createError(404, 'Destinataire introuvable');
//     if (receiver._id.toString() === senderId) throw createError(400, 'Auto-transfert impossible');

//     const amt   = parseFloat(amount);
//     const fees  = parseFloat(transactionFees);
//     if (isNaN(amt) || amt <= 0) throw createError(400, 'Montant invalide');

//     const senderObj    = await User.findById(senderId).select('balance fullName email').lean();
//     const balanceFloat = parseFloat(senderObj.balance.toString());
//     if (balanceFloat < amt + fees) {
//         throw createError(400, `Solde insuffisant : ${balanceFloat.toFixed(2)} disponible`);
//     }

//     const decAmt      = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
//     const decFees     = mongoose.Types.Decimal128.fromString(fees.toFixed(2));
//     const decLocalAmt = mongoose.Types.Decimal128.fromString(parseFloat(localAmount).toFixed(2));
//     const token       = TransactionModel().generateVerificationToken();
//     const nameDest    = sanitize(recipientInfo.name) || senderObj.fullName;

//     const [tx] = await TransactionModel().create([{ 
//         sender:             senderObj._id,
//         receiver:           receiver._id,
//         amount:             decAmt,
//         transactionFees:    decFees,
//         localAmount:        decLocalAmt,
//         localCurrencySymbol,
//         nameDestinataire:   nameDest,
//         recipientEmail,
//         country:            sanitize(country),
//         verificationToken:  token,
//         description:        sanitize(description),
//         securityQuestion:   sanitize(question),
//         securityCode:       sanitize(securityCode),
//         destination:        sanitize(destination),
//         funds:              sanitize(funds)
//     }], { session });

//     await notifyParties(tx, 'initiated', session, senderCurrencySymbol);
//     await session.commitTransaction();
//     res.status(201).json({ success: true, transactionId: tx._id, verificationToken: token });
//     } catch (err) {
//         await session.abortTransaction();
//         next(err);
//     } finally {
//         session.endSession();
//     }
// };

// /**
//  * POST /api/v1/transactions/confirm
//  * Confirmation interne PayNoVal → PayNoVal
//  */
// exports.confirmController = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();
//     const { transactionId, token, senderCurrencySymbol } = req.body;

//     const tx = await TransactionModel().findById(transactionId)
//       .select('+verificationToken +transactionFees +localCurrencySymbol +nameDestinataire +localAmount +recipientEmail +securityQuestion +securityCode +destination +funds +country')
//       .session(session);

//     if (!tx || tx.status !== 'pending') {
//       throw createError(400, 'Transaction invalide ou déjà traitée');
//     }
//     if (tx.sender.toString() !== req.user.id) {
//       throw createError(403, 'Interdit : vous n’êtes pas l’expéditeur de cette transaction');
//     }
//     if (!tx.verifyToken(sanitize(token))) {
//       await notifyParties(tx, 'cancelled', session, senderCurrencySymbol);
//       throw createError(401, 'Code de confirmation incorrect');
//     }

//     const amtFloat   = parseFloat(tx.amount.toString());
//     const feesFloat  = parseFloat(tx.transactionFees.toString());
//     const totalDebit = amtFloat + feesFloat;

//     const senderUpd = await User.findOneAndUpdate(
//       { _id: tx.sender, balance: { $gte: totalDebit } },
//       { $inc: { balance: mongoose.Types.Decimal128.fromString(`-${totalDebit.toFixed(2)}`) } },
//       { new: true }
//     ).lean();
//     if (!senderUpd) {
//       await notifyParties(tx, 'cancelled', session, senderCurrencySymbol);
//       throw createError(400, 'Solde insuffisant');
//     }

//     const receiverUpd = await User.findByIdAndUpdate(
//       tx.receiver,
//       { $inc: { balance: mongoose.Types.Decimal128.fromString(tx.amount.toString()) } },
//       { new: true }
//     ).lean();
//     if (!receiverUpd) {
//       await notifyParties(tx, 'cancelled', session, senderCurrencySymbol);
//       throw createError(404, 'Destinataire introuvable');
//     }

//     tx.status      = 'confirmed';
//     tx.confirmedAt = new Date();
//     await tx.save({ session });

//     await notifyParties(tx, 'confirmed', session, senderCurrencySymbol);
//     await session.commitTransaction();
//     res.json({ success: true });
//   } catch (err) {
//     await session.abortTransaction();
//     next(err);
//   } finally {
//     session.endSession();
//   }
// };





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

// Helpers
const sanitize        = text => String(text || '').replace(/[<>\\/{};]/g, '').trim();
const MAX_DESC_LENGTH = 500;

/**
 * notifyParties
 * Envoie emails, pushes & in-app notifications pour expéditeur et destinataire.
 */
async function notifyParties(tx, status, session, senderCurrency) {
  try {
    const subjectMap = {
      initiated: 'Transaction en attente',
      confirmed: 'Transaction confirmée',
      cancelled: 'Transaction annulée'
    };
    const emailSubject = subjectMap[status] || `Transaction ${status}`;

    // Charger expéditeur & destinataire
    const [sender, receiver] = await Promise.all([
      User.findById(tx.sender).select('email pushToken fullName').lean(),
      User.findById(tx.receiver).select('email pushToken fullName').lean()
    ]);

    const dateStr    = new Date().toLocaleString('fr-FR');
    const webLink    = `https://panoval.com/confirm/${tx._id}?token=${tx.verificationToken}`;
    const mobileLink = `panoval://confirm/${tx._id}?token=${tx.verificationToken}`;

    // Préparer payloads
    const payloadSender = {
      transactionId:  tx._id.toString(),
      amount:         tx.amount.toString(),
      currency:       senderCurrency,
      name:           sender.fullName,
      senderEmail:    sender.email,
      receiverEmail:  tx.recipientEmail || receiver.email,
      date:           dateStr,
      confirmLinkWeb: webLink,
      country:        tx.country,
      securityQuestion: tx.securityQuestion
    };
    const payloadReceiver = {
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

    // Emails
    if (sender.email) {
      const html = {
        initiated: initiatedSenderTemplate,
        confirmed: confirmedSenderTemplate,
        cancelled: cancelledSenderTemplate
      }[status]((status === 'cancelled') ? { ...payloadSender, reason: tx.cancelReason } : payloadSender);
      await sendEmail({ to: sender.email, subject: emailSubject, html });
    }
    if (receiver.email) {
      const html = {
        initiated: initiatedReceiverTemplate,
        confirmed: confirmedReceiverTemplate,
        cancelled: cancelledReceiverTemplate
      }[status]((status === 'cancelled') ? { ...payloadReceiver, reason: tx.cancelReason } : payloadReceiver);
      await sendEmail({ to: receiver.email, subject: emailSubject, html });
    }

    // Push
    const pushMessages = [];
    [sender, receiver].forEach(u => {
      if (u.pushToken && Expo.isExpoPushToken(u.pushToken)) {
        const data = (u._id.toString() === sender._id.toString()) ? payloadSender : payloadReceiver;
        pushMessages.push({
          to: u.pushToken,
          sound: 'default',
          title: emailSubject,
          body: `Montant : ${data.amount} ${data.currency}`,
          data
        });
      }
    });
    for (const chunk of expo.chunkPushNotifications(pushMessages)) {
      try { await expo.sendPushNotificationsAsync(chunk); }
      catch (err) { console.error('Expo push error:', err); }
    }

    // In-app
    const events = [sender, receiver].map(u => {
      const data = (u._id.toString() === sender._id.toString()) ? payloadSender : payloadReceiver;
      return {
        service: 'notifications',
        event:   `transaction_${status}`,
        payload: { userId: u._id, type: `transaction_${status}`, data }
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

  } catch (err) {
    console.error('notifyParties error:', err);
  }
}


/**
 * listInternal
 * GET /api/v1/transactions
 * Renvoie l’historique des transactions où l’utilisateur est expéditeur.
 */
exports.listInternal = async (req, res, next) => {
  try {
    const userId      = req.user.id;
    const Transaction = TransactionModel();
    const txs = await Transaction.find({ sender: userId })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, count: txs.length, data: txs });
  } catch (err) {
    next(err);
  }
};


/**
 * initiateInternal
 * POST /api/v1/transactions/initiate
 * Crée une transaction en attente (status = 'pending'),
 * sans débiter l’expéditeur.
 */
exports.initiateInternal = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // 1. Extraction + sanitize
    const {
      toEmail,
      amount,
      transactionFees = 0,
      localAmount,
      localCurrencySymbol,
      recipientInfo = {},
      senderCurrencySymbol,
      description = '',
      question,
      securityCode,
      destination,
      funds,
      country
    } = req.body;

    // 2. Validations
    const recEmail = sanitize(toEmail);
    if (!recEmail)                            throw createError(400, 'Email destinataire requis');
    if (!question || !securityCode)           throw createError(400, 'Question et code de sécurité requis');
    if (!destination || !funds || !country)   throw createError(400, 'Données de transaction incomplètes');
    if (description.length > MAX_DESC_LENGTH) throw createError(400, 'Description trop longue');

    // 3. Récupérer expéditeur
    const senderId   = req.user.id;
    const senderUser = await User.findById(senderId).select('fullName email').lean();
    if (!senderUser)                          throw createError(403, 'Utilisateur invalide');

    // 4. Vérifier solde via Balance
    const balDoc      = await Balance.findOne({ user: senderId }).lean();
    const balanceFloat = balDoc?.amount ?? 0;

    // 5. Destinataire & auto-transfert
    const receiver = await User.findOne({ email: recEmail }).lean();
    if (!receiver)                           throw createError(404, 'Destinataire introuvable');
    if (receiver._id.toString() === senderId) throw createError(400, 'Auto-transfert impossible');

    // 6. Montant & frais
    const amt  = parseFloat(amount);
    const fees = parseFloat(transactionFees);
    if (isNaN(amt) || amt <= 0)               throw createError(400, 'Montant invalide');
    if (balanceFloat < amt + fees)
                                              throw createError(400, `Solde insuffisant : ${balanceFloat.toFixed(2)}`);

    // 7. Conversion & token
    const decAmt      = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
    const decFees     = mongoose.Types.Decimal128.fromString(fees.toFixed(2));
    const decLocalAmt = mongoose.Types.Decimal128.fromString((parseFloat(localAmount)||amt).toFixed(2));
    const token       = TransactionModel().generateVerificationToken();
    const nameDest    = sanitize(recipientInfo.name) || senderUser.fullName;

    // 8. Débit « pré-autorisé » imité ici ou simplement laissé pour la confirmation
    //    (on ne retire pas encore, on laisse pour la confirmation)

    // 9. Création transaction
    const [tx] = await TransactionModel().create([{
      sender:            senderUser._id,
      receiver:          receiver._id,
      amount:            decAmt,
      transactionFees:   decFees,
      localAmount:       decLocalAmt,
      localCurrencySymbol,
      nameDestinataire:  nameDest,
      recipientEmail:    recEmail,
      country:           sanitize(country),
      verificationToken: token,
      description:       sanitize(description),
      securityQuestion:  sanitize(question),
      securityCode:      sanitize(securityCode),
      destination:       sanitize(destination),
      funds:             sanitize(funds)
    }], { session });

    // 10. Notifier « initiated »
    await notifyParties(tx, 'initiated', session, senderCurrencySymbol);

    await session.commitTransaction();
    res.status(201).json({
      success:           true,
      transactionId:     tx._id.toString(),
      verificationToken: token
    });

  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};


/**
 * confirmController
 * POST /api/v1/transactions/confirm
 * Valide le token, débite l’expéditeur & crédite le destinataire.
 */
exports.confirmController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { transactionId, token, senderCurrencySymbol } = req.body;

    // 1. Charger TX
    const tx = await TransactionModel().findById(transactionId)
      .select([
        'sender', 'receiver', 'amount',
        'transactionFees', 'verificationToken',
        'status', 'localCurrencySymbol', 'localAmount',
        'securityQuestion', 'securityCode',
        'destination', 'funds', 'country'
      ].join(' '))
      .session(session);

    if (!tx || tx.status !== 'pending')
      throw createError(400, 'Transaction invalide ou déjà traitée');

    // 2. Vérifier destinataire & token
    if (tx.receiver.toString() !== req.user.id)
      throw createError(403, 'Vous n’êtes pas le destinataire');
    if (!tx.verifyToken(sanitize(token))) {
      await notifyParties(tx, 'cancelled', session, senderCurrencySymbol);
      throw createError(401, 'Code de confirmation incorrect');
    }

    // 3. Calcul montants
    const amtFloat   = parseFloat(tx.amount.toString());
    const feesFloat  = parseFloat(tx.transactionFees.toString());
    const totalDebit = amtFloat + feesFloat;

    // 4. Débit expéditeur
    await Balance.withdrawFromBalance(tx.sender, totalDebit);

    // 5. Crédit destinataire
    await Balance.addToBalance(tx.receiver, amtFloat);

    // 6. Finaliser
    tx.status      = 'confirmed';
    tx.confirmedAt = new Date();
    await tx.save({ session });

    // 7. Notifications « confirmed »
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








// // src/controllers/transactionController.js

// const mongoose        = require('mongoose');
// const createError     = require('http-errors');
// const axios           = require('axios');
// const Stripe          = require('stripe');
// const { Expo }        = require('expo-server-sdk');
// const expo            = new Expo();

// const { getTxConn }   = require('../config/db');
// const TransactionModel= () => getTxConn().model('Transaction');
// const User            = require('../models/User');
// const Outbox          = require('../models/Outbox');
// const Notification    = require('../models/Notification');
// const logger          = require('../utils/logger');
// const { sendEmail }   = require('../utils/mail');

// const {
//   initiatedSenderTemplate,
//   initiatedReceiverTemplate,
//   confirmedSenderTemplate,
//   confirmedReceiverTemplate,
//   cancelledSenderTemplate,
//   cancelledReceiverTemplate
// } = require('../utils/emailTemplates');

// const config          = require('../config');        // inclut .env avec vos clés
// const stripe          = Stripe(config.stripeKey);

// /**
//  * Helper de sanitization
//  */
// const sanitize = text =>
//   text.toString().replace(/[<>\\/{};]/g, '').trim();

// /**
//  * Envoi des notifications email, push & in-app
//  */
// async function notifyParties(tx, status, session, senderCurrency) {
//   // … même code que vous avez pour notifyParties …
//   // inchangé
// }

// /**
//  * Common logic de création de transaction DB + notification
//  */
// async function createTransactionAndNotify({
//   senderId, receiverId, amt, fees, localAmt, localCurrency,
//   nameDest, description, session, senderCurrencySymbol, status
// }, initiator) {
//   const decAmt      = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
//   const decFees     = mongoose.Types.Decimal128.fromString(fees.toFixed(2));
//   const decLocalAmt = mongoose.Types.Decimal128.fromString(localAmt.toFixed(2));
//   const token       = TransactionModel().generateVerificationToken();

//   const [tx] = await TransactionModel().create([{
//     sender:            senderId,
//     receiver:          receiverId,
//     amount:            decAmt,
//     transactionFees:   decFees,
//     localAmount:       decLocalAmt,
//     localCurrencySymbol: localCurrency,
//     nameDestinataire:  nameDest,
//     verificationToken: token,
//     description:       sanitize(description)
//   }], { session });

//   await notifyParties(tx, status, session, senderCurrencySymbol);
//   return { tx, token };
// }

// /** Flux 1: Solde PayNoVal → PayNoVal */
// exports.initiateInternal = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();
//   try {
//     const {
//       toEmail, amount, transactionFees = 0,
//       localAmount, localCurrencySymbol,
//       recipientInfo = {}, senderCurrencySymbol,
//       description = ''
//     } = req.body;

//     const senderId = req.user.id;
//     const receiver = await User.findOne({ email: sanitize(toEmail) }).lean();
//     if (!receiver) throw createError(404, 'Destinataire introuvable');
//     if (receiver._id.toString() === senderId) throw createError(400, 'Auto-transfert impossible');

//     const sender = await User.findById(senderId).select('balance fullName email').lean();
//     const bal = parseFloat(sender.balance.toString());
//     if (bal < parseFloat(amount) + parseFloat(transactionFees)) {
//       throw createError(400, `Solde insuffisant : ${bal.toFixed(2)} disponible`);
//     }

//     const { tx, token } = await createTransactionAndNotify({
//       senderId,
//       receiverId: receiver._id,
//       amt:            parseFloat(amount),
//       fees:           parseFloat(transactionFees),
//       localAmt:       parseFloat(localAmount),
//       localCurrency:  localCurrencySymbol,
//       nameDest:       sanitize(recipientInfo.name) || receiver.fullName,
//       description,
//       session,
//       senderCurrencySymbol,
//       status:        'initiated'
//     });

//     await session.commitTransaction();
//     res.status(201).json({ success: true, transactionId: tx._id, verificationToken: token });
//   } catch (err) {
//     await session.abortTransaction();
//     next(err);
//   } finally {
//     session.endSession();
//   }
// };

// /** Flux 2: Solde PayNoVal → Banque */
// exports.initiateBank = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();
//   try {
//     const {
//       toEmail, amount, transactionFees = 0,
//       localAmount, localCurrencySymbol,
//       country, senderCurrencySymbol, description = ''
//     } = req.body;

//     // 1) Validation déjà faite par la route
//     // 2) Appel à votre Bank API
//     const bankRes = await axios.post(
//       config.bankApi.url + '/transfer',
//       { recipientEmail: sanitize(toEmail), amount },
//       { headers: { Authorization: `Bearer ${config.bankApi.token}`, 'X-Country': country } }
//     );
//     if (!bankRes.data.success) {
//       throw createError(502, 'Erreur banque externe : ' + bankRes.data.message);
//     }

//     // 3) Enregistrer en local et notifier
//     const receiver = await User.findOne({ email: sanitize(toEmail) }).lean();
//     const { tx, token } = await createTransactionAndNotify({
//       senderId:        req.user.id,
//       receiverId:      receiver ? receiver._id : null,
//       amt:             parseFloat(amount),
//       fees:            parseFloat(transactionFees),
//       localAmt:        parseFloat(localAmount),
//       localCurrency:   localCurrencySymbol,
//       nameDest:        sanitize(toEmail),
//       description,
//       session,
//       senderCurrencySymbol,
//       status:        'initiated'
//     });

//     await session.commitTransaction();
//     res.status(201).json({ success: true, transactionId: tx._id, verificationToken: token });
//   } catch (err) {
//     await session.abortTransaction();
//     next(err);
//   } finally {
//     session.endSession();
//   }
// };

// /** Flux 3: Solde PayNoVal → Mobile Money */
// exports.initiateMobileMoney = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();
//   try {
//     const {
//       toEmail, amount, transactionFees = 0,
//       localAmount, localCurrencySymbol,
//       country, senderCurrencySymbol, description = ''
//     } = req.body;

//     // 1) Choix du provider via config.mmProviders
//     const providerUrl   = config.mmProviders[country];
//     const providerToken = config.mmTokens[country];
//     if (!providerUrl || !providerToken) {
//       throw createError(400, 'Pas de fournisseur Mobile Money configuré pour ce pays');
//     }

//     const mmRes = await axios.post(
//       providerUrl + '/pay',
//       { phone: sanitize(req.body.phone), amount },
//       { headers: { Authorization: `Bearer ${providerToken}` } }
//     );
//     if (mmRes.data.status !== 'ok') {
//       throw createError(502, 'Erreur Mobile Money : ' + mmRes.data.error);
//     }

//     // 2) Enregistrer en local et notifier
//     const receiver = await User.findOne({ email: sanitize(toEmail) }).lean();
//     const { tx, token } = await createTransactionAndNotify({
//       senderId:        req.user.id,
//       receiverId:      receiver ? receiver._id : null,
//       amt:             parseFloat(amount),
//       fees:            parseFloat(transactionFees),
//       localAmt:        parseFloat(localAmount),
//       localCurrency:   localCurrencySymbol,
//       nameDest:        sanitize(req.body.phone),
//       description,
//       session,
//       senderCurrencySymbol,
//       status:        'initiated'
//     });

//     await session.commitTransaction();
//     res.status(201).json({ success: true, transactionId: tx._id, verificationToken: token });
//   } catch (err) {
//     await session.abortTransaction();
//     next(err);
//   } finally {
//     session.endSession();
//   }
// };

// /** Flux 4: Carte de crédit → PayNoVal via Stripe */
// exports.initiateCardToPayNoVal = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();
//   try {
//     const {
//       stripeToken, amount, transactionFees = 0,
//       localAmount, localCurrencySymbol,
//       senderCurrencySymbol, description = ''
//     } = req.body;

//     // 1) Charge stripe
//     const charge = await stripe.charges.create({
//       amount: Math.round(amount * 100),             // en centimes
//       currency: senderCurrencySymbol.toLowerCase(),
//       source: stripeToken,
//       description
//     });
//     if (charge.status !== 'succeeded') {
//       throw createError(402, 'Paiement Stripe refusé');
//     }

//     // 2) Enregistrer en local et notifier
//     const receiver = await User.findOne({ email: sanitize(req.body.toEmail) }).lean();
//     const { tx, token } = await createTransactionAndNotify({
//       senderId:        req.user.id,
//       receiverId:      receiver ? receiver._id : null,
//       amt:             parseFloat(amount),
//       fees:            parseFloat(transactionFees),
//       localAmt:        parseFloat(localAmount),
//       localCurrency:   localCurrencySymbol,
//       nameDest:        sanitize(receiver ? receiver.fullName : req.body.toEmail),
//       description,
//       session,
//       senderCurrencySymbol,
//       status:        'initiated'
//     });

//     await session.commitTransaction();
//     res.status(201).json({ success: true, transactionId: tx._id, verificationToken: token });
//   } catch (err) {
//     await session.abortTransaction();
//     next(err);
//   } finally {
//     session.endSession();
//   }
// };

// /** POST /transactions/confirm */
// exports.confirmController = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();

//     const {
//       transactionId,
//       token,
//       senderCurrencySymbol
//     } = req.body;

//     // 1️⃣ Récupération de la transaction avec ses champs sensibles
//     const tx = await TransactionModel()
//       .findById(transactionId)
//       .select('+verificationToken +transactionFees +localCurrencySymbol +nameDestinataire +localAmount +funds +destination')
//       .session(session);

//     if (!tx || tx.status !== 'pending') {
//       throw createError(400, 'Transaction invalide ou déjà traitée');
//     }

//     // 2️⃣ Vérification du token de confirmation
//     if (!tx.verifyToken(sanitize(token))) {
//       await notifyParties(tx, 'cancelled', session, senderCurrencySymbol);
//       throw createError(401, 'Code de confirmation incorrect');
//     }

//     // Pré-calculs
//     const amtFloat    = parseFloat(tx.amount.toString());
//     const feesFloat   = parseFloat(tx.transactionFees.toString());
//     const totalDebit  = amtFloat + feesFloat;

//     let sender, receiver;

//     // 3️⃣ Traitement selon le type de fonds & destination
//     if (tx.funds === 'Solde PayNoVal') {
//       // — Solde PayNoVal → PayNoVal
//       if (tx.destination === 'PayNoVal') {
//         sender = await User.findOneAndUpdate(
//           { _id: tx.sender, balance: { $gte: totalDebit } },
//           { $inc: { balance: mongoose.Types.Decimal128.fromString(`-${totalDebit.toFixed(2)}`) } },
//           { new: true }
//         ).lean();
//         if (!sender) {
//           await notifyParties(tx, 'cancelled', session, senderCurrencySymbol);
//           throw createError(400, 'Solde insuffisant');
//         }

//         receiver = await User.findByIdAndUpdate(
//           tx.receiver,
//           { $inc: { balance: mongoose.Types.Decimal128.fromString(tx.amount.toString()) } },
//           { new: true }
//         ).lean();
//         if (!receiver) {
//           await notifyParties(tx, 'cancelled', session, senderCurrencySymbol);
//           throw createError(404, 'Destinataire introuvable');
//         }
//       }
//       // — Solde PayNoVal → Banque ou Mobile Money
//       else {
//         // on ne crédite pas de compte interne, on débite juste l’expéditeur
//         sender = await User.findOneAndUpdate(
//           { _id: tx.sender, balance: { $gte: totalDebit } },
//           { $inc: { balance: mongoose.Types.Decimal128.fromString(`-${totalDebit.toFixed(2)}`) } },
//           { new: true }
//         ).lean();
//         if (!sender) {
//           await notifyParties(tx, 'cancelled', session, senderCurrencySymbol);
//           throw createError(400, 'Solde insuffisant');
//         }
//       }
//     }
//     // — Carte de crédit → PayNoVal (le paiement Stripe a déjà été capturé à l’initiation)
//     else if (tx.funds === 'Carte de crédit' && tx.destination === 'PayNoVal') {
//       receiver = await User.findByIdAndUpdate(
//         tx.receiver,
//         { $inc: { balance: mongoose.Types.Decimal128.fromString(tx.amount.toString()) } },
//         { new: true }
//       ).lean();
//       if (!receiver) {
//         await notifyParties(tx, 'cancelled', session, senderCurrencySymbol);
//         throw createError(404, 'Destinataire introuvable');
//       }
//     }
//     else {
//       // Cas non supporté
//       throw createError(400, 'Flux de confirmation non supporté');
//     }

//     // 4️⃣ On marque la transaction comme confirmée
//     tx.status      = 'confirmed';
//     tx.confirmedAt = new Date();
//     await tx.save({ session });

//     // 5️⃣ Notifications finalisées (email, push, in-app)
//     await notifyParties(tx, 'confirmed', session, senderCurrencySymbol);

//     await session.commitTransaction();
//     return res.json({ success: true });
//   } catch (err) {
//     await session.abortTransaction();
//     return next(err);
//   } finally {
//     session.endSession();
//   }
// };

