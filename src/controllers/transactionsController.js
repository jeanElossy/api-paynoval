// File: src/controllers/transactionsController.js

const axios           = require('axios');
const config          = require('../config');
const mongoose        = require('mongoose');
const createError     = require('http-errors');
const { Expo }        = require('expo-server-sdk');
const expo            = new Expo();
const { getTxConn }   = require('../config/db');
const TransactionModel = () => getTxConn().model('Transaction');
const Balance         = require('../models/Balance');
const User            = require('../models/User');
const Outbox          = require('../models/Outbox');
const Notification    = require('../models/Notification');
const { sendEmail }   = require('../utils/mail');
const {
  initiatedSenderTemplate,
  initiatedReceiverTemplate,
  confirmedSenderTemplate,
  confirmedReceiverTemplate,
  cancelledSenderTemplate,
  cancelledReceiverTemplate
}                     = require('../utils/emailTemplates');
const { convertAmount } = require('../tools/currency');
const generateTransactionRef = require('../utils/generateRef');

const {
  checkAndGenerateReferralCodeInMain,
  processReferralBonusIfEligible
}                     = require('../utils/referralUtils');

const PRINCIPAL_URL = config.principalUrl; // URL du backend principal

// ─── CONST & HELPERS ────────────────────────────────────────────────────────────────
const sanitize        = text => String(text || '').replace(/[<>\\/{};]/g, '').trim();
const MAX_DESC_LENGTH = 500;

/**
 * notifyParties : envoie des notifications par email, push et in-app
 * pour l’expéditeur et le destinataire d’une transaction, en respectant
 * leurs préférences stockées dans notificationSettings.
 */
async function notifyParties(tx, status, session, senderCurrencySymbol) {
  try {
    // 1) Sujet d’email selon le statut
    const subjectMap = {
      initiated: 'Transaction en attente',
      confirmed: 'Transaction confirmée',
      cancelled: 'Transaction annulée',
    };
    const emailSubject = subjectMap[status] || `Transaction ${status}`;

    // 2) Récupérer expéditeur & destinataire
    const [sender, receiver] = await Promise.all([
      User.findById(tx.sender)
        .select('email fullName pushTokens notificationSettings')
        .lean(),
      User.findById(tx.receiver)
        .select('email fullName pushTokens notificationSettings')
        .lean(),
    ]);
    if (!sender || !receiver) return;

    // 3) Formatage de la date (locale française)
    const dateStr = new Date().toLocaleString('fr-FR');

    // 4) Construire les liens de confirmation (web + mobile)
    const webLink    = `${PRINCIPAL_URL}/confirm/${tx._id}?token=${tx.verificationToken}`;
    const mobileLink = `panoval://confirm/${tx._id}?token=${tx.verificationToken}`;

    // 5) Préparer le payload pour l’expéditeur
    const dataSender = {
      transactionId:    tx._id.toString(),
      amount:           tx.amount.toString(),
      currency:         senderCurrencySymbol,
      name:             sender.fullName,
      senderEmail:      sender.email,
      receiverEmail:    tx.recipientEmail || receiver.email,
      date:             dateStr,
      confirmLinkWeb:   webLink,
      country:          tx.country,
      securityQuestion: tx.securityQuestion,
    };

    // 6) Préparer le payload pour le destinataire
    const dataReceiver = {
      transactionId:    tx._id.toString(),
      amount:           tx.localAmount.toString(),
      currency:         tx.localCurrencySymbol,
      name:             tx.nameDestinataire,
      receiverEmail:    tx.recipientEmail,
      senderEmail:      sender.email,
      date:             dateStr,
      confirmLink:      mobileLink,
      country:          tx.country,
      securityQuestion: tx.securityQuestion,
      senderName:       sender.fullName,
    };

    // 7) Chargement des préférences de notification
    const sSettings = sender.notificationSettings || {};
    const rSettings = receiver.notificationSettings || {};
    const {
      channels: { email: sEmailChan = true, push: sPushChan = true, inApp: sInAppChan = true } = {},
      types: {
        txSent: sTxSentType = true,
        txReceived: sTxReceivedType = true,
        txFailed: sTxFailedType = true,
      } = {},
    } = sSettings;
    const {
      channels: { email: rEmailChan = true, push: rPushChan = true, inApp: rInAppChan = true } = {},
      types: {
        txSent: rTxSentType = true,
        txReceived: rTxReceivedType = true,
        txFailed: rTxFailedType = true,
      } = {},
    } = rSettings;

    // 8) Déterminer la “clé” type pour expéditeur et destinataire selon status
    let sTypeKey, rTypeKey;
    if (status === 'initiated' || status === 'confirmed') {
      sTypeKey = 'txSent';
      rTypeKey = 'txReceived';
    } else if (status === 'cancelled') {
      sTypeKey = 'txFailed';
      rTypeKey = 'txFailed';
    } else {
      sTypeKey = null;
      rTypeKey = null;
    }

    // 9) Construction des messages pour push et in-app
    const statusTextMap = {
      initiated: 'Transaction en attente',
      confirmed: 'Transaction confirmée',
      cancelled: 'Transaction annulée',
    };
    const statusText = statusTextMap[status] || `Transaction ${status}`;
    const messageForSender   = `${statusText}\nMontant : ${dataSender.amount} ${dataSender.currency}`;
    const messageForReceiver = `${statusText}\nMontant : ${dataReceiver.amount} ${dataReceiver.currency}`;

    async function triggerPush(userId, message) {
      try {
        await axios.post(
          `${PRINCIPAL_URL}/internal/notify`,
          { userId, message },
          { headers: { 'Content-Type': 'application/json' } }
        );
      } catch (err) {
        console.warn(`Échec push pour user ${userId} : ${err.message}`);
      }
    }

    // 10) Notifications pour l’expéditeur (sender)
    if (sTypeKey) {
      // A) EMAIL
      if (
        sEmailChan &&
        ((sTypeKey === 'txSent' && sTxSentType) || (sTypeKey === 'txFailed' && sTxFailedType))
      ) {
        if (sender.email) {
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
      }
      // B) PUSH
      if (
        sPushChan &&
        ((sTypeKey === 'txSent' && sTxSentType) || (sTypeKey === 'txFailed' && sTxFailedType))
      ) {
        if (sender.pushTokens && sender.pushTokens.length) {
          await triggerPush(sender._id.toString(), messageForSender);
        }
      }
      // C) IN-APP
      if (
        sInAppChan &&
        ((sTypeKey === 'txSent' && sTxSentType) || (sTypeKey === 'txFailed' && sTxFailedType))
      ) {
        await Notification.create(
          [{
            recipient: sender._id.toString(),
            type:      `transaction_${status}`,
            data:      dataSender,
            read:      false,
            date:      new Date(),
          }],
          { session }
        );
      }
    }

    // 11) Notifications pour le destinataire (receiver)
    if (rTypeKey) {
      // A) EMAIL
      if (
        rEmailChan &&
        ((rTypeKey === 'txReceived' && rTxReceivedType) || (rTypeKey === 'txFailed' && rTxFailedType))
      ) {
        if (receiver.email) {
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
      }
      // B) PUSH
      if (
        rPushChan &&
        ((rTypeKey === 'txReceived' && rTxReceivedType) || (rTypeKey === 'txFailed' && rTxFailedType))
      ) {
        if (receiver.pushTokens && receiver.pushTokens.length) {
          await triggerPush(receiver._id.toString(), messageForReceiver);
        }
      }
      // C) IN-APP
      if (
        rInAppChan &&
        ((rTypeKey === 'txReceived' && rTxReceivedType) || (rTypeKey === 'txFailed' && rTxFailedType))
      ) {
        await Notification.create(
          [{
            recipient: receiver._id.toString(),
            type:      `transaction_${status}`,
            data:      dataReceiver,
            read:      false,
            date:      new Date(),
          }],
          { session }
        );
      }
    }

    // 12) Persister les événements Outbox pour trace/audit
    const events = [sender, receiver].map(u => ({
      service: 'notifications',
      event:   `transaction_${status}`,
      payload: {
        userId: u._id.toString(),
        type:   `transaction_${status}`,
        data:   u._id.toString() === sender._id.toString() ? dataSender : dataReceiver,
      },
    }));
    await Outbox.insertMany(events, { session });

  } catch (err) {
    console.error('notifyParties : erreur lors de l’envoi des notifications', err);
  }
}

// ───────────────────────────────────────────────────────────────────────────────────
// LIST INTERNAL
// ───────────────────────────────────────────────────────────────────────────────────
exports.listInternal = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const txs = await TransactionModel().find({
      $or: [{ sender: userId }, { receiver: userId }]
    }).sort({ createdAt: -1 });

    res.json({ success: true, count: txs.length, data: txs });
  } catch (err) {
    next(err);
  }
};

// ───────────────────────────────────────────────────────────────────────────────────
// GET TRANSACTION BY ID
// ───────────────────────────────────────────────────────────────────────────────────
exports.getTransactionController = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const tx = await TransactionModel().findById(id).lean();
    if (!tx) {
      return res.status(404).json({ success: false, message: 'Transaction non trouvée' });
    }

    const isSender   = tx.sender?.toString()   === userId;
    const isReceiver = tx.receiver?.toString() === userId;
    if (!isSender && !isReceiver) {
      return res.status(404).json({ success: false, message: 'Transaction non trouvée' });
    }

    return res.status(200).json({ success: true, data: tx });
  } catch (err) {
    next(err);
  }
};



/**
 * Route POST /api/v1/transactions/initiate
 */
exports.initiateInternal = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // 1) Lecture du body
    const {
      toEmail,
      amount,
      senderCurrencySymbol,
      localCurrencySymbol,
      recipientInfo = {},
      description = '',
      question,
      securityCode,
      destination,
      funds,
      country
    } = req.body;

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

    // 2) Récupération du token JWT depuis les headers
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw createError(401, 'Token manquant');
    }
    const authToken = authHeader;

    // 3) Récupération de l’utilisateur expéditeur
    const senderId   = req.user.id;
    const senderUser = await User.findById(senderId)
      .select('fullName email')
      .lean()
      .session(session);
    if (!senderUser) {
      throw createError(403, 'Utilisateur invalide');
    }

    // 4) Recherche du destinataire par email
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

    // 5) Vérification du montant saisi
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      throw createError(400, 'Montant invalide');
    }

    // 6) Calcul des frais (1 %) et montant net
    const fee       = parseFloat((amt * 0.01).toFixed(2));
    const netAmount = parseFloat((amt - fee).toFixed(2));

    // 7) Vérification du solde expéditeur et débit
    const balDoc      = await Balance.findOne({ user: senderId }).session(session);
    const balanceFloat = balDoc?.amount ?? 0;
    if (balanceFloat < amt) {
      throw createError(400, `Solde insuffisant : ${balanceFloat.toFixed(2)}`);
    }
    const debited = await Balance.findOneAndUpdate(
      { user: senderId },
      { $inc: { amount: -amt } },
      { new: true, session }
    );
    if (!debited) {
      throw createError(500, 'Erreur lors du débit du compte expéditeur');
    }

    // 8) Crédit immédiat des frais au compte admin (converti en CAD)
    let adminFeeInCAD = 0;
    if (fee > 0) {
      const { converted } = await convertAmount(
        senderCurrencySymbol,
        'CAD',
        fee
      );
      adminFeeInCAD = parseFloat(converted.toFixed(2));
    }
    const adminEmail = 'admin@paynoval.com';
    const adminUser  = await User.findOne({ email: adminEmail })
      .select('_id')
      .session(session);
    if (!adminUser) {
      throw createError(500, 'Compte administrateur introuvable');
    }
    if (adminFeeInCAD > 0) {
      await Balance.findOneAndUpdate(
        { user: adminUser._id },
        { $inc: { amount: adminFeeInCAD } },
        { new: true, upsert: true, session }
      );
    }

    // 9) Conversion du montant principal en devise locale
    const { rate, converted } = await convertAmount(
      senderCurrencySymbol,
      localCurrencySymbol,
      amt
    );

    // 10) Formatage en Decimal128
    const decAmt      = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
    const decFees     = mongoose.Types.Decimal128.fromString(fee.toFixed(2));
    const decNet      = mongoose.Types.Decimal128.fromString(netAmount.toFixed(2));
    const decLocal    = mongoose.Types.Decimal128.fromString(converted.toFixed(2));
    const decExchange = mongoose.Types.Decimal128.fromString(rate.toString());

    // 11) Détermine le nom du destinataire
    const nameDest = recipientInfo.name && sanitize(recipientInfo.name)
      ? sanitize(recipientInfo.name)
      : receiver.fullName;

    // 12) Génération de la référence unique
    const reference = await generateTransactionRef();

    // 13) Création du document Transaction en statut 'pending'
    const [tx] = await TransactionModel().create(
      [
        {
          reference,
          sender:               senderUser._id,
          receiver:             receiver._id,
          amount:               decAmt,
          transactionFees:      decFees,
          netAmount:            decNet,
          senderCurrencySymbol: sanitize(senderCurrencySymbol),
          exchangeRate:         decExchange,
          localAmount:          decLocal,
          localCurrencySymbol:  sanitize(localCurrencySymbol),
          senderName:           senderUser.fullName,
          senderEmail:          senderUser.email,
          nameDestinataire:     nameDest,
          recipientEmail:       sanitize(toEmail),
          country:              sanitize(country),
          description:          sanitize(description),
          securityQuestion:     sanitize(question),
          securityCode:         sanitize(securityCode),
          destination:          sanitize(destination),
          funds:                sanitize(funds),
          status:               'pending'
        }
      ],
      { session }
    );

    // 14) Générer (éventuellement) le referralCode du sender (2ᵉ transaction)
    await checkAndGenerateReferralCodeInMain(
      senderUser._id,
      session,
      authToken
    );

    // 15) Notifications “initiated”
    await notifyParties(tx, 'initiated', session, senderCurrencySymbol);

    // 16) Commit
    await session.commitTransaction();
    session.endSession();

    // 17) Réponse
    return res.status(201).json({
      success: true,
      transactionId: tx._id.toString(),
      reference:     tx.reference,
      adminFeeInCAD
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
};


// // ───────────────────────────────────────────────────────────────────────────────────
// // CONFIRM INTERNAL
// // ───────────────────────────────────────────────────────────────────────────────────
// exports.confirmController = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();

//     // 1) Lecture des paramètres
//     const { transactionId, securityCode } = req.body;
//     if (!transactionId || !securityCode) {
//       throw createError(400, 'transactionId et securityCode sont requis');
//     }

//     // 2) Récupération du token JWT depuis les en-têtes HTTP
//     const authHeader = req.headers.authorization;
//     if (!authHeader || !authHeader.startsWith('Bearer ')) {
//       // Aucun token n’a été fourni
//       throw createError(401, 'Token manquant');
//     }
//     const authToken = authHeader; // on transmettra "Bearer <token>" tel quel aux utilitaires

//     // 3) Récupération de la transaction (montants, receiver, sender)
//     const tx = await TransactionModel()
//       .findById(transactionId)
//       .select([
//         '+securityCode',
//         '+amount',
//         '+senderCurrencySymbol',
//         '+localCurrencySymbol',
//         '+receiver',
//         '+sender'
//       ])
//       .session(session);

//     if (!tx || tx.status !== 'pending') {
//       throw createError(400, 'Transaction invalide ou déjà traitée');
//     }

//     // 4) Vérifier que l’utilisateur connecté est bien le destinataire
//     if (String(tx.receiver) !== String(req.user.id)) {
//       throw createError(403, 'Vous n’êtes pas le destinataire de cette transaction');
//     }

//     // 5) Vérification du code de sécurité
//     const sanitizedCode = sanitize(securityCode);
//     if (sanitizedCode !== tx.securityCode) {
//       tx.status      = 'cancelled';
//       tx.cancelledAt = new Date();
//       await tx.save({ session });

//       await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
//       throw createError(401, 'Code de sécurité incorrect');
//     }

//     // 6) Calcul du montant net en devise expéditeur puis conversion
//     const amtFloat = parseFloat(tx.amount.toString());
//     if (amtFloat <= 0) {
//       throw createError(500, 'Montant brut invalide en base');
//     }
//     const fee    = parseFloat((amtFloat * 0.01).toFixed(2));
//     const netBrut = parseFloat((amtFloat - fee).toFixed(2));

//     const { converted: localNet } = await convertAmount(
//       tx.senderCurrencySymbol,
//       tx.localCurrencySymbol,
//       netBrut
//     );
//     const localNetRounded = parseFloat(localNet.toFixed(2));

//     // 7) Créditer le solde du destinataire (en devise locale)
//     const credited = await Balance.findOneAndUpdate(
//       { user: tx.receiver },
//       { $inc: { amount: localNetRounded } },
//       { new: true, upsert: true, session }
//     );
//     if (!credited) {
//       throw createError(500, 'Erreur lors du crédit au destinataire');
//     }

//     // 8) Mise à jour du statut en 'confirmed'
//     tx.status      = 'confirmed';
//     tx.confirmedAt = new Date();
//     await tx.save({ session });

//     // 9) Générer (éventuellement) le referralCode du sender (2ᵉ transaction)
//     await checkAndGenerateReferralCodeInMain(tx.sender, session, authToken);

//     // 10) On traite maintenant le bonus sur le sender (filleul)
//     await processReferralBonusIfEligible(tx.sender,   tx, session, authToken);

//     // 11) Notifications “confirmed”
//     await notifyParties(tx, 'confirmed', session, tx.senderCurrencySymbol);

//     // 12) Commit
//     await session.commitTransaction();
//     session.endSession();

//     // 13) Réponse
//     return res.json({ success: true, credited: localNetRounded });
//   } catch (err) {
//     await session.abortTransaction();
//     session.endSession();
//     return next(err);
//   }
// };

// ───────────────────────────────────────────────────────────────────────────────────
// CONFIRM INTERNAL avec protection anti-brute-force (max 3 essais, blocage temporaire)
// ───────────────────────────────────────────────────────────────────────────────────
exports.confirmController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // 1️⃣ Lecture des paramètres envoyés par le front (corps de la requête)
    const { transactionId, securityCode } = req.body;
    if (!transactionId || !securityCode) {
      throw createError(400, 'transactionId et securityCode sont requis');
    }

    // 2️⃣ Vérifie la présence d'un JWT (auth obligatoire)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw createError(401, 'Token manquant');
    }
    const authToken = authHeader;

    // 3️⃣ Récupère la transaction à confirmer (on charge aussi les champs brute-force)
    const tx = await TransactionModel()
      .findById(transactionId)
      .select([
        '+securityCode',
        '+amount',
        '+senderCurrencySymbol',
        '+localCurrencySymbol',
        '+receiver',
        '+sender',
        '+attemptCount',     // PATCH brute-force
        '+lastAttemptAt',    // PATCH brute-force
        '+lockedUntil'       // PATCH brute-force
      ])
      .session(session);

    if (!tx || tx.status !== 'pending') {
      throw createError(400, 'Transaction invalide ou déjà traitée');
    }

    // 4️⃣ Protection brute-force : blocage temporaire actif ?
    const now = new Date();
    if (tx.lockedUntil && tx.lockedUntil > now) {
      throw createError(423, `Transaction temporairement bloquée, réessayez après ${tx.lockedUntil.toLocaleTimeString('fr-FR')}`);
    }

    // 5️⃣ Limite d'essais : max 3 essais sinon annulation et blocage 15 minutes
    if ((tx.attemptCount || 0) >= 3) {
      // On annule la transaction pour cause d'abus
      tx.status = 'cancelled';
      tx.cancelledAt = now;
      tx.cancelReason = 'Code de sécurité erroné (trop d’essais)';
      tx.lockedUntil = new Date(now.getTime() + 15 * 60 * 1000); // blocage 15min
      await tx.save({ session });
      await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
      throw createError(401, 'Nombre d’essais dépassé, transaction annulée');
    }

    // 6️⃣ Vérifie que l'utilisateur connecté est bien le destinataire de la transaction
    if (String(tx.receiver) !== String(req.user.id)) {
      throw createError(403, 'Vous n’êtes pas le destinataire de cette transaction');
    }

    // 7️⃣ Vérifie le code de sécurité
    const sanitizedCode = String(securityCode).replace(/[<>\\/{};]/g, '').trim();
    if (sanitizedCode !== tx.securityCode) {
      // Incrémente le compteur d'essais et note la date
      tx.attemptCount = (tx.attemptCount || 0) + 1;
      tx.lastAttemptAt = now;

      // Annule si c'était le 3e essai
      if (tx.attemptCount >= 3) {
        tx.status = 'cancelled';
        tx.cancelledAt = now;
        tx.cancelReason = 'Code de sécurité erroné (trop d’essais)';
        tx.lockedUntil = new Date(now.getTime() + 15 * 60 * 1000); // blocage 15min
        await tx.save({ session });
        await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
        throw createError(401, 'Code de sécurité incorrect. Nombre d’essais dépassé, transaction annulée.');
      } else {
        await tx.save({ session });
        throw createError(401, `Code de sécurité incorrect. Il vous reste ${3 - tx.attemptCount} essai(s).`);
      }
    }

    // 8️⃣ (Code correct) Reset le compteur brute-force
    tx.attemptCount = 0;
    tx.lastAttemptAt = null;
    tx.lockedUntil = null;

    // 9️⃣ On crédite le destinataire (comme avant)
    const amtFloat = parseFloat(tx.amount.toString());
    if (amtFloat <= 0) throw createError(500, 'Montant brut invalide en base');
    const fee    = parseFloat((amtFloat * 0.01).toFixed(2));
    const netBrut = parseFloat((amtFloat - fee).toFixed(2));
    const { converted: localNet } = await convertAmount(
      tx.senderCurrencySymbol, tx.localCurrencySymbol, netBrut
    );
    const localNetRounded = parseFloat(localNet.toFixed(2));

    const credited = await Balance.findOneAndUpdate(
      { user: tx.receiver },
      { $inc: { amount: localNetRounded } },
      { new: true, upsert: true, session }
    );
    if (!credited) throw createError(500, 'Erreur lors du crédit au destinataire');

    // 🔟 Met à jour la transaction comme confirmée
    tx.status      = 'confirmed';
    tx.confirmedAt = now;
    await tx.save({ session });

    // 11️⃣ Referral code, bonus, notifications comme avant
    await checkAndGenerateReferralCodeInMain(tx.sender, session, authToken);
    await processReferralBonusIfEligible(tx.sender, tx, session, authToken);
    await notifyParties(tx, 'confirmed', session, tx.senderCurrencySymbol);

    // 12️⃣ Commit/fin session
    await session.commitTransaction();
    session.endSession();

    // 13️⃣ Réponse au front
    return res.json({ success: true, credited: localNetRounded });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
};




// ───────────────────────────────────────────────────────────────────────────────────
// CANCEL INTERNAL
// ───────────────────────────────────────────────────────────────────────────────────
exports.cancelController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // 1) Lecture des paramètres
    const { transactionId, reason = 'Annulé', senderCurrencySymbol } = req.body;
    if (!transactionId) {
      throw createError(400, 'transactionId requis pour annuler');
    }

    // 2) Récupération de la transaction
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

    // 3) Vérifier que l’utilisateur est expéditeur OU destinataire
    const userId     = String(req.user.id);
    const senderId   = String(tx.sender);
    const receiverId = String(tx.receiver);
    if (userId !== senderId && userId !== receiverId) {
      throw createError(403, 'Vous n’êtes pas autorisé à annuler cette transaction');
    }

    // 4) Calcul des frais d’annulation selon la devise expéditeur
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

    // 5) Calcul du montant à rembourser à l’expéditeur
    const netStored  = parseFloat(tx.netAmount.toString());
    const refundAmt  = parseFloat((netStored - cancellationFee).toFixed(2));
    if (refundAmt < 0) {
      throw createError(400, 'Frais d’annulation supérieurs au montant net à rembourser');
    }

    // 6) Crédit du solde expéditeur (devise expéditeur)
    const refunded = await Balance.findOneAndUpdate(
      { user: tx.sender },
      { $inc: { amount: refundAmt } },
      { new: true, upsert: true, session }
    );
    if (!refunded) {
      throw createError(500, 'Erreur lors du remboursement au compte expéditeur');
    }

    // ─── 6) Crédit du solde expéditeur (devise expéditeur) via addToBalance
    // const refunded = await Balance.addToBalance(tx.sender, refundAmt);
    // if (!refunded) {
    //   throw createError(500, 'Erreur lors du remboursement au compte expéditeur');
    // }


    // 7) Conversion des frais dans la devise du compte admin (CAD)
    const adminCurrency   = 'CAD';
    let adminFeeConverted = 0;
    if (cancellationFee > 0) {
      const { converted } = await convertAmount(
        tx.senderCurrencySymbol,
        adminCurrency,
        cancellationFee
      );
      adminFeeConverted = parseFloat(converted.toFixed(2));
    }

    // 8) Crédit du compte admin@paynoval.com (devise admin)
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

    // if (adminFeeConverted > 0) {
    //   await Balance.addToBalance(adminUser._id, adminFeeConverted);
    // }

    // 9) Mise à jour de la transaction en 'cancelled'
    tx.status       = 'cancelled';
    tx.cancelledAt  = new Date();
    tx.cancelReason = `${userId === receiverId
      ? 'Annulé par le destinataire'
      : 'Annulé par l’expéditeur'} : ${sanitize(reason)}`;
    await tx.save({ session });

    // 10) Notifications "cancelled"
    await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);

    // 11) Commit
    await session.commitTransaction();
    session.endSession();

    // 12) Réponse
    return res.json({
      success: true,
      refunded,
      cancellationFeeInSenderCurrency: cancellationFee,
      adminFeeCredited:                adminFeeConverted,
      adminCurrency
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
};


