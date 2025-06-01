// src/controllers/transactionsController.js

const axios                       = require('axios');
const config                      = require('../config');
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

const PRINCIPAL_URL = config.principalUrl; // URL du backend principal (pour l’envoi de push)



// ─── CONST & HELPERS ─────────────────────────────────────────────────────────
const sanitize        = text => String(text || '').replace(/[<>\\/{};]/g, '').trim();
const MAX_DESC_LENGTH = 500;



// /**
//  * notifyParties: envoie notifications email, push & in-app pour expéditeur et destinataire
//  *  - tx : document Transaction (Mongoose)
//  *  - status : 'initiated' | 'confirmed' | 'cancelled'
//  *  - session : session MongoDB pour la transaction
//  *  - senderCurrency : symbole de la devise de l’expéditeur (par ex. 'F CFA')
//  */
// async function notifyParties(tx, status, session, senderCurrency) {
//   try {
//     const subjectMap = { 
//       initiated: 'Transaction en attente', 
//       confirmed: 'Transaction confirmée', 
//       cancelled: 'Transaction annulée' 
//     };
//     const emailSubject = subjectMap[status] || `Transaction ${status}`;

//     // ── Récupère l’expéditeur (sender) et le destinataire (receiver) depuis la collection Users
//     const [sender, receiver] = await Promise.all([
//       User.findById(tx.sender).select('email pushToken fullName').lean(),
//       User.findById(tx.receiver).select('email pushToken fullName').lean()
//     ]);

//     // Formate la date pour les emails et notifications
//     const dateStr = new Date().toLocaleString('fr-FR');

//     // Liens de confirmation (web + mobile) pour inclusion dans les emails/notifications
//     const webLink    = `https://panoval.com/confirm/${tx._id}?token=${tx.verificationToken}`;
//     const mobileLink = `panoval://confirm/${tx._id}?token=${tx.verificationToken}`;

//     // ── Prépare le payload envoyé à l’expéditeur
//     const dataSender = {
//       transactionId:     tx._id.toString(),
//       amount:            tx.amount.toString(),              // montant principal
//       currency:          senderCurrency,                    // symbole de la devise expéditeur
//       name:              sender.fullName,                   // nom complet de l’expéditeur
//       senderEmail:       sender.email,                      // email expéditeur
//       receiverEmail:     tx.recipientEmail || receiver.email, // email destinataire
//       date:              dateStr,                           // date de création
//       confirmLinkWeb:    webLink,                           // lien web
//       country:           tx.country,                        // pays
//       securityQuestion:  tx.securityQuestion                // question de sécurité
//     };

//     // ── Prépare le payload envoyé au destinataire
//     const dataReceiver = {
//       transactionId:     tx._id.toString(),
//       amount:            tx.localAmount.toString(),         // montant converti dans la devise locale
//       currency:          tx.localCurrencySymbol,            // symbole de la devise locale
//       name:              tx.nameDestinataire,              // nom du destinataire tel que fourni
//       receiverEmail:     tx.recipientEmail,                 // email destinataire
//       senderEmail:       sender.email,                      // email expéditeur
//       date:              dateStr,
//       confirmLink:       mobileLink,                        // lien mobile
//       country:           tx.country,
//       securityQuestion:  tx.securityQuestion,
//       senderName:        sender.fullName                    // nom expéditeur pour afficher au destinataire
//     };

//     // ── (1) Envoi des emails
//     if (sender.email) {
//       // Choisit le template HTML correspondant au statut pour l’expéditeur
//       const htmlSender = {
//         initiated: initiatedSenderTemplate,
//         confirmed: confirmedSenderTemplate,
//         cancelled: cancelledSenderTemplate
//       }[status](status === 'cancelled' ? { ...dataSender, reason: tx.cancelReason } : dataSender);
//       await sendEmail({ to: sender.email, subject: emailSubject, html: htmlSender });
//     }
//     if (receiver.email) {
//       // Choisit le template HTML correspondant au statut pour le destinataire
//       const htmlReceiver = {
//         initiated: initiatedReceiverTemplate,
//         confirmed: confirmedReceiverTemplate,
//         cancelled: cancelledReceiverTemplate
//       }[status](status === 'cancelled' ? { ...dataReceiver, reason: tx.cancelReason } : dataReceiver);
//       await sendEmail({ to: receiver.email, subject: emailSubject, html: htmlReceiver });
//     }

//     // ── (2) Envoi des push notifications via Expo
//     const pushMessages = [];
//     [sender, receiver].forEach(u => {
//       if (u.pushToken && Expo.isExpoPushToken(u.pushToken)) {
//         // S’il s’agit de l’expéditeur, on prend dataSender, sinon dataReceiver
//         const payload = u._id.toString() === sender._id.toString() ? dataSender : dataReceiver;
//         pushMessages.push({
//           to:     u.pushToken,
//           sound:  'default',
//           title:  emailSubject,
//           body:   `Montant : ${payload.amount} ${payload.currency}`,
//           data:   payload
//         });
//       }
//     });
//     for (const chunk of expo.chunkPushNotifications(pushMessages)) {
//       try {
//         await expo.sendPushNotificationsAsync(chunk);
//       } catch (e) {
//         console.error(e);
//       }
//     }

//     // ── (3) Sauvegarde des événements pour le traitement asynchrone (Outbox + In-app)
//     const events = [sender, receiver].map(u => ({
//       service: 'notifications',
//       event:   `transaction_${status}`,
//       payload: {
//         userId: u._id,
//         type:   `transaction_${status}`,
//         data:   u._id.toString() === sender._id.toString() ? dataSender : dataReceiver
//       }
//     }));
//     await Outbox.insertMany(events, { session });

//     // Crée les documents in-app dans Notification pour qu’ils apparaissent en front
//     const inAppDocs = events.map(e => ({
//       recipient: e.payload.userId,
//       type:      e.payload.type,
//       data:      e.payload.data,
//       read:      false
//     }));
//     await Notification.insertMany(inAppDocs, { session });
//   } catch (err) {
//     console.error('notifyParties error:', err);
//   }
// }




// ───────────────────────────────────────────────────────────────────────────────────
// Liste des transactions internes (sans populate) 
// ───────────────────────────────────────────────────────────────────────────────────




/**
 * notifyParties : envoie des notifications par email, push (via le backend principal) et in-app
 * pour l'expéditeur et le destinataire d'une transaction.
 *
 * Paramètres :
 *  - tx            : document Transaction (Mongoose)
 *  - status        : 'initiated' | 'confirmed' | 'cancelled'
 *  - session       : session MongoDB (pour les opérations en transaction)
 *  - senderCurrency: symbole de la devise de l’expéditeur (ex. 'F CFA')
 */


/**
 * Fonction principale : envoie emails, push et notifications in-app
 */
async function notifyParties(tx, status, session, senderCurrency) {
  try {
    // ─── 1) Définir le sujet d'email selon le statut ────────────────────────────
    const subjectMap = {
      initiated: 'Transaction en attente',
      confirmed: 'Transaction confirmée',
      cancelled: 'Transaction annulée',
    };
    const emailSubject = subjectMap[status] || `Transaction ${status}`;

    // ─── 2) Récupérer expéditeur & destinataire (email, fullName, pushTokens) ───
    const [sender, receiver] = await Promise.all([
      User.findById(tx.sender).select('email fullName pushTokens').lean(),
      User.findById(tx.receiver).select('email fullName pushTokens').lean(),
    ]);
    if (!sender || !receiver) {
      // Si l'un des deux manque, on sort sans rien faire
      return;
    }

    // ─── 3) Formatage de la date (locale française) ─────────────────────────────
    const dateStr = new Date().toLocaleString('fr-FR');

    // ─── 4) Construire les liens de confirmation (web + mobile) ──────────────────
    const webLink    = `${PRINCIPAL_URL}/confirm/${tx._id}?token=${tx.verificationToken}`;
    const mobileLink = `panoval://confirm/${tx._id}?token=${tx.verificationToken}`;

    // ─── 5) Préparer le payload pour l'expéditeur ────────────────────────────────
    const dataSender = {
      transactionId:    tx._id.toString(),
      amount:           tx.amount.toString(),                      // montant brut
      currency:         senderCurrency,                            // devise expéditeur
      name:             sender.fullName,                           // nom complet expéditeur
      senderEmail:      sender.email,                              // email expéditeur
      receiverEmail:    tx.recipientEmail || receiver.email,       // email destinataire
      date:             dateStr,                                    // date de création
      confirmLinkWeb:   webLink,                                    // lien web de confirmation
      country:          tx.country,                                 // pays
      securityQuestion: tx.securityQuestion,                        // question de sécurité
    };

    // ─── 6) Préparer le payload pour le destinataire ────────────────────────────
    const dataReceiver = {
      transactionId:     tx._id.toString(),
      amount:            tx.localAmount.toString(),                // montant converti local
      currency:          tx.localCurrencySymbol,                   // devise locale
      name:              tx.nameDestinataire,                      // nom destinataire
      receiverEmail:     tx.recipientEmail,                        // email destinataire
      senderEmail:       sender.email,                             // email expéditeur
      date:              dateStr,
      confirmLink:       mobileLink,                                // lien mobile de confirmation
      country:           tx.country,
      securityQuestion:  tx.securityQuestion,
      senderName:        sender.fullName,                           // nom expéditeur
    };

    // ─── (A) Envoi des e-mails ───────────────────────────────────────────────────
    if (sender.email) {
      // Choisir le template approprié selon le statut, en passant dataSender
      const htmlSender = {
        initiated: initiatedSenderTemplate,
        confirmed: confirmedSenderTemplate,
        cancelled: cancelledSenderTemplate,
      }[status](
        status === 'cancelled'
          ? { ...dataSender, reason: tx.cancelReason }
          : dataSender
      );
      await sendEmail({
        to:      sender.email,
        subject: emailSubject,
        html:    htmlSender,
      });
    }

    if (receiver.email) {
      // Choisir le template approprié selon le statut, en passant dataReceiver
      const htmlReceiver = {
        initiated: initiatedReceiverTemplate,
        confirmed: confirmedReceiverTemplate,
        cancelled: cancelledReceiverTemplate,
      }[status](
        status === 'cancelled'
          ? { ...dataReceiver, reason: tx.cancelReason }
          : dataReceiver
      );
      await sendEmail({
        to:      receiver.email,
        subject: emailSubject,
        html:    htmlReceiver,
      });
    }

    // ─── (B) Envoi des push via le Backend Principal ──────────────────────────────
    // Messages succincts pour la notification push
    const messageForSender   = `Transaction #${tx._id} : ${tx.amount} ${senderCurrency} (${status})`;
    const messageForReceiver = `Transaction #${tx._id} : ${tx.localAmount} ${tx.localCurrencySymbol} (${status})`;

    // Fonction interne pour déclencher le push via l’endpoint interne du principal
    async function triggerPush(userId, message) {
      try {
        await axios.post(
          `${PRINCIPAL_URL}/internal/notify`,
          { userId, message },
          { headers: { 'Content-Type': 'application/json' } }
        );
      } catch (err) {
        console.warn(`Échec push pour user ${userId}: ${err.message}`);
      }
    }

    // B.1) Notifier l'expéditeur
    if (sender.pushTokens && sender.pushTokens.length) {
      await triggerPush(sender._id.toString(), messageForSender);
    }

    // B.2) Notifier le destinataire
    if (receiver.pushTokens && receiver.pushTokens.length) {
      await triggerPush(receiver._id.toString(), messageForReceiver);
    }

    // ─── (C) Persister les événements Outbox pour trace/audit ────────────────────
    const events = [sender, receiver].map((u) => ({
      service: 'notifications',
      event:   `transaction_${status}`,
      payload: {
        userId: u._id.toString(),
        type:   `transaction_${status}`,
        data:   u._id.toString() === sender._id.toString() ? dataSender : dataReceiver,
      },
    }));
    // Insertion en une seule opération, dans la session fournie
    await Outbox.insertMany(events, { session });

    // ─── (D) Création des notifications in-app (collection Notification) ─────────
    const inAppDocs = events.map((e) => ({
      recipient: e.payload.userId,
      type:      e.payload.type,
      data:      e.payload.data,
      read:      false,
      date:      new Date(), // date de création de la notification in-app
    }));
    // Insertion en une seule opération, dans la même session Mongo
    await Notification.insertMany(inAppDocs, { session });

  } catch (err) {
    console.error('notifyParties : erreur lors de l’envoi des notifications', err);
    // On nève pas l’erreur pour ne pas interrompre la logique transactionnelle principale
  }
}


















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

/**
 * POST /api/v1/transactions/initiateInternal
 *
 * Initiation d’une transaction interne PayNoval :
 *  - Calcul des frais à 1% du montant saisi
 *  - Débit du montant brut (amount) du compte expéditeur
 *  - Conversion de ces frais en CAD (devise du compte admin) avant crédit
 *  - Crédit immédiat des frais convertis au compte admin@paynoval.com
 *  - Création d’une transaction en statut 'pending' avec amount, transactionFees, netAmount, etc.
 *  - Le destinataire ne reçoit rien pour l’instant : il sera crédité lors de la confirmation
 */
exports.initiateInternal = async (req, res, next) => {
  // Démarre une session MongoDB pour assurer l’atomicité
  const session = await mongoose.startSession();
  
  try {
    session.startTransaction();

    // ─── 1) Lecture du corps de la requête ─────────────────────────────────────────
    const {
      toEmail,
      amount,
      senderCurrencySymbol,
      localCurrencySymbol,
      recipientInfo = {},   // { name: 'Jean Elossy', phone: '...' } éventuel
      description = '',
      question,
      securityCode,
      destination,
      funds,
      country
    } = req.body;

    // ─── 2) Validations basiques ──────────────────────────────────────────────────
    if (!toEmail || !sanitize(toEmail)) {
      throw createError(400, 'Email du destinataire requis');
    }
    if (!question || !securityCode) {
      throw createError(400, 'Question et code de sécurité requis');
    }
    if (!destination || !funds || !country) {
      throw createError(400, 'Données de transaction incomplètes');
    }
    if (description && description.length > MAX_DESC_LENGTH) {
      throw createError(400, 'Description trop longue');
    }

    // ─── 3) Récupération de l’utilisateur expéditeur ───────────────────────────────
    const senderId   = req.user.id;
    // On veut uniquement le nom complet et l’email pour duplication dans Transaction
    const senderUser = await User.findById(senderId)
      .select('fullName email')
      .lean()
      .session(session);
    if (!senderUser) {
      throw createError(403, 'Utilisateur invalide');
    }

    // ─── 4) Recherche du destinataire par email ───────────────────────────────────
    const receiver = await User.findOne({ email: sanitize(toEmail) })
      .select('_id fullName email')
      .lean()
      .session(session);
    if (!receiver) {
      throw createError(404, 'Destinataire introuvable');
    }
    if (receiver._id.toString() === senderId) {
      throw createError(400, 'Auto-transfert impossible');
    }

    // ─── 5) Vérification du montant saisi ────────────────────────────────────────
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      throw createError(400, 'Montant invalide');
    }

    // ─── 6) Calcul des frais (1 %) et montant net ─────────────────────────────────
    const fee       = parseFloat((amt * 0.01).toFixed(2));      // 1 % arrondi à 2 décimales
    const netAmount = parseFloat((amt - fee).toFixed(2));       // Montant à envoyer au destinataire

    // ─── 7) Vérification du solde de l’expéditeur et débit du montant brut ──────
    const balDoc = await Balance.findOne({ user: senderId }).session(session);
    const balanceFloat = balDoc?.amount ?? 0;
    if (balanceFloat < amt) {
      throw createError(400, `Solde insuffisant : ${balanceFloat.toFixed(2)}`);
    }
    // Débite amt (montant brut) du compte expéditeur
    const debited = await Balance.findOneAndUpdate(
      { user: senderId },
      { $inc: { amount: -amt } },
      { new: true, session }
    );
    if (!debited) {
      throw createError(500, 'Erreur lors du débit du compte expéditeur');
    }

    // ─── 8) Crédit immédiat des frais convertis au compte admin@paynoval.com ───────
    // On convertit d’abord fee (devise expéditeur) → CAD (devise admin)
    let adminFeeInCAD = 0;
    if (fee > 0) {
      const { converted } = await convertAmount(
        senderCurrencySymbol,
        'CAD',
        fee
      );
      adminFeeInCAD = parseFloat(converted.toFixed(2));
    }
    // On récupère le compte admin
    const adminEmail = 'admin@paynoval.com';
    const adminUser = await User.findOne({ email: adminEmail })
      .select('_id')
      .session(session);
    if (!adminUser) {
      throw createError(500, 'Compte administrateur introuvable');
    }
    // On crédite admin du montant converti en CAD
    await Balance.findOneAndUpdate(
      { user: adminUser._id },
      { $inc: { amount: adminFeeInCAD } },
      { new: true, upsert: true, session }
    );

    // ─── 9) Conversion du montant principal en devise locale ──────────────────────
    const { rate, converted } = await convertAmount(
      senderCurrencySymbol,
      localCurrencySymbol,
      amt
    );
    // rate = taux de change, converted = amt converti dans la devise locale

    // ─── 10) Formatage en Decimal128 pour MongoDB ─────────────────────────────────
    const decAmt      = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
    const decFees     = mongoose.Types.Decimal128.fromString(fee.toFixed(2));
    const decNet      = mongoose.Types.Decimal128.fromString(netAmount.toFixed(2));
    const decLocal    = mongoose.Types.Decimal128.fromString(converted.toFixed(2));
    const decExchange = mongoose.Types.Decimal128.fromString(rate.toString());

    // ─── 11) Détermine le nom du destinataire à afficher ──────────────────────────
    const nameDest = recipientInfo.name && sanitize(recipientInfo.name)
      ? sanitize(recipientInfo.name)
      : receiver.fullName;

    // ─── 12) Création du document Transaction en statut 'pending' ────────────────
    const [tx] = await TransactionModel().create(
      [
        {
          // Références aux utilisateurs
          sender:               senderUser._id,     // ObjectId de l’expéditeur
          receiver:             receiver._id,       // ObjectId du destinataire

          // Montants & frais
          amount:               decAmt,             // Montant brut (Decimal128)
          transactionFees:      decFees,            // Frais (1 %) (Decimal128)
          netAmount:            decNet,             // Montant net à créditer (Decimal128)

          // Devises & conversion
          senderCurrencySymbol: sanitize(senderCurrencySymbol), // ex. "F CFA"
          exchangeRate:         decExchange,        // Taux de change (Decimal128)
          localAmount:          decLocal,           // Montant local (Decimal128)
          localCurrencySymbol:  sanitize(localCurrencySymbol),

          // Infos pour affichage rapide (évite un populate systématique)
          senderName:           senderUser.fullName,    // ex. "Alice Dupont"
          senderEmail:          senderUser.email,       // ex. "alice@paynoval.com"
          nameDestinataire:     nameDest,               // ex. "Jean Elossy"
          recipientEmail:       sanitize(toEmail),      // ex. "jean@example.com"

          // Détails transactionnels
          country:              sanitize(country),      // ex. "Côte d'Ivoire"
          description:          sanitize(description),
          securityQuestion:     sanitize(question),
          securityCode:         sanitize(securityCode),
          destination:          sanitize(destination),  // ex. "PayNoval"
          funds:                sanitize(funds),        // ex. "Solde PayNoval"
          status:               'pending'
        }
      ],
      { session }
    );

    // ─── 13) Envoi d’une notification d’initiation aux parties concernées ─────────
    await notifyParties(tx, 'initiated', session, senderCurrencySymbol);

    // ─── 14) Commit de la transaction MongoDB ────────────────────────────────────
    await session.commitTransaction();
    session.endSession();

    // ─── 15) Réponse au front : on retourne l’ID de la transaction créée ─────────
    return res.status(201).json({
      success: true,
      transactionId: tx._id.toString(),
      adminFeeInCAD
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
};




// ───────────────────────────────────────────────────────────────────────────────────
// ─── CONFIRM INTERNAL ──────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/v1/transactions/confirm
 *
 * Lors de la confirmation :
 *  - Vérifier securityCode.
 *  - Si valide : 
 *      • Calculer net = amount brut – 1% de frais.
 *      • Convertir ce net dans la devise locale du destinataire.
 *      • Créditer le solde du destinataire de ce montant converti.
 *      • Mettre status = 'confirmed', fixed confirmedAt, notifier.
 *  - Si code incorrect :
 *      • Mettre status = 'cancelled', fixed cancelledAt, notifier, renvoyer erreur.
 */
exports.confirmController = async (req, res, next) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    // ─── 1) Lecture des paramètres ───────────────────────────────────────────────
    const { transactionId, securityCode } = req.body;
    if (!transactionId || !securityCode) {
      throw createError(400, 'transactionId et securityCode sont requis');
    }

    // ─── 2) Récupérer la transaction en session ──────────────────────────────────
    //     On a besoin de amount (montant brut), localCurrencySymbol (devise du destinataire),
    //     senderCurrencySymbol (pour notifications), receiver (ID destinataire), sender
    const tx = await TransactionModel()
      .findById(transactionId)
      .select([
        '+securityCode',
        '+amount',
        '+senderCurrencySymbol',
        '+localCurrencySymbol',
        '+receiver',
        '+sender'
      ])
      .session(session);

    if (!tx || tx.status !== 'pending') {
      throw createError(400, 'Transaction invalide ou déjà traitée');
    }

    // ─── 3) Vérification que l’utilisateur connecté est bien le destinataire ─────
    if (String(tx.receiver) !== String(req.user.id)) {
      throw createError(403, 'Vous n’êtes pas le destinataire de cette transaction');
    }

    // ─── 4) Vérification du code de sécurité ─────────────────────────────────────
    const sanitizedCode = sanitize(securityCode);
    if (sanitizedCode !== tx.securityCode) {
      // Code incorrect : annuler et notifier
      tx.status      = 'cancelled';
      tx.cancelledAt = new Date();
      await tx.save({ session });

      await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
      throw createError(401, 'Code de sécurité incorrect');
    }

    // ─── 5) Calcul du montant net à créditer ──────────────────────────────────────
    //     5.1) Récupérer montants
    const amtFloat = parseFloat(tx.amount.toString()); // montant brut en devise expéditeur
    if (amtFloat <= 0) {
      throw createError(500, 'Montant brut invalide en base');
    }
    //     5.2) Calculer frais = 1% du brut, puis net = brut – frais
    const fee    = parseFloat((amtFloat * 0.01).toFixed(2));
    const netBrut = parseFloat((amtFloat - fee).toFixed(2));

    //     5.3) Convertir netBrut dans la devise locale du destinataire
    //          tx.localCurrencySymbol est la devise du destinataire
    const { converted: localNet } = await convertAmount(
      tx.senderCurrencySymbol,
      tx.localCurrencySymbol,
      netBrut
    );
    const localNetRounded = parseFloat(localNet.toFixed(2));

    // ─── 6) Créditer le solde du destinataire ─────────────────────────────────────
    const credited = await Balance.findOneAndUpdate(
      { user: tx.receiver },
      { $inc: { amount: localNetRounded } },
      { new: true, upsert: true, session }
    );
    if (!credited) {
      throw createError(500, 'Erreur lors du crédit au destinataire');
    }

    // ─── 7) Mise à jour du statut en 'confirmed' ─────────────────────────────────
    tx.status      = 'confirmed';
    tx.confirmedAt = new Date();
    await tx.save({ session });

    // ─── 8) Notifications "confirmed" ─────────────────────────────────────────
    await notifyParties(tx, 'confirmed', session, tx.senderCurrencySymbol);

    // ─── 9) Commit de la transaction MongoDB ───────────────────────────────────
    await session.commitTransaction();
    session.endSession();

    // ─── 10) Réponse au front ───────────────────────────────────────────────────
    return res.json({ success: true, credited: localNetRounded });
  } catch (err) {
    // Rollback en cas d’erreur
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
};





// ───────────────────────────────────────────────────────────────────────────────────
// ─── CANCEL INTERNAL ───────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────────────



/**
 * POST /api/v1/transactions/cancel
 *
 * Lors de l’annulation :
 *  1) Vérifier transactionId.
 *  2) Récupérer la transaction (netAmount, amount, senderCurrencySymbol, sender, receiver).
 *  3) Vérifier que l’utilisateur est expéditeur ou destinataire.
 *  4) Calculer les frais d’annulation selon la devise de l’expéditeur :
 *       – 2,99 $ USD pour USA
 *       – 2,99 $ CAD pour Canada
 *       – 2,99 € pour Europe
 *       – 300 F CFA pour Afrique
 *  5) Calculer refundAmt = tx.netAmount (en devise expéditeur) – cancellationFee.
 *  6) Créditer l’expéditeur de refundAmt (devise expéditeur).
 *  7) Convertir cancellationFee dans la devise du compte admin (ex. “CAD”), arrondir.
 *  8) Créditer le compte admin@paynoval.com du montant converti (devise admin).
 *  9) Mettre à jour le statut en 'cancelled', fixed cancelledAt et cancelReason.
 * 10) Notifier les parties.
 */
exports.cancelController = async (req, res, next) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    // ─── 1) Lecture des paramètres ───────────────────────────────────────────────
    const { transactionId, reason = 'Annulé', senderCurrencySymbol } = req.body;
    if (!transactionId) {
      throw createError(400, 'transactionId requis pour annuler');
    }

    // ─── 2) Récupération de la transaction ───────────────────────────────────────
    const tx = await TransactionModel()
      .findById(transactionId)
      .select([
        '+netAmount',
        '+amount',
        '+senderCurrencySymbol',
        '+sender',
        '+receiver'
      ])
      .session(session);

    if (!tx || tx.status !== 'pending') {
      throw createError(400, 'Transaction invalide ou déjà traitée');
    }

    // ─── 3) Vérifier que l’utilisateur est expéditeur OU destinataire ────────────
    const userId     = String(req.user.id);
    const senderId   = String(tx.sender);
    const receiverId = String(tx.receiver);
    if (userId !== senderId && userId !== receiverId) {
      throw createError(403, 'Vous n’êtes pas autorisé à annuler cette transaction');
    }

    // ─── 4) Calcul des frais d’annulation selon la devise expéditeur ──────────────
    let cancellationFee = 0;
    const symbol = tx.senderCurrencySymbol.trim();
    if (symbol === 'USD' || symbol === '$USD') {
      cancellationFee = 2.99;
    } else if (symbol === 'CAD' || symbol === '$CAD') {
      cancellationFee = 2.99;
    } else if (symbol === 'EUR' || symbol === '€') {
      cancellationFee = 2.99;
    } else if (symbol === 'XOF' || symbol === 'XAF' || symbol === 'F CFA') {
      cancellationFee = 300;
    }

    // ─── 5) Calcul du montant à rembourser à l’expéditeur ──────────────────────────
    const netStored  = parseFloat(tx.netAmount.toString());              // netAmount en devise expéditeur
    const refundAmt  = parseFloat((netStored - cancellationFee).toFixed(2));
    if (refundAmt < 0) {
      throw createError(400, 'Frais d’annulation supérieurs au montant net à rembourser');
    }

    // ─── 6) Crédit du solde expéditeur (devise expéditeur) ───────────────────────
    const refunded = await Balance.findOneAndUpdate(
      { user: tx.sender },
      { $inc: { amount: refundAmt } },
      { new: true, upsert: true, session }
    );
    if (!refunded) {
      throw createError(500, 'Erreur lors du remboursement au compte expéditeur');
    }

    // ─── 7) Conversion des frais dans la devise du compte admin ──────────────────
    // Suppose que le compte admin utilise toujours la devise "CAD"
    const adminCurrency = 'CAD';
    let adminFeeConverted = 0;
    if (cancellationFee > 0) {
      // Convertir cancellationFee (en devise expéditeur) → adminCurrency
      const { converted } = await convertAmount(
        tx.senderCurrencySymbol,
        adminCurrency,
        cancellationFee
      );
      adminFeeConverted = parseFloat(converted.toFixed(2));
    }

    // ─── 8) Crédit du compte admin@paynoval.com (devise admin) ──────────────────
    const adminEmail = 'admin@paynoval.com';
    const adminUser  = await User.findOne({ email: adminEmail })
      .select('_id')
      .session(session);
    if (!adminUser) {
      throw createError(500, 'Compte administrateur introuvable');
    }
    if (adminFeeConverted > 0) {
      await Balance.findOneAndUpdate(
        { user: adminUser._id },
        { $inc: { amount: adminFeeConverted } },
        { new: true, upsert: true, session }
      );
    }

    // ─── 9) Mise à jour de la transaction en 'cancelled' ─────────────────────────
    tx.status       = 'cancelled';
    tx.cancelledAt  = new Date();
    tx.cancelReason = `${userId === receiverId
      ? 'Annulé par le destinataire'
      : 'Annulé par l’expéditeur'} : ${sanitize(reason)}`;
    await tx.save({ session });

    // ─── 10) Notifications "cancelled" ───────────────────────────────────────────
    await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);

    // ─── 11) Commit de la session MongoDB ────────────────────────────────────────
    await session.commitTransaction();
    session.endSession();

    // ─── 12) Réponse au front avec refund et adminFeeConverted ────────────────────
    return res.json({
      success: true,
      refunded: refundAmt,
      cancellationFeeInSenderCurrency: cancellationFee,
      adminFeeCredited: adminFeeConverted,
      adminCurrency: adminCurrency
    });
  } catch (err) {
    // Rollback en cas d’erreur
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
};