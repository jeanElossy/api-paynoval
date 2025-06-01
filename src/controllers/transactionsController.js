// // src/controllers/transactionsController.js
// const mongoose          = require('mongoose');
// const createError       = require('http-errors');
// const { Expo }          = require('expo-server-sdk');
// const expo              = new Expo();
// const { getTxConn }     = require('../config/db');
// const TransactionModel  = () => getTxConn().model('Transaction');
// const Balance           = require('../models/Balance');
// const User              = require('../models/User');
// const Outbox            = require('../models/Outbox');
// const Notification      = require('../models/Notification');
// const { sendEmail }     = require('../utils/mail');
// const {
//   initiatedSenderTemplate,
//   initiatedReceiverTemplate,
//   confirmedSenderTemplate,
//   confirmedReceiverTemplate,
//   cancelledSenderTemplate,
//   cancelledReceiverTemplate
// } = require('../utils/emailTemplates');
// const { convertAmount } = require('../tools/currency');


// // ─── CONST & HELPERS ─────────────────────────────────────────────────────────
// const sanitize        = text => String(text || '').replace(/[<>\\/{};]/g, '').trim();
// const MAX_DESC_LENGTH = 500;


// /**
//  * notifyParties: envoie notifications email, push & in-app pour expéditeur et destinataire
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
//       User.findById(tx.receiver).select('email pushToken fullName').lean()
//     ]);

//     const dateStr = new Date().toLocaleString('fr-FR');
//     const webLink  = `https://panoval.com/confirm/${tx._id}?token=${tx.verificationToken}`;
//     const mobileLink = `panoval://confirm/${tx._id}?token=${tx.verificationToken}`;

//     const dataSender = {
//       transactionId: tx._id.toString(),
//       amount:        tx.amount.toString(),
//       currency:      senderCurrency,
//       name:          sender.fullName,
//       senderEmail:   sender.email,
//       receiverEmail: tx.recipientEmail || receiver.email,
//       date:          dateStr,
//       confirmLinkWeb: webLink,
//       country:       tx.country,
//       securityQuestion: tx.securityQuestion
//     };
//     const dataReceiver = {
//       transactionId:  tx._id.toString(),
//       amount:         tx.localAmount.toString(),
//       currency:       tx.localCurrencySymbol,
//       name:           tx.nameDestinataire,
//       receiverEmail:  tx.recipientEmail,
//       senderEmail:    sender.email,
//       date:           dateStr,
//       confirmLink:    mobileLink,
//       country:        tx.country,
//       securityQuestion: tx.securityQuestion,
//       senderName:     sender.fullName
//     };

//     // --- Emails ---
//     if (sender.email) {
//       const html = {
//         initiated: initiatedSenderTemplate,
//         confirmed: confirmedSenderTemplate,
//         cancelled: cancelledSenderTemplate
//       }[status](status === 'cancelled' ? { ...dataSender, reason: tx.cancelReason } : dataSender);
//       await sendEmail({ to: sender.email, subject: emailSubject, html });
//     }
//     if (receiver.email) {
//       const html = {
//         initiated: initiatedReceiverTemplate,
//         confirmed: confirmedReceiverTemplate,
//         cancelled: cancelledReceiverTemplate
//       }[status](status === 'cancelled' ? { ...dataReceiver, reason: tx.cancelReason } : dataReceiver);
//       await sendEmail({ to: receiver.email, subject: emailSubject, html });
//     }

//     // --- Push ---
//     const pushMessages = [];
//     [sender, receiver].forEach(u => {
//       if (u.pushToken && Expo.isExpoPushToken(u.pushToken)) {
//         const payload = u._id.toString() === sender._id.toString() ? dataSender : dataReceiver;
//         pushMessages.push({ to: u.pushToken, sound: 'default', title: emailSubject, body: `Montant : ${payload.amount} ${payload.currency}`, data: payload });
//       }
//     });
//     for (const chunk of expo.chunkPushNotifications(pushMessages)) {
//       try { await expo.sendPushNotificationsAsync(chunk); } catch (e) { console.error(e); }
//     }

//     // --- In-app & Outbox ---
//     const events = [sender, receiver].map(u => ({ service: 'notifications', event: `transaction_${status}`, payload: { userId: u._id, type: `transaction_${status}`, data: u._id.toString() === sender._id.toString() ? dataSender : dataReceiver } }));
//     await Outbox.insertMany(events, { session });
//     const inAppDocs = events.map(e => ({ recipient: e.payload.userId, type: e.payload.type, data: e.payload.data, read: false }));
//     await Notification.insertMany(inAppDocs, { session });
//   } catch (err) {
//     console.error('notifyParties error:', err);
//   }
// }


// // ─── LIST ─────────────────────────────────────────────────────────────────────

// // exports.listInternal = async (req, res, next) => {
// //   try {
// //     const userId = req.user.id;
// //     const Transaction = TransactionModel();
// //     const txs = await Transaction.find({ sender: userId }).sort({ createdAt: -1 }).lean();
// //     res.json({ success: true, count: txs.length, data: txs });
// //   } catch (err) {
// //     next(err);
// //   }
// // };



// exports.listInternal = async (req, res, next) => {
//   try {
//     const userId = req.user.id;
//     const Transaction = TransactionModel();

//     // On cherche toutes les transactions où sender === userId OU receiver === userId
//     const txs = await Transaction.find({
//       $or: [
//         { sender: userId },
//         { receiver: userId }
//       ]
//     })
//       .sort({ createdAt: -1 })
//       .lean();

//     res.json({ success: true, count: txs.length, data: txs });
//   } catch (err) {
//     next(err);
//   }
// };


// /**
//  * Récupère une transaction par ID (si l’utilisateur connecté est émetteur OU destinataire)
//  */
// exports.getTransactionController = async (req, res, next) => {
//   try {
//     const { id }   = req.params;
//     const userId   = req.user.id; // le middleware `protect` a mis `req.user`

//     // 1) On récupère d’abord la transaction par son _id
//     const tx = await TransactionModel().findById(id).lean();
//     if (!tx) {
//       // La transaction n’existe pas
//       return res.status(404).json({
//         success: false,
//         message: 'Transaction non trouvée',
//       });
//     }

//     // 2) Vérifier si l’utilisateur est bien sender ou receiver
//     const isSender   = tx.sender?.toString()   === userId;
//     const isReceiver = tx.receiver?.toString() === userId;

//     if (!isSender && !isReceiver) {
//       // L’utilisateur connecté n’est ni l’émetteur ni le destinataire → on masque l’existence de la transaction
//       return res.status(404).json({
//         success: false,
//         message: 'Transaction non trouvée',
//       });
//     }

//     // 3) Tout est OK : on renvoie la transaction complète (status, montant, etc.)
//     return res.status(200).json({
//       success: true,
//       data: tx,
//     });
//   } catch (err) {
//     next(err);
//   }
// };


// // ─── INITIATE ─────────────────────────────────────────────────────────────────

// exports.initiateInternal = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();
//     const { toEmail, amount, transactionFees = 0, senderCurrencySymbol, localCurrencySymbol, recipientInfo = {}, description = '', question, securityCode, destination, funds, country } = req.body;
//     if (!sanitize(toEmail)) throw createError(400, 'Email du destinataire requis');
//     if (!question || !securityCode) throw createError(400, 'Question et code de sécurité requis');
//     if (!destination || !funds || !country) throw createError(400, 'Données de transaction incomplètes');
//     if (description.length > MAX_DESC_LENGTH) throw createError(400, 'Description trop longue');

//     const senderId   = req.user.id;
//     const senderUser = await User.findById(senderId).select('fullName email').lean();
//     if (!senderUser) throw createError(403, 'Utilisateur invalide');

//     const receiver = await User.findOne({ email: sanitize(toEmail) }).lean();
//     if (!receiver) throw createError(404, 'Destinataire introuvable');
//     if (receiver._id.toString() === senderId) throw createError(400, 'Auto-transfert impossible');

//     const amt  = parseFloat(amount);
//     const fees = parseFloat(transactionFees);
//     if (isNaN(amt) || amt <= 0) throw createError(400, 'Montant invalide');
//     if (isNaN(fees) || fees < 0) throw createError(400, 'Frais invalides');
//     const total = amt + fees;

//     // Vérifier et débiter le solde de l'expéditeur
//     const balDoc = await Balance.findOne({ user: senderId }).session(session);
//     const balanceFloat = balDoc?.amount ?? 0;
//     if (balanceFloat < total) throw createError(400, `Solde insuffisant : ${balanceFloat.toFixed(2)}`);

//     const debited = await Balance.findOneAndUpdate(
//       { user: senderId },
//       { $inc: { amount: -total } },
//       { new: true, session }
//     );
//     if (!debited) throw createError(500, 'Erreur lors du débit');

//     // Calcul des montants locaux via currency service
//     const { rate, converted } = await convertAmount(senderCurrencySymbol, localCurrencySymbol, amt);

//     // Préparation des valeurs décimales
//     const decAmt      = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
//     const decFees     = mongoose.Types.Decimal128.fromString(fees.toFixed(2));
//     const decLocal    = mongoose.Types.Decimal128.fromString(converted.toFixed(2));
//     const decExchange = mongoose.Types.Decimal128.fromString(rate.toString());
//     const nameDest    = sanitize(recipientInfo.name) || senderUser.fullName;

//     // Création de la transaction
//     const [tx] = await TransactionModel().create([{
//       sender:               senderUser._id,
//       receiver:             receiver._id,
//       amount:               decAmt,
//       transactionFees:      decFees,
//       senderCurrencySymbol: sanitize(senderCurrencySymbol),
//       exchangeRate:         decExchange,
//       localAmount:          decLocal,
//       localCurrencySymbol:  sanitize(localCurrencySymbol),
//       nameDestinataire:     nameDest,
//       recipientEmail:       sanitize(toEmail),
//       country:              sanitize(country),
//       description:          sanitize(description),
//       securityQuestion:     sanitize(question),
//       securityCode:         sanitize(securityCode),
//       destination:          sanitize(destination),
//       funds:                sanitize(funds),
//       status:               'pending'
//     }], { session });

//     // Notifications "initiated"
//     await notifyParties(tx, 'initiated', session, senderCurrencySymbol);

//     await session.commitTransaction();
//     res.status(201).json({ success: true, transactionId: tx._id.toString() });
//   } catch (err) {
//     await session.abortTransaction();
//     next(err);
//   } finally {
//     session.endSession();
//   }
// };


// // ─── CONFIRM ──────────────────────────────────────────────────────────────────

// exports.confirmController = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();
//     const { transactionId, securityCode } = req.body;
//     if (!transactionId || !securityCode) throw createError(400, 'Paramètres manquants');

//     const tx = await TransactionModel().findById(transactionId)
//       .select('+securityCode +localAmount +senderCurrencySymbol +receiver +sender')
//       .session(session);
//     if (!tx || tx.status !== 'pending') throw createError(400, 'Transaction invalide ou déjà traitée');
//     if (String(tx.receiver) !== String(req.user.id)) throw createError(403, 'Vous n’êtes pas le destinataire');

//     if (sanitize(securityCode) !== tx.securityCode) {
//       await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
//       throw createError(401, 'Code de sécurité incorrect');
//     }

//     // Créditer le destinataire avec le montant local
//     const localAmtFloat = parseFloat(tx.localAmount.toString());
//     const credited = await Balance.findOneAndUpdate(
//       { user: tx.receiver },
//       { $inc: { amount: localAmtFloat } },
//       { new: true, upsert: true, session }
//     );
//     if (!credited) throw createError(500, 'Erreur lors du crédit');

//     tx.status      = 'confirmed';
//     tx.confirmedAt = new Date();
//     await tx.save({ session });

//     // Notifications "confirmed"
//     await notifyParties(tx, 'confirmed', session, tx.senderCurrencySymbol);

//     await session.commitTransaction();
//     res.json({ success: true });
//   } catch (err) {
//     await session.abortTransaction();
//     next(err);
//   } finally {
//     session.endSession();
//   }
// };

// // ─── CANCEL ───────────────────────────────────────────────────────────────────


// exports.cancelController = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();
//     const { transactionId, reason = 'Annulé', senderCurrencySymbol } = req.body;
//     if (!transactionId) throw createError(400, 'ID de transaction requis');

//     const tx = await TransactionModel().findById(transactionId)
//       .select('+amount +transactionFees +sender +receiver')
//       .session(session);
//     if (!tx || tx.status !== 'pending') throw createError(400, 'Transaction invalide ou déjà traitée');

//     const userId     = String(req.user.id);
//     const senderId   = String(tx.sender);
//     const receiverId = String(tx.receiver);
//     if (userId !== senderId && userId !== receiverId) throw createError(403, 'Vous n’êtes pas autorisé à annuler');

//     const amtFloat  = parseFloat(tx.amount.toString());
//     const feesFloat = parseFloat(tx.transactionFees.toString());
//     const gross     = amtFloat + feesFloat;
//     const netRefund = parseFloat((gross * 0.99).toFixed(2));

//     await Balance.findOneAndUpdate(
//       { user: tx.sender },
//       { $inc: { amount: netRefund } },
//       { new: true, upsert: true, session }
//     );

//     tx.status        = 'cancelled';
//     tx.cancelledAt   = new Date();
//     tx.cancelReason  = `${userId===receiverId?'Annulé par le destinataire':'Annulé par l’expéditeur'} : ${sanitize(reason)}`;
//     await tx.save({ session });

//     await notifyParties(tx, 'cancelled', session, senderCurrencySymbol);

//     await session.commitTransaction();
//     res.json({ success: true, refunded: netRefund });
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
const { convertAmount } = require('../tools/currency');


// ─── CONST & HELPERS ─────────────────────────────────────────────────────────
const sanitize        = text => String(text || '').replace(/[<>\\/{};]/g, '').trim();
const MAX_DESC_LENGTH = 500;


/**
 * notifyParties: envoie notifications email, push & in-app pour expéditeur et destinataire
 *  - tx : document Transaction (Mongoose)
 *  - status : 'initiated' | 'confirmed' | 'cancelled'
 *  - session : session MongoDB pour la transaction
 *  - senderCurrency : symbole de la devise de l’expéditeur (par ex. 'F CFA')
 */
async function notifyParties(tx, status, session, senderCurrency) {
  try {
    const subjectMap = { 
      initiated: 'Transaction en attente', 
      confirmed: 'Transaction confirmée', 
      cancelled: 'Transaction annulée' 
    };
    const emailSubject = subjectMap[status] || `Transaction ${status}`;

    // ── Récupère l’expéditeur (sender) et le destinataire (receiver) depuis la collection Users
    const [sender, receiver] = await Promise.all([
      User.findById(tx.sender).select('email pushToken fullName').lean(),
      User.findById(tx.receiver).select('email pushToken fullName').lean()
    ]);

    // Formate la date pour les emails et notifications
    const dateStr = new Date().toLocaleString('fr-FR');

    // Liens de confirmation (web + mobile) pour inclusion dans les emails/notifications
    const webLink    = `https://panoval.com/confirm/${tx._id}?token=${tx.verificationToken}`;
    const mobileLink = `panoval://confirm/${tx._id}?token=${tx.verificationToken}`;

    // ── Prépare le payload envoyé à l’expéditeur
    const dataSender = {
      transactionId:     tx._id.toString(),
      amount:            tx.amount.toString(),              // montant principal
      currency:          senderCurrency,                    // symbole de la devise expéditeur
      name:              sender.fullName,                   // nom complet de l’expéditeur
      senderEmail:       sender.email,                      // email expéditeur
      receiverEmail:     tx.recipientEmail || receiver.email, // email destinataire
      date:              dateStr,                           // date de création
      confirmLinkWeb:    webLink,                           // lien web
      country:           tx.country,                        // pays
      securityQuestion:  tx.securityQuestion                // question de sécurité
    };

    // ── Prépare le payload envoyé au destinataire
    const dataReceiver = {
      transactionId:     tx._id.toString(),
      amount:            tx.localAmount.toString(),         // montant converti dans la devise locale
      currency:          tx.localCurrencySymbol,            // symbole de la devise locale
      name:              tx.nameDestinataire,              // nom du destinataire tel que fourni
      receiverEmail:     tx.recipientEmail,                 // email destinataire
      senderEmail:       sender.email,                      // email expéditeur
      date:              dateStr,
      confirmLink:       mobileLink,                        // lien mobile
      country:           tx.country,
      securityQuestion:  tx.securityQuestion,
      senderName:        sender.fullName                    // nom expéditeur pour afficher au destinataire
    };

    // ── (1) Envoi des emails
    if (sender.email) {
      // Choisit le template HTML correspondant au statut pour l’expéditeur
      const htmlSender = {
        initiated: initiatedSenderTemplate,
        confirmed: confirmedSenderTemplate,
        cancelled: cancelledSenderTemplate
      }[status](status === 'cancelled' ? { ...dataSender, reason: tx.cancelReason } : dataSender);
      await sendEmail({ to: sender.email, subject: emailSubject, html: htmlSender });
    }
    if (receiver.email) {
      // Choisit le template HTML correspondant au statut pour le destinataire
      const htmlReceiver = {
        initiated: initiatedReceiverTemplate,
        confirmed: confirmedReceiverTemplate,
        cancelled: cancelledReceiverTemplate
      }[status](status === 'cancelled' ? { ...dataReceiver, reason: tx.cancelReason } : dataReceiver);
      await sendEmail({ to: receiver.email, subject: emailSubject, html: htmlReceiver });
    }

    // ── (2) Envoi des push notifications via Expo
    const pushMessages = [];
    [sender, receiver].forEach(u => {
      if (u.pushToken && Expo.isExpoPushToken(u.pushToken)) {
        // S’il s’agit de l’expéditeur, on prend dataSender, sinon dataReceiver
        const payload = u._id.toString() === sender._id.toString() ? dataSender : dataReceiver;
        pushMessages.push({
          to:     u.pushToken,
          sound:  'default',
          title:  emailSubject,
          body:   `Montant : ${payload.amount} ${payload.currency}`,
          data:   payload
        });
      }
    });
    for (const chunk of expo.chunkPushNotifications(pushMessages)) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (e) {
        console.error(e);
      }
    }

    // ── (3) Sauvegarde des événements pour le traitement asynchrone (Outbox + In-app)
    const events = [sender, receiver].map(u => ({
      service: 'notifications',
      event:   `transaction_${status}`,
      payload: {
        userId: u._id,
        type:   `transaction_${status}`,
        data:   u._id.toString() === sender._id.toString() ? dataSender : dataReceiver
      }
    }));
    await Outbox.insertMany(events, { session });

    // Crée les documents in-app dans Notification pour qu’ils apparaissent en front
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


// ───────────────────────────────────────────────────────────────────────────────────
// Liste des transactions internes (sans populate) 
// ───────────────────────────────────────────────────────────────────────────────────

exports.listInternal = async (req, res, next) => {
  try {
    // Récupère l’ID de l’utilisateur authentifié (authMiddleware ajoute req.user)
    const userId = req.user.id;
    const Transaction = TransactionModel();

    // On recherche toutes les transactions où l’utilisateur est soit expéditeur, soit destinataire
    // Pas de populate : on utilise directement les champs senderName, senderEmail, nameDestinataire, recipientEmail déjà stockés
    const txs = await Transaction.find({
      $or: [
        { sender: userId },
        { receiver: userId }
      ]
    })
      .sort({ createdAt: -1 })  // Tri par date de création décroissante
      .lean();                  // On demande un objet JavaScript brut (pas de document Mongoose)

    // Chaque tx renvoyée contient :
    //   - senderName       : nom complet de l’expéditeur (string)
    //   - senderEmail      : email de l’expéditeur (string)
    //   - receiver (ObjectId) et nameDestinataire / recipientEmail  : informations sur le destinataire
    //   - amount, transactionFees, senderCurrencySymbol, localAmount, localCurrencySymbol, country, destination, status, createdAt, etc.

    res.json({ success: true, count: txs.length, data: txs });
  } catch (err) {
    // En cas d’erreur, on passe au middleware d’erreur
    next(err);
  }
};


// ───────────────────────────────────────────────────────────────────────────────────
// Détail d’une transaction interne par ID (sans populate)
// ───────────────────────────────────────────────────────────────────────────────────

exports.getTransactionController = async (req, res, next) => {
  try {
    // 1) On récupère l’ID de la transaction depuis le paramètre d’URL
    const { id } = req.params;

    // 2) On récupère l’utilisateur connecté pour vérifier l’autorisation
    const userId = req.user.id;

    // 3) On cherche la transaction par son _id
    //    On ne fait pas de populate sur User : on s’appuie sur senderName, senderEmail, etc. stockés en base
    const tx = await TransactionModel().findById(id).lean();

    // 4) Si la transaction n’existe pas, on renvoie 404
    if (!tx) {
      return res.status(404).json({
        success: false,
        message: 'Transaction non trouvée',
      });
    }

    // 5) On vérifie que l’utilisateur connecté est soit expéditeur, soit destinataire
    const isSender   = tx.sender?.toString()   === userId;
    const isReceiver = tx.receiver?.toString() === userId;
    if (!isSender && !isReceiver) {
      // Si l’utilisateur n’est pas lié à cette transaction, on renvoie 404 pour masquer l’existence
      return res.status(404).json({
        success: false,
        message: 'Transaction non trouvée',
      });
    }

    // 6) Tout est OK : on renvoie la transaction brute
    //    Contient senderName, senderEmail, nameDestinataire, recipientEmail, amount, localAmount, status, etc.
    return res.status(200).json({
      success: true,
      data: tx,
    });
  } catch (err) {
    // En cas d’erreur, on transmet au middleware d’erreur
    next(err);
  }
};


// ───────────────────────────────────────────────────────────────────────────────────
// ─── INITIATE INTERNAL ────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────────────

exports.initiateInternal = async (req, res, next) => {
  // Démarre une session MongoDB pour assurer l’atomicité
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // ─── 1) Lecture du corps de la requête (req.body) ─────────────────────────────
    const {
      toEmail,
      amount,
      transactionFees = 0,
      senderCurrencySymbol,
      localCurrencySymbol,
      recipientInfo = {},   // ex. { name: 'Jean Dupont' }
      description = '',
      question,
      securityCode,
      destination,
      funds,
      country
    } = req.body;

    // ─── 2) Validations basiques ──────────────────────────────────────────────────
    if (!sanitize(toEmail)) {
      throw createError(400, 'Email du destinataire requis');
    }
    if (!question || !securityCode) {
      throw createError(400, 'Question et code de sécurité requis');
    }
    if (!destination || !funds || !country) {
      throw createError(400, 'Données de transaction incomplètes');
    }
    if (description.length > MAX_DESC_LENGTH) {
      throw createError(400, 'Description trop longue');
    }

    // ─── 3) Récupération de l’utilisateur expéditeur (req.user.id) ────────────────
    const senderId   = req.user.id;
    // Sélectionne uniquement fullName + email
    const senderUser = await User.findById(senderId).select('fullName email').lean();
    if (!senderUser) {
      throw createError(403, 'Utilisateur invalide');
    }

    // ─── 4) Recherche du destinataire par email ───────────────────────────────────
    const receiver = await User.findOne({ email: sanitize(toEmail) }).lean();
    if (!receiver) {
      throw createError(404, 'Destinataire introuvable');
    }
    if (receiver._id.toString() === senderId) {
      throw createError(400, 'Auto-transfert impossible');
    }

    // ─── 5) Vérification du montant + frais ─────────────────────────────────────
    const amt  = parseFloat(amount);
    const fees = parseFloat(transactionFees);
    if (isNaN(amt) || amt <= 0) {
      throw createError(400, 'Montant invalide');
    }
    if (isNaN(fees) || fees < 0) {
      throw createError(400, 'Frais invalides');
    }
    const total = amt + fees;

    // ─── 6) Vérification & débit du solde de l’expéditeur ────────────────────────
    const balDoc = await Balance.findOne({ user: senderId }).session(session);
    const balanceFloat = balDoc?.amount ?? 0;
    if (balanceFloat < total) {
      throw createError(400, `Solde insuffisant : ${balanceFloat.toFixed(2)}`);
    }
    const debited = await Balance.findOneAndUpdate(
      { user: senderId },
      { $inc: { amount: -total } },
      { new: true, session }
    );
    if (!debited) {
      throw createError(500, 'Erreur lors du débit');
    }

    // ─── 7) Conversion du montant principal en devise locale ──────────────────────
    const { rate, converted } = await convertAmount(senderCurrencySymbol, localCurrencySymbol, amt);

    // ─── 8) Préparation des valeurs au format Decimal128 pour MongoDB ──────────────
    const decAmt      = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
    const decFees     = mongoose.Types.Decimal128.fromString(fees.toFixed(2));
    const decLocal    = mongoose.Types.Decimal128.fromString(converted.toFixed(2));
    const decExchange = mongoose.Types.Decimal128.fromString(rate.toString());

    // ─── 9) Détermine le nom du destinataire à afficher : soit recipientInfo.name soit fullName de l’expéditeur
    const nameDest = sanitize(recipientInfo.name) || senderUser.fullName;

    // ─── 10) Création du document Transaction ─────────────────────────────────────
    //     On inclut ici également le nom / email expéditeur et destinataire afin
    //     que ces champs soient disponibles directement lors du listInternal() côté front.
    //     Si vous préférez ne pas les dupliquer, vous pouvez aussi faire un populate() sur listInternal.
    const [tx] = await TransactionModel().create([{
      // ── Références aux ObjectId des utilisateurs
      sender:               senderUser._id,             // _id de l’expéditeur
      receiver:             receiver._id,               // _id du destinataire

      // ── Montants & devises
      amount:               decAmt,                     // montant principal (Decimal128)
      transactionFees:      decFees,                    // frais de transaction (Decimal128)
      senderCurrencySymbol: sanitize(senderCurrencySymbol),
      exchangeRate:         decExchange,                // taux de change (Decimal128)
      localAmount:          decLocal,                   // montant local (Decimal128)
      localCurrencySymbol:  sanitize(localCurrencySymbol),

      // ── Infos sur les noms / emails (pour éviter un populate systématique ensuite)
      //    On stocke dans le document pour que listInternal renvoie directement tx.senderName, tx.senderEmail, etc.
      senderName:           senderUser.fullName,        // nom complet de l’expéditeur
      senderEmail:          senderUser.email,           // email de l’expéditeur
      nameDestinataire:     nameDest,                   // nom du destinataire tel que fourni / fallback
      recipientEmail:       sanitize(toEmail),          // email du destinataire

      // ── Autres champs
      country:              sanitize(country),          // pays (ex. "CIA")
      description:          sanitize(description),
      securityQuestion:     sanitize(question),
      securityCode:         sanitize(securityCode),
      destination:          sanitize(destination),      // ex. "PayNoval" | "Bank" | "MobileMoney"
      funds:                sanitize(funds),            // ex. "Solde PayNoval"
      status:               'pending'                   // statut initial : 'pending'
    }], { session });

    // ─── 11) Notifications "initiated" ───────────────────────────────────────────
    await notifyParties(tx, 'initiated', session, senderCurrencySymbol);

    // ─── 12) Commit de la transaction MongoDB ────────────────────────────────────
    await session.commitTransaction();

    // ─── 13) Renvoie au front : on transmet l’ID de la transaction créée.
    //     Depuis le front, après réception de transactionId, on pourra appeler
    //     listInternal() ou getTransaction pour avoir tous les détails.
    res.status(201).json({ success: true, transactionId: tx._id.toString() });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};


// ───────────────────────────────────────────────────────────────────────────────────
// ─── CONFIRM INTERNAL ──────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────────────

exports.confirmController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { transactionId, securityCode } = req.body;

    if (!transactionId || !securityCode) {
      throw createError(400, 'Paramètres manquants');
    }

    // 1) Récupère la transaction en session + vérifie le statut
    const tx = await TransactionModel().findById(transactionId)
      .select('+securityCode +localAmount +senderCurrencySymbol +receiver +sender')
      .session(session);

    if (!tx || tx.status !== 'pending') {
      throw createError(400, 'Transaction invalide ou déjà traitée');
    }
    if (String(tx.receiver) !== String(req.user.id)) {
      throw createError(403, 'Vous n’êtes pas le destinataire');
    }

    // 2) Vérification du code de sécurité
    if (sanitize(securityCode) !== tx.securityCode) {
      // Si code incorrect, on notifie d’abord la partie, on annule, puis on renvoie une erreur
      await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
      throw createError(401, 'Code de sécurité incorrect');
    }

    // 3) Créditer le destinataire avec le montant local
    const localAmtFloat = parseFloat(tx.localAmount.toString());
    const credited = await Balance.findOneAndUpdate(
      { user: tx.receiver },
      { $inc: { amount: localAmtFloat } },
      { new: true, upsert: true, session }
    );
    if (!credited) {
      throw createError(500, 'Erreur lors du crédit');
    }

    // 4) Mise à jour du statut de la transaction en 'confirmed'
    tx.status      = 'confirmed';
    tx.confirmedAt = new Date();
    await tx.save({ session });

    // 5) Notifications "confirmed"
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


// ───────────────────────────────────────────────────────────────────────────────────
// ─── CANCEL INTERNAL ───────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────────────

exports.cancelController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { transactionId, reason = 'Annulé', senderCurrencySymbol } = req.body;

    if (!transactionId) {
      throw createError(400, 'ID de transaction requis');
    }

    // 1) Récupère la transaction + vérifie le statut
    const tx = await TransactionModel().findById(transactionId)
      .select('+amount +transactionFees +sender +receiver')
      .session(session);

    if (!tx || tx.status !== 'pending') {
      throw createError(400, 'Transaction invalide ou déjà traitée');
    }

    // 2) Vérifie que l’utilisateur connecté est bien expéditeur OU destinataire
    const userId     = String(req.user.id);
    const senderId   = String(tx.sender);
    const receiverId = String(tx.receiver);
    if (userId !== senderId && userId !== receiverId) {
      throw createError(403, 'Vous n’êtes pas autorisé à annuler');
    }

    // 3) Calcul du remboursement (99% du montant brut)
    const amtFloat  = parseFloat(tx.amount.toString());
    const feesFloat = parseFloat(tx.transactionFees.toString());
    const gross     = amtFloat + feesFloat;
    const netRefund = parseFloat((gross * 0.99).toFixed(2));

    // 4) Rembourse l’expéditeur
    await Balance.findOneAndUpdate(
      { user: tx.sender },
      { $inc: { amount: netRefund } },
      { new: true, upsert: true, session }
    );

    // 5) Mise à jour du statut en 'cancelled'
    tx.status        = 'cancelled';
    tx.cancelledAt   = new Date();
    tx.cancelReason  = `${userId === receiverId
      ? 'Annulé par le destinataire'
      : 'Annulé par l’expéditeur'} : ${sanitize(reason)}`;
    await tx.save({ session });

    // 6) Notifications "cancelled"
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
