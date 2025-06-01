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

// exports.initiateInternal = async (req, res, next) => {
//   // Démarre une session MongoDB pour assurer l’atomicité
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();

//     // ─── 1) Lecture du corps de la requête (req.body) ─────────────────────────────
//     const {
//       toEmail,
//       amount,
//       transactionFees = 0,
//       senderCurrencySymbol,
//       localCurrencySymbol,
//       recipientInfo = {},   // ex. { name: 'Jean Elossy' }
//       description = '',
//       question,
//       securityCode,
//       destination,
//       funds,
//       country
//     } = req.body;

//     // ─── 2) Validations basiques ──────────────────────────────────────────────────
//     if (!sanitize(toEmail)) {
//       throw createError(400, 'Email du destinataire requis');
//     }
//     if (!question || !securityCode) {
//       throw createError(400, 'Question et code de sécurité requis');
//     }
//     if (!destination || !funds || !country) {
//       throw createError(400, 'Données de transaction incomplètes');
//     }
//     if (description.length > MAX_DESC_LENGTH) {
//       throw createError(400, 'Description trop longue');
//     }

//     // ─── 3) Récupération de l’utilisateur expéditeur (req.user.id) ────────────────
//     const senderId   = req.user.id;
//     // Sélectionne uniquement fullName + email
//     const senderUser = await User.findById(senderId).select('fullName email').lean();
//     if (!senderUser) {
//       throw createError(403, 'Utilisateur invalide');
//     }

//     // ─── 4) Recherche du destinataire par email ───────────────────────────────────
//     const receiver = await User.findOne({ email: sanitize(toEmail) }).lean();
//     if (!receiver) {
//       throw createError(404, 'Destinataire introuvable');
//     }
//     if (receiver._id.toString() === senderId) {
//       throw createError(400, 'Auto-transfert impossible');
//     }

//     // ─── 5) Vérification du montant + frais ─────────────────────────────────────
//     const amt  = parseFloat(amount);
//     const fees = parseFloat(transactionFees);
//     if (isNaN(amt) || amt <= 0) {
//       throw createError(400, 'Montant invalide');
//     }
//     if (isNaN(fees) || fees < 0) {
//       throw createError(400, 'Frais invalides');
//     }
//     const total = amt + fees;

//     // ─── 6) Vérification & débit du solde de l’expéditeur ────────────────────────
//     const balDoc = await Balance.findOne({ user: senderId }).session(session);
//     const balanceFloat = balDoc?.amount ?? 0;
//     if (balanceFloat < total) {
//       throw createError(400, `Solde insuffisant : ${balanceFloat.toFixed(2)}`);
//     }
//     const debited = await Balance.findOneAndUpdate(
//       { user: senderId },
//       { $inc: { amount: -total } },
//       { new: true, session }
//     );
//     if (!debited) {
//       throw createError(500, 'Erreur lors du débit');
//     }

//     // ─── 7) Conversion du montant principal en devise locale ──────────────────────
//     const { rate, converted } = await convertAmount(senderCurrencySymbol, localCurrencySymbol, amt);

//     // ─── 8) Préparation des valeurs au format Decimal128 pour MongoDB ──────────────
//     const decAmt      = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
//     const decFees     = mongoose.Types.Decimal128.fromString(fees.toFixed(2));
//     const decLocal    = mongoose.Types.Decimal128.fromString(converted.toFixed(2));
//     const decExchange = mongoose.Types.Decimal128.fromString(rate.toString());

//     // ─── 9) Détermine le nom du destinataire à afficher : soit recipientInfo.name soit fullName de l’expéditeur
//     const nameDest = sanitize(recipientInfo.name) || senderUser.fullName;

//     // ─── 10) Création du document Transaction ─────────────────────────────────────
//     //     On inclut ici également le nom / email expéditeur et destinataire afin
//     //     que ces champs soient disponibles directement lors du listInternal() côté front.
//     //     Si vous préférez ne pas les dupliquer, vous pouvez aussi faire un populate() sur listInternal.
//     const [tx] = await TransactionModel().create([{
//       // ── Références aux ObjectId des utilisateurs
//       sender:               senderUser._id,             // _id de l’expéditeur
//       receiver:             receiver._id,               // _id du destinataire

//       // ── Montants & devises
//       amount:               decAmt,                     // montant principal (Decimal128)
//       transactionFees:      decFees,                    // frais de transaction (Decimal128)
//       senderCurrencySymbol: sanitize(senderCurrencySymbol),
//       exchangeRate:         decExchange,                // taux de change (Decimal128)
//       localAmount:          decLocal,                   // montant local (Decimal128)
//       localCurrencySymbol:  sanitize(localCurrencySymbol),

//       // ── Infos sur les noms / emails (pour éviter un populate systématique ensuite)
//       //    On stocke dans le document pour que listInternal renvoie directement tx.senderName, tx.senderEmail, etc.
//       senderName:           senderUser.fullName,        // nom complet de l’expéditeur
//       senderEmail:          senderUser.email,           // email de l’expéditeur
//       nameDestinataire:     nameDest,                   // nom du destinataire tel que fourni / fallback
//       recipientEmail:       sanitize(toEmail),          // email du destinataire

//       // ── Autres champs
//       country:              sanitize(country),          // pays (ex. "CIA")
//       description:          sanitize(description),
//       securityQuestion:     sanitize(question),
//       securityCode:         sanitize(securityCode),
//       destination:          sanitize(destination),      // ex. "PayNoval" | "Bank" | "MobileMoney"
//       funds:                sanitize(funds),            // ex. "Solde PayNoval"
//       status:               'pending'                   // statut initial : 'pending'
//     }], { session });

//     // ─── 11) Notifications "initiated" ───────────────────────────────────────────
//     await notifyParties(tx, 'initiated', session, senderCurrencySymbol);

//     // ─── 12) Commit de la transaction MongoDB ────────────────────────────────────
//     await session.commitTransaction();

//     // ─── 13) Renvoie au front : on transmet l’ID de la transaction créée.
//     //     Depuis le front, après réception de transactionId, on pourra appeler
//     //     listInternal() ou getTransaction pour avoir tous les détails.
//     res.status(201).json({ success: true, transactionId: tx._id.toString() });
//   } catch (err) {
//     await session.abortTransaction();
//     next(err);
//   } finally {
//     session.endSession();
//   }
// };

/**
 * POST /api/v1/transactions/initiateInternal
 *
 * Initiation d’une transaction interne PayNoval :
 *  - Calcul des frais à 1% du montant saisi
 *  - Débit du montant brut (amount) du compte expéditeur
 *  - Crédit immédiat des frais (1%) au compte admin@paynoval.com
 *  - Création d’une transaction en statut 'pending' avec amount, transactionFees (1%), netAmount (amount–fee), etc.
 *  - Laisser le destinataire en attente : il recevra le netAmount au moment de la confirmation
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
    // On veut uniquement le nom complet et l’email pour duplication dans Tx
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

    // ─── 8) Crédit immédiat des frais au compte admin@paynoval.com ─────────────────
    const adminEmail = 'admin@paynoval.com';
    const adminUser = await User.findOne({ email: adminEmail })
      .select('_id')
      .session(session);
    if (!adminUser) {
      throw createError(500, 'Compte administrateur introuvable');
    }
    // On crédite fee au solde du compte admin
    await Balance.findOneAndUpdate(
      { user: adminUser._id },
      { $inc: { amount: fee } },
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
          sender:               senderUser._id,             // ObjectId de l’expéditeur
          receiver:             receiver._id,               // ObjectId du destinataire

          // Montants & frais
          amount:               decAmt,                     // Montant brut (Decimal128)
          transactionFees:      decFees,                    // Frais (1 %) (Decimal128)
          netAmount:            decNet,                     // Montant net à créditer (Decimal128)

          // Devises & conversion
          senderCurrencySymbol: sanitize(senderCurrencySymbol), // ex. "F CFA"
          exchangeRate:         decExchange,                  // Taux de change (Decimal128)
          localAmount:          decLocal,                     // Montant local (Decimal128)
          localCurrencySymbol:  sanitize(localCurrencySymbol),

          // Infos pour affichage rapide (évite un populate systématique)
          senderName:           senderUser.fullName,       // ex. "Alice Dupont"
          senderEmail:          senderUser.email,          // ex. "alice@paynoval.com"
          nameDestinataire:     nameDest,                  // ex. "Jean Elossy"
          recipientEmail:       sanitize(toEmail),         // ex. "jean@example.com"

          // Détails transactionnels
          country:              sanitize(country),         // ex. "Côte d'Ivoire"
          description:          sanitize(description),
          securityQuestion:     sanitize(question),
          securityCode:         sanitize(securityCode),
          destination:          sanitize(destination),     // ex. "PayNoval"
          funds:                sanitize(funds),           // ex. "Solde PayNoval"
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
    return res.status(201).json({ success: true, transactionId: tx._id.toString() });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
};



// ───────────────────────────────────────────────────────────────────────────────────
// ─── CONFIRM INTERNAL ──────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────────────

// exports.confirmController = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();
//     const { transactionId, securityCode } = req.body;

//     if (!transactionId || !securityCode) {
//       throw createError(400, 'Paramètres manquants');
//     }

//     // 1) Récupère la transaction en session + vérifie le statut
//     const tx = await TransactionModel().findById(transactionId)
//       .select('+securityCode +localAmount +senderCurrencySymbol +receiver +sender')
//       .session(session);

//     if (!tx || tx.status !== 'pending') {
//       throw createError(400, 'Transaction invalide ou déjà traitée');
//     }
//     if (String(tx.receiver) !== String(req.user.id)) {
//       throw createError(403, 'Vous n’êtes pas le destinataire');
//     }

//     // 2) Vérification du code de sécurité
//     if (sanitize(securityCode) !== tx.securityCode) {
//       // Si code incorrect, on notifie d’abord la partie, on annule, puis on renvoie une erreur
//       await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
//       throw createError(401, 'Code de sécurité incorrect');
//     }

//     // 3) Créditer le destinataire avec le montant local
//     const localAmtFloat = parseFloat(tx.localAmount.toString());
//     const credited = await Balance.findOneAndUpdate(
//       { user: tx.receiver },
//       { $inc: { amount: localAmtFloat } },
//       { new: true, upsert: true, session }
//     );
//     if (!credited) {
//       throw createError(500, 'Erreur lors du crédit');
//     }

//     // 4) Mise à jour du statut de la transaction en 'confirmed'
//     tx.status      = 'confirmed';
//     tx.confirmedAt = new Date();
//     await tx.save({ session });

//     // 5) Notifications "confirmed"
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


/**
 * PATCH /api/v1/transactions/confirm
 *
 * 1) Vérifie que transactionId et securityCode sont présents.
 * 2) Récupère la transaction en session pour garantir l’atomicité.
 * 3) Vérifie que le statut est 'pending' et que l’utilisateur est bien le destinataire.
 * 4) Vérifie le code de sécurité :
 *    - Si incorrect : passe le statut en 'cancelled', fixe cancelledAt, notifie, et renvoie une erreur.
 *    - Si correct   : crédite le destinataire du net amount (amount – frais),
 *                    passe le statut en 'confirmed', fixe confirmedAt, notifie, puis commit.
 */
exports.confirmController = async (req, res, next) => {
  // Démarre une session MongoDB pour garantir l’atomicité
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    // ─── 1) Lecture des paramètres nécessaires ───────────────────────────────────
    const { transactionId, securityCode } = req.body;
    if (!transactionId || !securityCode) {
      throw createError(400, 'Paramètres manquants');
    }

    // ─── 2) Récupération de la transaction (avec les champs strictement nécessaires) ──
    //     +securityCode : on veut lire le code en clair pour comparaison
    //     +netAmount    : montant à créditer
    //     +senderCurrencySymbol, +sender : pour notifications
    //     +receiver : pour vérifier que l’utilisateur est bien destinataire
    const tx = await TransactionModel()
      .findById(transactionId)
      .select('+securityCode +netAmount +senderCurrencySymbol +receiver +sender')
      .session(session);

    if (!tx || tx.status !== 'pending') {
      throw createError(400, 'Transaction invalide ou déjà traitée');
    }

    // ─── 3) Vérification que l’utilisateur connecté est bien le destinataire ───────
    if (String(tx.receiver) !== String(req.user.id)) {
      throw createError(403, 'Vous n’êtes pas le destinataire de cette transaction');
    }

    // ─── 4) Vérification du code de sécurité ─────────────────────────────────────
    const sanitizedCode = sanitize(securityCode);
    if (sanitizedCode !== tx.securityCode) {
      // Code incorrect : on passe la transaction en 'cancelled', on notifie, puis on lève l’erreur
      tx.status       = 'cancelled';
      tx.cancelledAt  = new Date();
      await tx.save({ session });

      await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
      throw createError(401, 'Code de sécurité incorrect');
    }

    // ─── 5) Code correct : on crédite le destinataire du montant net (netAmount) ────
    const netFloat = parseFloat(tx.netAmount.toString());
    const credited = await Balance.findOneAndUpdate(
      { user: tx.receiver },
      { $inc: { amount: netFloat } },
      { new: true, upsert: true, session }
    );
    if (!credited) {
      throw createError(500, 'Erreur lors du crédit du destinataire');
    }

    // ─── 6) Mise à jour du statut de la transaction en 'confirmed' ─────────────────
    tx.status      = 'confirmed';
    tx.confirmedAt = new Date();
    await tx.save({ session });

    // ─── 7) Notifications de confirmation ────────────────────────────────────────
    await notifyParties(tx, 'confirmed', session, tx.senderCurrencySymbol);

    // ─── 8) Commit de la transaction MongoDB ────────────────────────────────────
    await session.commitTransaction();
    session.endSession();

    return res.json({ success: true });
  } catch (err) {
    // En cas d’erreur, on rollback
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
};




// ───────────────────────────────────────────────────────────────────────────────────
// ─── CANCEL INTERNAL ───────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────────────

// exports.cancelController = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();
//     const { transactionId, reason = 'Annulé', senderCurrencySymbol } = req.body;

//     if (!transactionId) {
//       throw createError(400, 'ID de transaction requis');
//     }

//     // 1) Récupère la transaction + vérifie le statut
//     const tx = await TransactionModel().findById(transactionId)
//       .select('+amount +transactionFees +sender +receiver')
//       .session(session);

//     if (!tx || tx.status !== 'pending') {
//       throw createError(400, 'Transaction invalide ou déjà traitée');
//     }

//     // 2) Vérifie que l’utilisateur connecté est bien expéditeur OU destinataire
//     const userId     = String(req.user.id);
//     const senderId   = String(tx.sender);
//     const receiverId = String(tx.receiver);
//     if (userId !== senderId && userId !== receiverId) {
//       throw createError(403, 'Vous n’êtes pas autorisé à annuler');
//     }

//     // 3) Calcul du remboursement (99% du montant brut)
//     const amtFloat  = parseFloat(tx.amount.toString());
//     const feesFloat = parseFloat(tx.transactionFees.toString());
//     const gross     = amtFloat + feesFloat;
//     const netRefund = parseFloat((gross * 0.99).toFixed(2));

//     // 4) Rembourse l’expéditeur
//     await Balance.findOneAndUpdate(
//       { user: tx.sender },
//       { $inc: { amount: netRefund } },
//       { new: true, upsert: true, session }
//     );

//     // 5) Mise à jour du statut en 'cancelled'
//     tx.status        = 'cancelled';
//     tx.cancelledAt   = new Date();
//     tx.cancelReason  = `${userId === receiverId
//       ? 'Annulé par le destinataire'
//       : 'Annulé par l’expéditeur'} : ${sanitize(reason)}`;
//     await tx.save({ session });

//     // 6) Notifications "cancelled"
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



/**
 * POST /api/v1/transactions/cancel
 *
 * 1) Vérifie que transactionId est fourni.
 * 2) Récupère la transaction en session, uniquement si statut = 'pending'.
 * 3) Vérifie que l’utilisateur est expéditeur OU destinataire.
 * 4) Calcule les frais d’annulation selon la devise de l’expéditeur :
 *    – 2,99 $ USD pour USA
 *    – 2,99 $ CAD pour Canada
 *    – 2,99 € pour Europe
 *    – 300 F CFA pour Afrique
 * 5) Rembourse à l’expéditeur : netAmount – frais d’annulation.
 * 6) Crédite le montant des frais sur le compte admin@paynoval.com.
 * 7) Met à jour le statut en 'cancelled', fixe cancelledAt et cancelReason.
 * 8) Envoie des notifications "cancelled".
 */
exports.cancelController = async (req, res, next) => {
  // Démarre une session MongoDB pour garantir l’atomicité
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    // ─── 1) Lecture des paramètres ───────────────────────────────────────────────
    const {
      transactionId,
      reason = 'Annulé',
      senderCurrencySymbol
    } = req.body;
    if (!transactionId) {
      throw createError(400, 'ID de transaction requis');
    }

    // ─── 2) Récupération de la transaction ───────────────────────────────────────
    //     On a besoin de amount, transactionFees, netAmount, sender et receiver
    const tx = await TransactionModel()
      .findById(transactionId)
      .select('+amount +transactionFees +netAmount +sender +receiver +senderCurrencySymbol')
      .session(session);

    if (!tx || tx.status !== 'pending') {
      throw createError(400, 'Transaction invalide ou déjà traitée');
    }

    // ─── 3) Vérifier que l’utilisateur connecté est expéditeur OU destinataire ────
    const userId     = String(req.user.id);
    const senderId   = String(tx.sender);
    const receiverId = String(tx.receiver);
    if (userId !== senderId && userId !== receiverId) {
      throw createError(403, 'Vous n’êtes pas autorisé à annuler cette transaction');
    }

    // ─── 4) Calcul des frais d’annulation selon la devise de l’expéditeur ─────────
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
    } else {
      cancellationFee = 0; // Par défaut, pas de frais si devise non reconnue
    }

    // ─── 5) Calcul du montant à rembourser à l’expéditeur ──────────────────────────
    //     On rembourse : netAmount – cancellationFee
    const netAmtFloat  = parseFloat(tx.netAmount.toString());
    const refundAmount = parseFloat((netAmtFloat - cancellationFee).toFixed(2));
    if (refundAmount < 0) {
      throw createError(400, 'Frais d’annulation supérieurs au montant net à rembourser');
    }

    //     On crédite le compte de l’expéditeur
    const refunded = await Balance.findOneAndUpdate(
      { user: tx.sender },
      { $inc: { amount: refundAmount } },
      { new: true, upsert: true, session }
    );
    if (!refunded) {
      throw createError(500, 'Erreur lors du remboursement au compte expéditeur');
    }

    // ─── 6) Crédit des frais d’annulation au compte admin@paynoval.com ─────────────
    const adminEmail = 'admin@paynoval.com';
    const adminUser = await User.findOne({ email: adminEmail })
      .select('_id')
      .session(session);
    if (!adminUser) {
      throw createError(500, 'Compte administrateur introuvable');
    }
    // Si cancellationFee > 0, on crédite ce montant au compte admin
    if (cancellationFee > 0) {
      await Balance.findOneAndUpdate(
        { user: adminUser._id },
        { $inc: { amount: cancellationFee } },
        { new: true, upsert: true, session }
      );
    }

    // ─── 7) Mise à jour de la transaction en 'cancelled' ─────────────────────────
    tx.status       = 'cancelled';
    tx.cancelledAt  = new Date();
    tx.cancelReason = `${userId === receiverId
      ? 'Annulé par le destinataire'
      : 'Annulé par l’expéditeur'} : ${sanitize(reason)}`;
    await tx.save({ session });

    // ─── 8) Notifications "cancelled" ────────────────────────────────────────────
    await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);

    // ─── 9) Commit de la transaction MongoDB ────────────────────────────────────
    await session.commitTransaction();
    session.endSession();

    // ─── 10) Réponse au front : on retourne le montant remboursé et les frais crédités ──
    return res.json({
      success: true,
      refunded: refundAmount,
      cancellationFee
    });
  } catch (err) {
    // En cas d’erreur, on rollback et on termine la session
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
};
