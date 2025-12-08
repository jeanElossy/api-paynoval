// /**
//  * Contrôleur principal des transactions internes PayNoval.
//  * Gère : création, confirmation, annulation, notifications, audit outbox.
//  * Ne contient AUCUNE logique d'utilisateur autre que lookup.
//  */

// const axios         = require('axios');
// const config        = require('../config');
// const mongoose      = require('mongoose');
// const createError   = require('http-errors');
// const { getUsersConn, getTxConn } = require('../config/db');
// const validationService = require('../services/validationService');

// // Modèles (injection connexion à chaud : User, Notification, Outbox sur DB Users, Transaction/Balance sur DB Transactions)
// const User         = require('../models/User')(getUsersConn());
// const Notification = require('../models/Notification')(getUsersConn());
// const Outbox       = require('../models/Outbox')(getUsersConn());
// const Transaction  = require('../models/Transaction')(getTxConn());
// const Balance      = require('../models/Balance')(getUsersConn());

// const logger = require('../utils/logger');
// const { notifyTransactionViaGateway } = require('../services/notifyGateway');

// const { convertAmount } = require('../tools/currency');
// const generateTransactionRef = require('../utils/generateRef');

// const PRINCIPAL_URL = config.principalUrl;

// // Utilitaires internes
// const sanitize = (text) => String(text || '').replace(/[<>\\/{};]/g, '').trim();
// const MAX_DESC_LENGTH = 500;

// /**
//  * NOTIFY PARTIES
//  * - Push + In-app + Outbox gérés ici (DB locale)
//  * - Emails transactionnels délégués au Gateway via notifyGateway.js
//  *
//  * @param {object} tx        - Doc Transaction (déjà créé)
//  * @param {string} status    - 'initiated' | 'confirmed' | 'cancelled'
//  * @param {object} session   - Session mongoose
//  * @param {string} senderCurrencySymbol
//  */
// async function notifyParties(tx, status, session, senderCurrencySymbol) {
//   try {
//     // Lookup users
//     const [sender, receiver] = await Promise.all([
//       User.findById(tx.sender).select('email fullName pushTokens notificationSettings').lean(),
//       User.findById(tx.receiver).select('email fullName pushTokens notificationSettings').lean(),
//     ]);
//     if (!sender || !receiver) return;

//     const dateStr    = new Date().toLocaleString('fr-FR');
//     const webLink    = `${PRINCIPAL_URL}/confirm/${tx._id}?token=${tx.verificationToken}`;
//     const mobileLink = `paynoval://confirm/${tx._id}?token=${tx.verificationToken}`;

//     // Expéditeur
//     const dataSender = {
//       transactionId:    tx._id.toString(),
//       amount:           tx.amount.toString(),
//       currency:         senderCurrencySymbol,
//       name:             sender.fullName,
//       senderEmail:      sender.email,
//       receiverEmail:    tx.recipientEmail || receiver.email,
//       date:             dateStr,
//       confirmLinkWeb:   webLink,
//       country:          tx.country,
//       securityQuestion: tx.securityQuestion,
//     };
//     // Destinataire
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
//       senderName:       sender.fullName,
//     };

//     // Notif prefs
//     const sSettings = sender.notificationSettings || {};
//     const rSettings = receiver.notificationSettings || {};
//     const {
//       channels: { email: sEmailChan = true, push: sPushChan = true, inApp: sInAppChan = true } = {},
//       types: {
//         txSent: sTxSentType = true,
//         txReceived: sTxReceivedType = true,
//         txFailed: sTxFailedType = true,
//       } = {},
//     } = sSettings;
//     const {
//       channels: { email: rEmailChan = true, push: rPushChan = true, inApp: rInAppChan = true } = {},
//       types: {
//         txSent: rTxSentType = true,
//         txReceived: rTxReceivedType = true,
//         txFailed: rTxFailedType = true,
//       } = {},
//     } = rSettings;

//     // Statuts pour les types de notif
//     let sTypeKey, rTypeKey;
//     if (status === 'initiated' || status === 'confirmed') {
//       sTypeKey = 'txSent';
//       rTypeKey = 'txReceived';
//     } else if (status === 'cancelled') {
//       sTypeKey = 'txFailed';
//       rTypeKey = 'txFailed';
//     }

//     // Textes pour notifications (push / in-app)
//     const statusTextMap = {
//       initiated: 'Transaction en attente',
//       confirmed: 'Transaction confirmée',
//       cancelled: 'Transaction annulée',
//     };
//     const statusText = statusTextMap[status] || `Transaction ${status}`;
//     const messageForSender   = `${statusText}\nMontant : ${dataSender.amount} ${dataSender.currency}`;
//     const messageForReceiver = `${statusText}\nMontant : ${dataReceiver.amount} ${dataReceiver.currency}`;

//     // Wrapper pour push interne (via microservice/endpoint principal)
//     async function triggerPush(userId, message) {
//       try {
//         await axios.post(
//           `${PRINCIPAL_URL}/internal/notify`,
//           { userId, message },
//           {
//             headers: {
//               'Content-Type': 'application/json',
//               'x-internal-token': process.env.INTERNAL_TOKEN,
//             },
//           }
//         );
//       } catch (err) {
//         console.warn(`Échec push pour user ${userId} : ${err.message}`);
//       }
//     }

//     // ---------------------------
//     // Notifs EXPÉDITEUR (sender)
//     // ---------------------------

//     // Push sender
//     if (
//       sPushChan &&
//       ((sTypeKey === 'txSent' && sTxSentType) || (sTypeKey === 'txFailed' && sTxFailedType))
//     ) {
//       if (sender.pushTokens && sender.pushTokens.length) {
//         await triggerPush(sender._id.toString(), messageForSender);
//       }
//     }

//     // In-app sender
//     if (
//       sInAppChan &&
//       ((sTypeKey === 'txSent' && sTxSentType) || (sTypeKey === 'txFailed' && sTxFailedType))
//     ) {
//       await Notification.create(
//         [
//           {
//             recipient: sender._id.toString(),
//             type: `transaction_${status}`,
//             data: dataSender,
//             read: false,
//             date: new Date(),
//           },
//         ],
//         { session }
//       );
//     }

//     // ------------------------------
//     // Notifs DESTINATAIRE (receiver)
//     // ------------------------------

//     // Push receiver
//     if (
//       rPushChan &&
//       ((rTypeKey === 'txReceived' && rTxReceivedType) || (rTypeKey === 'txFailed' && rTxFailedType))
//     ) {
//       if (receiver.pushTokens && receiver.pushTokens.length) {
//         await triggerPush(receiver._id.toString(), messageForReceiver);
//       }
//     }

//     // In-app receiver
//     if (
//       rInAppChan &&
//       ((rTypeKey === 'txReceived' && rTxReceivedType) || (rTypeKey === 'txFailed' && rTxFailedType))
//     ) {
//       await Notification.create(
//         [
//           {
//             recipient: receiver._id.toString(),
//             type: `transaction_${status}`,
//             data: dataReceiver,
//             read: false,
//             date: new Date(),
//           },
//         ],
//         { session }
//       );
//     }

//     // ---------------------------
//     // Outbox event for audit/trace
//     // ---------------------------
//     const events = [sender, receiver].map((u) => ({
//       service: 'notifications',
//       event:   `transaction_${status}`,
//       payload: {
//         userId: u._id.toString(),
//         type:   `transaction_${status}`,
//         data:   u._id.toString() === sender._id.toString() ? dataSender : dataReceiver,
//       },
//     }));
//     await Outbox.insertMany(events, { session });

//     // ---------------------------------------
//     // Emails transactionnels via le Gateway
//     // (SendGrid, templates pro) — fire & forget
//     // ---------------------------------------

//     // Décide si on envoie des emails selon les préférences
//     const shouldEmailSender =
//       sEmailChan &&
//       ((sTypeKey === 'txSent' && sTxSentType) || (sTypeKey === 'txFailed' && sTxFailedType));

//     const shouldEmailReceiver =
//       rEmailChan &&
//       ((rTypeKey === 'txReceived' && rTxReceivedType) || (rTypeKey === 'txFailed' && rTxFailedType));

//     if (shouldEmailSender || shouldEmailReceiver) {
//       const payloadForGateway = {
//         transaction: {
//           id: tx._id.toString(),
//           reference: tx.reference,
//           amount: parseFloat(tx.amount.toString()),
//           currency: senderCurrencySymbol,
//           dateIso: tx.createdAt?.toISOString() || new Date().toISOString(),
//         },
//         sender: {
//           email: sender.email,
//           name: sender.fullName || sender.email,
//           wantsEmail: shouldEmailSender,
//         },
//         receiver: {
//           email: tx.recipientEmail || receiver.email,
//           name: tx.nameDestinataire || receiver.fullName || receiver.email,
//           wantsEmail: shouldEmailReceiver,
//         },
//         reason: status === 'cancelled' ? tx.cancelReason : undefined,
//         links: {
//           sender: `${PRINCIPAL_URL}/transactions/${tx._id}`,
//           receiverConfirm: webLink, // lien de confirmation pour le destinataire
//         },
//       };

//       // On ne bloque pas la transaction si le Gateway met du temps ou échoue
//       notifyTransactionViaGateway(status, payloadForGateway).catch((err) => {
//         console.error(
//           '[notifyParties] Erreur lors de la notification via Gateway :',
//           err?.message || err
//         );
//       });
//     }
//   } catch (err) {
//     console.error('notifyParties : erreur lors de l’envoi des notifications', err);
//   }
// }

// // -------------------------------------------------------------------
// // LISTE des transactions internes de l'utilisateur connecté

// // GET /api/v1/transactions?skip=0&limit=25
// exports.listInternal = async (req, res, next) => {
//   try {
//     const userId = req.user.id;
//     const skip = parseInt(req.query.skip) || 0;
//     const limit = Math.min(parseInt(req.query.limit) || 25, 100); // max 100/page

//     const [txs, total] = await Promise.all([
//       Transaction.find({ $or: [{ sender: userId }, { receiver: userId }] })
//         .sort({ createdAt: -1 })
//         .skip(skip)
//         .limit(limit),
//       Transaction.countDocuments({ $or: [{ sender: userId }, { receiver: userId }] }),
//     ]);

//     res.json({ success: true, count: txs.length, total, data: txs, skip, limit });
//   } catch (err) {
//     next(err);
//   }
// };

// // -------------------------------------------------------------------
// // Récupère UNE transaction par son ID (must be sender or receiver)
// exports.getTransactionController = async (req, res, next) => {
//   try {
//     const { id } = req.params;
//     const userId = req.user.id;

//     const tx = await Transaction.findById(id).lean();
//     if (!tx) {
//       return res.status(404).json({ success: false, message: 'Transaction non trouvée' });
//     }
//     const isSender   = tx.sender?.toString()   === userId;
//     const isReceiver = tx.receiver?.toString() === userId;
//     if (!isSender && !isReceiver) {
//       return res.status(404).json({ success: false, message: 'Transaction non trouvée' });
//     }
//     return res.status(200).json({ success: true, data: tx });
//   } catch (err) {
//     next(err);
//   }
// };

// exports.initiateInternal = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();

//     // 1) Lecture et validation du body
//     const {
//       toEmail,
//       amount,
//       senderCurrencySymbol,
//       localCurrencySymbol,
//       recipientInfo = {},
//       description = '',
//       question,
//       securityCode,
//       destination,
//       funds,
//       country,
//     } = req.body;

//     if (!toEmail || !sanitize(toEmail)) throw createError(400, 'Email du destinataire requis');
//     if (!question || !securityCode) throw createError(400, 'Question et code de sécurité requis');
//     if (!destination || !funds || !country) throw createError(400, 'Données de transaction incomplètes');
//     if (description && description.length > MAX_DESC_LENGTH)
//       throw createError(400, 'Description trop longue');

//     // 2) Auth JWT
//     const authHeader = req.headers.authorization;
//     if (!authHeader || !authHeader.startsWith('Bearer ')) throw createError(401, 'Token manquant');
//     const authToken = authHeader;

//     // 3) Expéditeur
//     const senderId   = req.user.id;
//     const senderUser = await User.findById(senderId).select('fullName email').lean().session(session);
//     if (!senderUser) throw createError(403, 'Utilisateur invalide');

//     // 4) Destinataire
//     const receiver = await User.findOne({ email: sanitize(toEmail) })
//       .select('_id fullName email')
//       .lean()
//       .session(session);
//     if (!receiver) throw createError(404, 'Destinataire introuvable');
//     if (receiver._id.toString() === senderId) throw createError(400, 'Auto-transfert impossible');

//     // 5) --- VALIDATION AVEC LE SERVICE ---
//     await validationService.validateTransactionAmount({ amount: req.body.amount });
//     await validationService.detectBasicFraud({
//       sender: req.user.id,
//       receiver: receiver._id,
//       amount: req.body.amount,
//       currency: req.body.senderCurrencySymbol,
//     });

//     // 6) Calcul montant
//     const amt = parseFloat(amount);
//     if (isNaN(amt) || amt <= 0) throw createError(400, 'Montant invalide');

//     // 7) -- APPELLE LA LOGIQUE DE FRAIS DU GATEWAY --
//     // On sécurise la base URL pour garantir la présence de /api/v1
//     let gatewayBase =
//       config.gatewayUrl ||
//       process.env.GATEWAY_URL ||
//       'https://api-gateway-8cgy.onrender.com';

//     // retire les / de fin
//     gatewayBase = gatewayBase.replace(/\/+$/, '');

//     // si ça ne se termine pas par /api/v1, on l’ajoute
//     if (!gatewayBase.endsWith('/api/v1')) {
//       gatewayBase = `${gatewayBase}/api/v1`;
//     }

//     const feeUrl = `${gatewayBase}/fees/simulate`;

//     const simulateParams = {
//       provider: 'paynoval',
//       amount: amt,
//       fromCurrency: senderCurrencySymbol,
//       toCurrency: localCurrencySymbol,
//       country: country,
//       // optionnel : type de simulation (standard, cancellation, etc.)
//       // type: 'standard',
//     };

//     let feeData;
//     try {
//       const feeRes = await axios.get(feeUrl, {
//         params: simulateParams,
//         headers: {
//           // On propage le JWT du user (utile si le Gateway en a besoin)
//           ...(authHeader ? { Authorization: authHeader } : {}),
//           // Et le token interne pour les appels microservices
//           ...(process.env.INTERNAL_TOKEN
//             ? { 'x-internal-token': process.env.INTERNAL_TOKEN }
//             : {}),
//         },
//         timeout: 10000,
//       });

//       if (!feeRes.data || feeRes.data.success === false) {
//         throw createError(502, 'Erreur calcul frais (gateway)');
//       }

//       feeData = feeRes.data.data; // ex: { amount, fees, netAfterFees, feePercent, feeId, ... }
//     } catch (e) {
//       // Log détaillé puis erreur propre
//       logger.error('[fees/simulate] échec appel Gateway', {
//         url: feeUrl,
//         params: simulateParams,
//         status: e.response?.status,
//         responseData: e.response?.data,
//       });
//       throw createError(502, 'Service de calcul des frais indisponible');
//     }

//     const fee         = parseFloat(feeData.fees);
//     const netAmount   = parseFloat(feeData.netAfterFees);
//     const feeId       = feeData.feeId || null;
//     const feeSnapshot = feeData;

//     // 8) Débit expéditeur (solde)
//     const balDoc = await Balance.findOne({ user: senderId }).session(session);
//     const balanceFloat = balDoc?.amount ?? 0;
//     if (balanceFloat < amt)
//       throw createError(400, `Solde insuffisant : ${balanceFloat.toFixed(2)}`);

//     const debited = await Balance.findOneAndUpdate(
//       { user: senderId },
//       { $inc: { amount: -amt } },
//       { new: true, session }
//     );
//     if (!debited) throw createError(500, 'Erreur lors du débit du compte expéditeur');

//     // 9) Crédit admin fees (en CAD ici)
//     let adminFeeInCAD = 0;
//     if (fee > 0) {
//       const { converted } = await convertAmount(senderCurrencySymbol, 'CAD', fee);
//       adminFeeInCAD = parseFloat(converted.toFixed(2));
//     }
//     const adminEmail = 'admin@paynoval.com';
//     const adminUser  = await User.findOne({ email: adminEmail }).select('_id').session(session);
//     if (!adminUser) throw createError(500, 'Compte administrateur introuvable');
//     if (adminFeeInCAD > 0) {
//       await Balance.findOneAndUpdate(
//         { user: adminUser._id },
//         { $inc: { amount: adminFeeInCAD } },
//         { new: true, upsert: true, session }
//       );
//     }

//     // 10) Conversion montant principal (pour localAmount)
//     const { rate, converted } = await convertAmount(
//       senderCurrencySymbol,
//       localCurrencySymbol,
//       amt
//     );

//     // 11) Formatage en Decimal128
//     const decAmt      = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
//     const decFees     = mongoose.Types.Decimal128.fromString(fee.toFixed(2));
//     const decNet      = mongoose.Types.Decimal128.fromString(netAmount.toFixed(2));
//     const decLocal    = mongoose.Types.Decimal128.fromString(converted.toFixed(2));
//     const decExchange = mongoose.Types.Decimal128.fromString(rate.toString());

//     // 12) Nom du destinataire
//     const nameDest = recipientInfo.name && sanitize(recipientInfo.name)
//       ? sanitize(recipientInfo.name)
//       : receiver.fullName;

//     // 13) Génération ref
//     const reference = await generateTransactionRef();

//     // 14) Création doc Transaction
//     const [tx] = await Transaction.create(
//       [
//         {
//           reference,
//           sender:               senderUser._id,
//           receiver:             receiver._id,
//           amount:               decAmt,
//           transactionFees:      decFees,
//           netAmount:            decNet,
//           feeSnapshot,          // 👈 snapshot complet (pour audit / confirm)
//           feeId,                // 👈 id mongo Fee si dispo
//           senderCurrencySymbol: sanitize(senderCurrencySymbol),
//           exchangeRate:         decExchange,
//           localAmount:          decLocal,
//           localCurrencySymbol:  sanitize(localCurrencySymbol),
//           senderName:           senderUser.fullName,
//           senderEmail:          senderUser.email,
//           nameDestinataire:     nameDest,
//           recipientEmail:       sanitize(toEmail),
//           country:              sanitize(country),
//           description:          sanitize(description),
//           securityQuestion:     sanitize(question),
//           securityCode:         sanitize(securityCode),
//           destination:          sanitize(destination),
//           funds:                sanitize(funds),
//           status:               'pending',
//         },
//       ],
//       { session }
//     );

//     // 15) Notifications (push + in-app + outbox + Gateway email)
//     await notifyParties(tx, 'initiated', session, senderCurrencySymbol);

//     // 16) Commit
//     await session.commitTransaction();
//     session.endSession();

//     // 17) Réponse
//     return res.status(201).json({
//       success: true,
//       transactionId: tx._id.toString(),
//       reference:     tx.reference,
//       adminFeeInCAD,
//     });
//   } catch (err) {
//     await session.abortTransaction();
//     session.endSession();
//     return next(err);
//   }
// };


// exports.confirmController = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();

//     const { transactionId, securityCode } = req.body;
//     if (!transactionId || !securityCode)
//       throw createError(400, 'transactionId et securityCode sont requis');

//     const authHeader = req.headers.authorization;
//     if (!authHeader || !authHeader.startsWith('Bearer '))
//       throw createError(401, 'Token manquant');
//     const authToken = authHeader;

//     // Récupère la transaction (frais + net stockés)
//     const tx = await Transaction.findById(transactionId)
//       .select([
//         '+securityCode',
//         '+amount',
//         '+transactionFees',
//         '+netAmount',
//         '+senderCurrencySymbol',
//         '+localCurrencySymbol',
//         '+receiver',
//         '+sender',
//         '+feeSnapshot',
//         '+feeId',
//         '+attemptCount',
//         '+lastAttemptAt',
//         '+lockedUntil',
//         '+status',
//       ])
//       .session(session);

//     if (!tx) throw createError(400, 'Transaction introuvable');

//     // ----- Validation cohérence de changement de statut -----
//     validationService.validateTransactionStatusChange(tx.status, 'confirmed');

//     if (tx.status !== 'pending')
//       throw createError(400, 'Transaction déjà traitée ou annulée');

//     // Protection anti-brute-force
//     const now = new Date();
//     if (tx.lockedUntil && tx.lockedUntil > now)
//       throw createError(
//         423,
//         `Transaction temporairement bloquée, réessayez après ${tx.lockedUntil.toLocaleTimeString(
//           'fr-FR'
//         )}`
//       );

//     if ((tx.attemptCount || 0) >= 3) {
//       tx.status = 'cancelled';
//       tx.cancelledAt = now;
//       tx.cancelReason = 'Code de sécurité erroné (trop d’essais)';
//       tx.lockedUntil = new Date(now.getTime() + 15 * 60 * 1000); // blocage 15min
//       await tx.save({ session });
//       await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
//       throw createError(401, 'Nombre d’essais dépassé, transaction annulée');
//     }

//     if (String(tx.receiver) !== String(req.user.id))
//       throw createError(403, 'Vous n’êtes pas le destinataire de cette transaction');

//     const sanitizedCode = String(securityCode).replace(/[<>\\/{};]/g, '').trim();
//     if (sanitizedCode !== tx.securityCode) {
//       tx.attemptCount = (tx.attemptCount || 0) + 1;
//       tx.lastAttemptAt = now;

//       if (tx.attemptCount >= 3) {
//         tx.status = 'cancelled';
//         tx.cancelledAt = now;
//         tx.cancelReason = 'Code de sécurité erroné (trop d’essais)';
//         tx.lockedUntil = new Date(now.getTime() + 15 * 60 * 1000);
//         await tx.save({ session });
//         await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
//         throw createError(
//           401,
//           'Code de sécurité incorrect. Nombre d’essais dépassé, transaction annulée.'
//         );
//       } else {
//         await tx.save({ session });
//         throw createError(
//           401,
//           `Code de sécurité incorrect. Il vous reste ${3 - tx.attemptCount} essai(s).`
//         );
//       }
//     }

//     // Reset brute-force
//     tx.attemptCount = 0;
//     tx.lastAttemptAt = null;
//     tx.lockedUntil = null;

//     // Crédit destinataire : utilise les données déjà stockées lors de l'initiate (SÉCURITÉ)
//     const amtFloat  = parseFloat(tx.amount.toString());
//     const fee       = parseFloat(tx.transactionFees.toString());
//     const netBrut   = parseFloat(tx.netAmount.toString());

//     // Conversion pour la devise locale
//     let localNetRounded = null;
//     if (tx.feeSnapshot && tx.feeSnapshot.netAfterFees) {
//       localNetRounded = parseFloat(tx.feeSnapshot.netAfterFees);
//     } else {
//       // Sécurité : fallback legacy (doit disparaître quand tout est migré)
//       const { converted: localNet } = await convertAmount(
//         tx.senderCurrencySymbol,
//         tx.localCurrencySymbol,
//         netBrut
//       );
//       localNetRounded = parseFloat(localNet.toFixed(2));
//     }

//     const credited = await Balance.findOneAndUpdate(
//       { user: tx.receiver },
//       { $inc: { amount: localNetRounded } },
//       { new: true, upsert: true, session }
//     );
//     if (!credited) throw createError(500, 'Erreur lors du crédit au destinataire');

//     tx.status      = 'confirmed';
//     tx.confirmedAt = now;
//     await tx.save({ session });

//     // ➜ Plus de parrainage ici : c'est géré par l’API Gateway

//     await notifyParties(tx, 'confirmed', session, tx.senderCurrencySymbol);

//     await session.commitTransaction();
//     session.endSession();

//     return res.json({
//       success: true,
//       credited: localNetRounded,
//       feeId: tx.feeId,
//       feeSnapshot: tx.feeSnapshot,
//     });
//   } catch (err) {
//     await session.abortTransaction();
//     session.endSession();
//     return next(err);
//   }
// };



// exports.cancelController = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();

//     const { transactionId, reason = 'Annulé' } = req.body;
//     if (!transactionId) throw createError(400, 'transactionId requis pour annuler');

//     const tx = await Transaction.findById(transactionId)
//       .select([
//         '+netAmount',
//         '+amount',
//         '+senderCurrencySymbol',
//         '+sender',
//         '+receiver',
//         '+status',
//       ])
//       .session(session);

//     if (!tx) throw createError(400, 'Transaction introuvable');

//     // ---- Validation cohérence de changement de statut ----
//     validationService.validateTransactionStatusChange(tx.status, 'cancelled');

//     if (tx.status !== 'pending')
//       throw createError(400, 'Transaction déjà traitée ou annulée');

//     const userId     = String(req.user.id);
//     const senderId   = String(tx.sender);
//     const receiverId = String(tx.receiver);
//     if (userId !== senderId && userId !== receiverId)
//       throw createError(403, 'Vous n’êtes pas autorisé à annuler cette transaction');

//     // --- Simulation des frais d’annulation via Gateway ---
//     let cancellationFee = 0;
//     let cancellationFeeType = 'fixed';
//     let cancellationFeePercent = 0;
//     let cancellationFeeId = null;

//     try {
//       let gatewayBase =
//         config.gatewayUrl ||
//         process.env.GATEWAY_URL ||
//         'https://api-gateway-8cgy.onrender.com';
//       gatewayBase = gatewayBase.replace(/\/+$/, '');
//       if (!gatewayBase.endsWith('/api/v1')) {
//         gatewayBase = `${gatewayBase}/api/v1`;
//       }

//       const { data } = await axios.get(`${gatewayBase}/fees/simulate`, {
//         params: {
//           provider: tx.funds || 'paynoval',
//           amount: tx.amount.toString(),
//           fromCurrency: tx.senderCurrencySymbol,
//           toCurrency: tx.senderCurrencySymbol,
//           type: 'cancellation',
//         },
//         timeout: 6000,
//       });
//       if (data && data.success) {
//         cancellationFee        = data.data.fees;
//         cancellationFeeType    = data.data.type || 'fixed';
//         cancellationFeePercent = data.data.feePercent || 0;
//         cancellationFeeId      = data.data.feeId || null;
//       } else {
//         cancellationFee = 0;
//       }
//     } catch (e) {

//       // fallback legacy :
//       const symbol = tx.senderCurrencySymbol.trim();
//       if (['USD', '$USD', 'CAD', '$CAD', 'EUR', '€'].includes(symbol)) {
//         cancellationFee = 2.99;
//       } else if (['XOF', 'XAF', 'F CFA'].includes(symbol)) {
//         cancellationFee = 300;
//       }
      
//     }

//     // Remboursement
//     const netStored  = parseFloat(tx.netAmount.toString());
//     const refundAmt  = parseFloat((netStored - cancellationFee).toFixed(2));
//     if (refundAmt < 0)
//       throw createError(
//         400,
//         'Frais d’annulation supérieurs au montant net à rembourser'
//       );

//     const refunded = await Balance.findOneAndUpdate(
//       { user: tx.sender },
//       { $inc: { amount: refundAmt } },
//       { new: true, upsert: true, session }
//     );
//     if (!refunded)
//       throw createError(500, 'Erreur lors du remboursement au compte expéditeur');

//     // Crédit admin sur frais d’annulation
//     const adminCurrency   = 'CAD';
//     let adminFeeConverted = 0;
//     if (cancellationFee > 0) {
//       const { converted } = await convertAmount(
//         tx.senderCurrencySymbol,
//         adminCurrency,
//         cancellationFee
//       );
//       adminFeeConverted = parseFloat(converted.toFixed(2));
//     }
//     const adminEmail = 'admin@paynoval.com';
//     const adminUser  = await User.findOne({ email: adminEmail }).select('_id').session(session);
//     if (!adminUser)
//       throw createError(500, 'Compte administrateur introuvable');
//     if (adminFeeConverted > 0) {
//       await Balance.findOneAndUpdate(
//         { user: adminUser._id },
//         { $inc: { amount: adminFeeConverted } },
//         { new: true, upsert: true, session }
//       );
//     }

//     // Archive dans le tx
//     tx.status       = 'cancelled';
//     tx.cancelledAt  = new Date();
//     tx.cancelReason = `${
//       userId === receiverId ? 'Annulé par le destinataire' : 'Annulé par l’expéditeur'
//     } : ${sanitize(reason)}`;
//     tx.cancellationFee        = cancellationFee;
//     tx.cancellationFeeType    = cancellationFeeType;
//     tx.cancellationFeePercent = cancellationFeePercent;
//     tx.cancellationFeeId      = cancellationFeeId;
//     await tx.save({ session });

//     await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);

//     await session.commitTransaction();
//     session.endSession();

//     return res.json({
//       success: true,
//       refunded,
//       cancellationFeeInSenderCurrency: cancellationFee,
//       cancellationFeeType,
//       cancellationFeePercent,
//       cancellationFeeId,
//       adminFeeCredited: adminFeeConverted,
//       adminCurrency,
//     });
//   } catch (err) {
//     await session.abortTransaction();
//     session.endSession();
//     return next(err);
//   }
// };

// // Rembourse une transaction déjà confirmée (refund après paiement)
// exports.refundController = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();
//     const { transactionId, reason = 'Remboursement demandé' } = req.body;

//     // Recherche la transaction
//     const tx = await Transaction.findById(transactionId).session(session);
//     if (!tx || tx.status !== 'confirmed')
//       throw createError(400, 'Transaction non remboursable');

//     // Vérifie qu’elle n’a pas déjà été remboursée
//     if (tx.refundedAt) throw createError(400, 'Déjà remboursée');

//     // Débite le destinataire, crédite l’expéditeur
//     const amt = parseFloat(tx.localAmount.toString());
//     if (amt <= 0) throw createError(400, 'Montant de remboursement invalide');

//     // Retire au destinataire
//     const debited = await Balance.findOneAndUpdate(
//       { user: tx.receiver },
//       { $inc: { amount: -amt } },
//       { new: true, session }
//     );
//     if (!debited || debited.amount < 0)
//       throw createError(400, 'Solde du destinataire insuffisant');

//     // Rembourse à l’expéditeur
//     await Balance.findOneAndUpdate(
//       { user: tx.sender },
//       { $inc: { amount: amt } },
//       { new: true, upsert: true, session }
//     );

//     // Historise la transaction comme remboursée
//     tx.status = 'refunded';
//     tx.refundedAt = new Date();
//     tx.refundReason = reason;
//     await tx.save({ session });

//     // Alerte log sécurité
//     logger.warn(
//       `[ALERTE REFUND] Remboursement manuel effectué ! TransactionId: ${transactionId}, Refund par: ${
//         req.user?.email || req.user?.id
//       }, Montant: ${amt}`
//     );

//     // TODO: Envoie email ou Slack à l’admin si besoin
//     // await sendRefundAlertToAdmin({ tx, user: req.user, reason, amount: amt });

//     await session.commitTransaction();
//     session.endSession();

//     res.json({ success: true, refunded: amt });
//   } catch (err) {
//     await session.abortTransaction();
//     session.endSession();
//     next(err);
//   }
// };

// // Valide ou rejette manuellement une transaction (ex: admin validation)
// exports.validateController = async (req, res, next) => {
//   try {
//     const { transactionId, status, adminNote } = req.body;

//     // Seulement “pending” peut être validée/rejetée
//     const tx = await Transaction.findById(transactionId);
//     if (!tx || tx.status !== 'pending')
//       throw createError(400, 'Transaction non validable');

//     // Uniquement “confirmed” ou “rejected” comme statut cible
//     if (!['confirmed', 'rejected'].includes(status))
//       throw createError(400, 'Statut de validation invalide');

//     tx.status = status;
//     tx.validatedAt = new Date();
//     tx.adminNote = adminNote || null;
//     await tx.save();

//     // Tu peux ici notifier, etc.

//     res.json({ success: true, message: `Transaction ${status}` });
//   } catch (err) {
//     next(err);
//   }
// };

// // Réattribue une transaction à un autre bénéficiaire (admin/action spéciale)
// exports.reassignController = async (req, res, next) => {
//   const session = await mongoose.startSession();
//   try {
//     session.startTransaction();
//     const { transactionId, newReceiverEmail } = req.body;

//     const tx = await Transaction.findById(transactionId).session(session);
//     if (!tx || !['pending', 'confirmed'].includes(tx.status))
//       throw createError(400, 'Transaction non réassignable');

//     // Trouver le nouveau destinataire
//     const newReceiver = await User.findOne({ email: newReceiverEmail })
//       .select('_id fullName email')
//       .session(session);
//     if (!newReceiver) throw createError(404, 'Nouveau destinataire introuvable');
//     if (String(newReceiver._id) === String(tx.receiver))
//       throw createError(400, 'Déjà affectée à ce destinataire');

//     // Change le receiver
//     tx.receiver = newReceiver._id;
//     tx.nameDestinataire = newReceiver.fullName;
//     tx.recipientEmail = newReceiver.email;
//     tx.reassignedAt = new Date();
//     await tx.save({ session });

//     // ALERTE LOG/MAIL
//     const logger2 = require('../utils/logger');
//     logger2.warn(
//       `ALERTE REASSIGN: Transaction ${transactionId} réassignée par ${
//         req.user?.email || req.user?.id
//       } à ${newReceiverEmail}`
//     );

//     await session.commitTransaction();
//     session.endSession();

//     res.json({
//       success: true,
//       newReceiver: { id: newReceiver._id, email: newReceiver.email },
//     });
//   } catch (err) {
//     await session.abortTransaction();
//     session.endSession();
//     next(err);
//   }
// };

// // -------------------------------------------------------------------
// // ARCHIVER une transaction (admin/superadmin ONLY)
// exports.archiveController = async (req, res, next) => {
//   try {
//     const { transactionId } = req.body;

//     const tx = await Transaction.findById(transactionId);
//     if (!tx) throw createError(404, 'Transaction non trouvée');
//     if (tx.archived) throw createError(400, 'Déjà archivée');

//     tx.archived = true;
//     tx.archivedAt = new Date();
//     tx.archivedBy = req.user?.email || req.user?.id || null;
//     await tx.save();

//     res.json({ success: true, archived: true });
//   } catch (err) {
//     next(err);
//   }
// };

// // -------------------------------------------------------------------
// // RELANCER une transaction (admin/superadmin ONLY)
// exports.relaunchController = async (req, res, next) => {
//   try {
//     const { transactionId } = req.body;

//     const tx = await Transaction.findById(transactionId);
//     if (!tx) throw createError(404, 'Transaction non trouvée');
//     // Ici, adapte à ta logique métier si besoin, ex : seulement status=pending/cancelled
//     if (!['pending', 'cancelled'].includes(tx.status))
//       throw createError(
//         400,
//         'Seules les transactions en attente ou annulées peuvent être relancées'
//       );

//     tx.status = 'relaunch';
//     tx.relaunchedAt = new Date();
//     tx.relaunchedBy = req.user?.email || req.user?.id || null;
//     tx.relaunchCount = (tx.relaunchCount || 0) + 1;
//     await tx.save();

//     res.json({ success: true, relaunched: true, txId: tx._id });
//   } catch (err) {
//     next(err);
//   }
// };



// // à la fin du fichier 
// exports.notifyParties = notifyParties;




// File: src/controllers/transactionsController.js
'use strict';

const axios = require('axios');
const config = require('../config');
const mongoose = require('mongoose');
const createError = require('http-errors');
const { getUsersConn, getTxConn } = require('../config/db');
const validationService = require('../services/validationService');

const User = require('../models/User')(getUsersConn());
const Notification = require('../models/Notification')(getUsersConn());
const Outbox = require('../models/Outbox')(getUsersConn());
const Transaction = require('../models/Transaction')(getTxConn());
const Balance = require('../models/Balance')(getUsersConn());

const logger = require('../utils/logger');
const { notifyTransactionViaGateway } = require('../services/notifyGateway');
const { convertAmount } = require('../tools/currency');
const generateTransactionRef = require('../utils/generateRef');

const PRINCIPAL_URL = config.principalUrl;
const GATEWAY_URL = config.gatewayUrl;

// Utilitaires
const sanitize = (text) =>
  String(text || '').replace(/[<>\\/{};]/g, '').trim();

const MAX_DESC_LENGTH = 500;

/**
 * NOTIFY PARTIES
 * - Push + In-app + Outbox gérés ici
 * - Emails transactionnels délégués au Gateway (SendGrid)
 */
async function notifyParties(tx, status, session, senderCurrencySymbol) {
  try {
    const [sender, receiver] = await Promise.all([
      User.findById(tx.sender)
        .select('email fullName pushTokens notificationSettings')
        .lean(),
      User.findById(tx.receiver)
        .select('email fullName pushTokens notificationSettings')
        .lean(),
    ]);

    if (!sender || !receiver) return;

    const dateStr = new Date().toLocaleString('fr-FR');
    const webLink = `${PRINCIPAL_URL}/confirm/${tx._id}?token=${tx.verificationToken}`;
    const mobileLink = `paynoval://confirm/${tx._id}?token=${tx.verificationToken}`;

    const dataSender = {
      transactionId: tx._id.toString(),
      amount: tx.amount.toString(),
      currency: senderCurrencySymbol,
      name: sender.fullName,
      senderEmail: sender.email,
      receiverEmail: tx.recipientEmail || receiver.email,
      date: dateStr,
      confirmLinkWeb: webLink,
      country: tx.country,
      securityQuestion: tx.securityQuestion,
    };

    const dataReceiver = {
      transactionId: tx._id.toString(),
      amount: tx.localAmount.toString(),
      currency: tx.localCurrencySymbol,
      name: tx.nameDestinataire,
      receiverEmail: tx.recipientEmail,
      senderEmail: sender.email,
      date: dateStr,
      confirmLink: mobileLink,
      country: tx.country,
      securityQuestion: tx.securityQuestion,
      senderName: sender.fullName,
    };

    const sSettings = sender.notificationSettings || {};
    const rSettings = receiver.notificationSettings || {};

    const {
      channels: {
        email: sEmailChan = true,
        push: sPushChan = true,
        inApp: sInAppChan = true,
      } = {},
      types: {
        txSent: sTxSentType = true,
        txReceived: sTxReceivedType = true,
        txFailed: sTxFailedType = true,
      } = {},
    } = sSettings;

    const {
      channels: {
        email: rEmailChan = true,
        push: rPushChan = true,
        inApp: rInAppChan = true,
      } = {},
      types: {
        txSent: rTxSentType = true,
        txReceived: rTxReceivedType = true,
        txFailed: rTxFailedType = true,
      } = {},
    } = rSettings;

    let sTypeKey;
    let rTypeKey;
    if (status === 'initiated' || status === 'confirmed') {
      sTypeKey = 'txSent';
      rTypeKey = 'txReceived';
    } else if (status === 'cancelled') {
      sTypeKey = 'txFailed';
      rTypeKey = 'txFailed';
    }

    const statusTextMap = {
      initiated: 'Transaction en attente',
      confirmed: 'Transaction confirmée',
      cancelled: 'Transaction annulée',
    };
    const statusText = statusTextMap[status] || `Transaction ${status}`;

    const messageForSender = `${statusText}\nMontant : ${dataSender.amount} ${dataSender.currency}`;
    const messageForReceiver = `${statusText}\nMontant : ${dataReceiver.amount} ${dataReceiver.currency}`;

    async function triggerPush(userId, message) {
      try {
        await axios.post(
          `${PRINCIPAL_URL}/internal/notify`,
          { userId, message },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-internal-token': process.env.INTERNAL_TOKEN,
            },
          }
        );
      } catch (err) {
        console.warn(
          `Échec push pour user ${userId} : ${err.message || err}`
        );
      }
    }

    // Sender
    if (
      sPushChan &&
      ((sTypeKey === 'txSent' && sTxSentType) ||
        (sTypeKey === 'txFailed' && sTxFailedType))
    ) {
      if (sender.pushTokens && sender.pushTokens.length) {
        await triggerPush(sender._id.toString(), messageForSender);
      }
    }

    if (
      sInAppChan &&
      ((sTypeKey === 'txSent' && sTxSentType) ||
        (sTypeKey === 'txFailed' && sTxFailedType))
    ) {
      await Notification.create(
        [
          {
            recipient: sender._id.toString(),
            type: `transaction_${status}`,
            data: dataSender,
            read: false,
            date: new Date(),
          },
        ],
        { session }
      );
    }

    // Receiver
    if (
      rPushChan &&
      ((rTypeKey === 'txReceived' && rTxReceivedType) ||
        (rTypeKey === 'txFailed' && rTxFailedType))
    ) {
      if (receiver.pushTokens && receiver.pushTokens.length) {
        await triggerPush(receiver._id.toString(), messageForReceiver);
      }
    }

    if (
      rInAppChan &&
      ((rTypeKey === 'txReceived' && rTxReceivedType) ||
        (rTypeKey === 'txFailed' && rTxFailedType))
    ) {
      await Notification.create(
        [
          {
            recipient: receiver._id.toString(),
            type: `transaction_${status}`,
            data: dataReceiver,
            read: false,
            date: new Date(),
          },
        ],
        { session }
      );
    }

    const events = [sender, receiver].map((u) => ({
      service: 'notifications',
      event: `transaction_${status}`,
      payload: {
        userId: u._id.toString(),
        type: `transaction_${status}`,
        data:
          u._id.toString() === sender._id.toString()
            ? dataSender
            : dataReceiver,
      },
    }));
    await Outbox.insertMany(events, { session });

    // Emails via Gateway (SendGrid, templates)
    const shouldEmailSender =
      sEmailChan &&
      ((sTypeKey === 'txSent' && sTxSentType) ||
        (sTypeKey === 'txFailed' && sTxFailedType));

    const shouldEmailReceiver =
      rEmailChan &&
      ((rTypeKey === 'txReceived' && rTxReceivedType) ||
        (rTypeKey === 'txFailed' && rTxFailedType));

    if (shouldEmailSender || shouldEmailReceiver) {
      const payloadForGateway = {
        transaction: {
          id: tx._id.toString(),
          reference: tx.reference,
          amount: parseFloat(tx.amount.toString()),
          currency: senderCurrencySymbol,
          dateIso: tx.createdAt?.toISOString() || new Date().toISOString(),
        },
        sender: {
          email: sender.email,
          name: sender.fullName || sender.email,
          wantsEmail: shouldEmailSender,
        },
        receiver: {
          email: tx.recipientEmail || receiver.email,
          name:
            tx.nameDestinataire ||
            receiver.fullName ||
            receiver.email,
          wantsEmail: shouldEmailReceiver,
        },
        reason: status === 'cancelled' ? tx.cancelReason : undefined,
        links: {
          sender: `${PRINCIPAL_URL}/transactions/${tx._id}`,
          receiverConfirm: webLink,
        },
      };

      notifyTransactionViaGateway(status, payloadForGateway).catch((err) =>
        console.error(
          '[notifyParties] Erreur notif via Gateway:',
          err?.message || err
        )
      );
    }
  } catch (err) {
    console.error(
      'notifyParties : erreur lors de l’envoi des notifications',
      err
    );
  }
}

// -------------------------------------------------------------------
// LISTE des transactions internes de l'utilisateur connecté
// GET /api/v1/transactions?skip=0&limit=25
exports.listInternal = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const skip = parseInt(req.query.skip, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);

    const query = {
      $or: [{ sender: userId }, { receiver: userId }],
    };

    const [txs, total] = await Promise.all([
      Transaction.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Transaction.countDocuments(query),
    ]);

    res.json({
      success: true,
      count: txs.length,
      total,
      data: txs,
      skip,
      limit,
    });
  } catch (err) {
    next(err);
  }
};

// -------------------------------------------------------------------
// GET une transaction par ID (must be sender or receiver)
exports.getTransactionController = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const tx = await Transaction.findById(id).lean();
    if (!tx) {
      return res
        .status(404)
        .json({ success: false, message: 'Transaction non trouvée' });
    }

    const isSender = tx.sender?.toString() === userId;
    const isReceiver = tx.receiver?.toString() === userId;

    if (!isSender && !isReceiver) {
      return res
        .status(404)
        .json({ success: false, message: 'Transaction non trouvée' });
    }

    return res.status(200).json({ success: true, data: tx });
  } catch (err) {
    next(err);
  }
};

// -------------------------------------------------------------------
// INITIATE (PayNoval → PayNoval interne, fees via Gateway)
exports.initiateInternal = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

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
      country,
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

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw createError(401, 'Token manquant');
    }

    const senderId = req.user.id;
    const senderUser = await User.findById(senderId)
      .select('fullName email')
      .lean()
      .session(session);
    if (!senderUser) throw createError(403, 'Utilisateur invalide');

    const receiver = await User.findOne({ email: sanitize(toEmail) })
      .select('_id fullName email')
      .lean()
      .session(session);
    if (!receiver) throw createError(404, 'Destinataire introuvable');
    if (receiver._id.toString() === senderId) {
      throw createError(400, 'Auto-transfert impossible');
    }

    // Checks génériques (limites montant, pattern, etc.)
    await validationService.validateTransactionAmount({
      amount: req.body.amount,
    });
    await validationService.detectBasicFraud({
      sender: req.user.id,
      receiver: receiver._id,
      amount: req.body.amount,
      currency: req.body.senderCurrencySymbol,
    });

    const amt = parseFloat(amount);
    if (Number.isNaN(amt) || amt <= 0) {
      throw createError(400, 'Montant invalide');
    }

    // ---------- FEES via Gateway (/fees/simulate) ----------
    let gatewayBase =
      GATEWAY_URL || process.env.GATEWAY_URL || 'https://api-gateway-8cgy.onrender.com';
    gatewayBase = gatewayBase.replace(/\/+$/, '');
    if (!gatewayBase.endsWith('/api/v1')) {
      gatewayBase = `${gatewayBase}/api/v1`;
    }

    const feeUrl = `${gatewayBase}/fees/simulate`;

    const simulateParams = {
      provider: 'paynoval',
      amount: amt,
      fromCurrency: senderCurrencySymbol,
      toCurrency: localCurrencySymbol,
      country,
      // type: 'standard'
    };

    let feeData;
    try {
      const feeRes = await axios.get(feeUrl, {
        params: simulateParams,
        headers: {
          Authorization: authHeader,
          ...(process.env.INTERNAL_TOKEN
            ? { 'x-internal-token': process.env.INTERNAL_TOKEN }
            : {}),
        },
        timeout: 10000,
      });

      if (!feeRes.data || feeRes.data.success === false) {
        throw createError(502, 'Erreur calcul frais (gateway)');
      }

      feeData = feeRes.data.data;
    } catch (e) {
      logger.error('[fees/simulate] échec appel Gateway', {
        url: feeUrl,
        params: simulateParams,
        status: e.response?.status,
        responseData: e.response?.data,
      });
      throw createError(502, 'Service de calcul des frais indisponible');
    }

    const fee = parseFloat(feeData.fees);
    const netAmount = parseFloat(feeData.netAfterFees);
    const feeId = feeData.feeId || null;
    const feeSnapshot = feeData;

    // Débit expéditeur (sur montant total envoyé)
    const balDoc = await Balance.findOne({ user: senderId }).session(session);
    const balanceFloat = balDoc?.amount ?? 0;
    if (balanceFloat < amt) {
      throw createError(
        400,
        `Solde insuffisant : ${balanceFloat.toFixed(2)}`
      );
    }

    const debited = await Balance.findOneAndUpdate(
      { user: senderId },
      { $inc: { amount: -amt } },
      { new: true, session }
    );
    if (!debited) {
      throw createError(500, 'Erreur lors du débit du compte expéditeur');
    }

    // Crédit admin sur les fees (en CAD)
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
    const adminUser = await User.findOne({ email: adminEmail })
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

    // Conversion montant principal pour devise locale
    const { rate, converted } = await convertAmount(
      senderCurrencySymbol,
      localCurrencySymbol,
      amt
    );

    const decAmt = mongoose.Types.Decimal128.fromString(amt.toFixed(2));
    const decFees = mongoose.Types.Decimal128.fromString(fee.toFixed(2));
    const decNet = mongoose.Types.Decimal128.fromString(
      netAmount.toFixed(2)
    );
    const decLocal = mongoose.Types.Decimal128.fromString(
      converted.toFixed(2)
    );
    const decExchange = mongoose.Types.Decimal128.fromString(rate.toString());

    const nameDest =
      recipientInfo.name && sanitize(recipientInfo.name)
        ? sanitize(recipientInfo.name)
        : receiver.fullName;

    const reference = await generateTransactionRef();

    const [tx] = await Transaction.create(
      [
        {
          reference,
          sender: senderUser._id,
          receiver: receiver._id,
          amount: decAmt,
          transactionFees: decFees,
          netAmount: decNet,
          feeSnapshot,
          feeId,
          senderCurrencySymbol: sanitize(senderCurrencySymbol),
          exchangeRate: decExchange,
          localAmount: decLocal,
          localCurrencySymbol: sanitize(localCurrencySymbol),
          senderName: senderUser.fullName,
          senderEmail: senderUser.email,
          nameDestinataire: nameDest,
          recipientEmail: sanitize(toEmail),
          country: sanitize(country),
          description: sanitize(description),
          securityQuestion: sanitize(question),
          securityCode: sanitize(securityCode),
          destination: sanitize(destination),
          funds: sanitize(funds),
          status: 'pending',
        },
      ],
      { session }
    );

    await notifyParties(tx, 'initiated', session, senderCurrencySymbol);

    await session.commitTransaction();
    session.endSession();

    return res.status(201).json({
      success: true,
      transactionId: tx._id.toString(),
      reference: tx.reference,
      adminFeeInCAD,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
};

// -------------------------------------------------------------------
// CONFIRM
exports.confirmController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const { transactionId, securityCode } = req.body;
    if (!transactionId || !securityCode) {
      throw createError(400, 'transactionId et securityCode sont requis');
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw createError(401, 'Token manquant');
    }

    const tx = await Transaction.findById(transactionId)
      .select([
        '+securityCode',
        '+amount',
        '+transactionFees',
        '+netAmount',
        '+senderCurrencySymbol',
        '+localCurrencySymbol',
        '+receiver',
        '+sender',
        '+feeSnapshot',
        '+feeId',
        '+attemptCount',
        '+lastAttemptAt',
        '+lockedUntil',
        '+status',
      ])
      .session(session);

    if (!tx) throw createError(400, 'Transaction introuvable');

    validationService.validateTransactionStatusChange(
      tx.status,
      'confirmed'
    );

    if (tx.status !== 'pending') {
      throw createError(400, 'Transaction déjà traitée ou annulée');
    }

    const now = new Date();
    if (tx.lockedUntil && tx.lockedUntil > now) {
      throw createError(
        423,
        `Transaction temporairement bloquée, réessayez après ${tx.lockedUntil.toLocaleTimeString(
          'fr-FR'
        )}`
      );
    }

    if ((tx.attemptCount || 0) >= 3) {
      tx.status = 'cancelled';
      tx.cancelledAt = now;
      tx.cancelReason = 'Code de sécurité erroné (trop d’essais)';
      tx.lockedUntil = new Date(now.getTime() + 15 * 60 * 1000);
      await tx.save({ session });
      await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
      throw createError(401, 'Nombre d’essais dépassé, transaction annulée');
    }

    if (String(tx.receiver) !== String(req.user.id)) {
      throw createError(
        403,
        'Vous n’êtes pas le destinataire de cette transaction'
      );
    }

    const sanitizedCode = String(securityCode)
      .replace(/[<>\\/{};]/g, '')
      .trim();

    if (sanitizedCode !== tx.securityCode) {
      tx.attemptCount = (tx.attemptCount || 0) + 1;
      tx.lastAttemptAt = now;

      if (tx.attemptCount >= 3) {
        tx.status = 'cancelled';
        tx.cancelledAt = now;
        tx.cancelReason = 'Code de sécurité erroné (trop d’essais)';
        tx.lockedUntil = new Date(now.getTime() + 15 * 60 * 1000);
        await tx.save({ session });
        await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
        throw createError(
          401,
          'Code de sécurité incorrect. Nombre d’essais dépassé, transaction annulée.'
        );
      } else {
        await tx.save({ session });
        throw createError(
          401,
          `Code de sécurité incorrect. Il vous reste ${
            3 - tx.attemptCount
          } essai(s).`
        );
      }
    }

    // Reset brute-force
    tx.attemptCount = 0;
    tx.lastAttemptAt = null;
    tx.lockedUntil = null;

    const netBrut = parseFloat(tx.netAmount.toString());

    let localNetRounded;
    if (tx.feeSnapshot && tx.feeSnapshot.netAfterFees) {
      localNetRounded = parseFloat(tx.feeSnapshot.netAfterFees);
    } else {
      const { converted: localNet } = await convertAmount(
        tx.senderCurrencySymbol,
        tx.localCurrencySymbol,
        netBrut
      );
      localNetRounded = parseFloat(localNet.toFixed(2));
    }

    const credited = await Balance.findOneAndUpdate(
      { user: tx.receiver },
      { $inc: { amount: localNetRounded } },
      { new: true, upsert: true, session }
    );
    if (!credited) {
      throw createError(
        500,
        'Erreur lors du crédit au destinataire'
      );
    }

    tx.status = 'confirmed';
    tx.confirmedAt = now;
    await tx.save({ session });

    await notifyParties(tx, 'confirmed', session, tx.senderCurrencySymbol);

    await session.commitTransaction();
    session.endSession();

    return res.json({
      success: true,
      credited: localNetRounded,
      feeId: tx.feeId,
      feeSnapshot: tx.feeSnapshot,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
};

// -------------------------------------------------------------------
// CANCEL
exports.cancelController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const { transactionId, reason = 'Annulé' } = req.body;
    if (!transactionId) {
      throw createError(400, 'transactionId requis pour annuler');
    }

    const tx = await Transaction.findById(transactionId)
      .select([
        '+netAmount',
        '+amount',
        '+senderCurrencySymbol',
        '+sender',
        '+receiver',
        '+status',
      ])
      .session(session);

    if (!tx) throw createError(400, 'Transaction introuvable');

    validationService.validateTransactionStatusChange(
      tx.status,
      'cancelled'
    );

    if (tx.status !== 'pending') {
      throw createError(400, 'Transaction déjà traitée ou annulée');
    }

    const userId = String(req.user.id);
    const senderId = String(tx.sender);
    const receiverId = String(tx.receiver);
    if (userId !== senderId && userId !== receiverId) {
      throw createError(
        403,
        'Vous n’êtes pas autorisé à annuler cette transaction'
      );
    }

    // ------------------- Frais d’annulation via Gateway -------------------
    let cancellationFee = 0;
    let cancellationFeeType = 'fixed';
    let cancellationFeePercent = 0;
    let cancellationFeeId = null;

    try {
      let gatewayBase =
        GATEWAY_URL || process.env.GATEWAY_URL || 'https://api-gateway-8cgy.onrender.com';
      gatewayBase = gatewayBase.replace(/\/+$/, '');
      if (!gatewayBase.endsWith('/api/v1')) {
        gatewayBase = `${gatewayBase}/api/v1`;
      }

      const { data } = await axios.get(`${gatewayBase}/fees/simulate`, {
        params: {
          provider: tx.funds || 'paynoval',
          amount: tx.amount.toString(),
          fromCurrency: tx.senderCurrencySymbol,
          toCurrency: tx.senderCurrencySymbol,
          type: 'cancellation',
        },
        timeout: 6000,
      });

      if (data && data.success) {
        cancellationFee = data.data.fees;
        cancellationFeeType = data.data.type || 'fixed';
        cancellationFeePercent = data.data.feePercent || 0;
        cancellationFeeId = data.data.feeId || null;
      } else {
        cancellationFee = 0;
      }
    } catch (e) {
      // fallback legacy suivant la devise
      const symbol = tx.senderCurrencySymbol.trim();
      if (['USD', '$USD', 'CAD', '$CAD', 'EUR', '€'].includes(symbol)) {
        cancellationFee = 2.99;
      } else if (['XOF', 'XAF', 'F CFA'].includes(symbol)) {
        cancellationFee = 300;
      }
    }

    const netStored = parseFloat(tx.netAmount.toString());
    const refundAmt = parseFloat((netStored - cancellationFee).toFixed(2));
    if (refundAmt < 0) {
      throw createError(
        400,
        'Frais d’annulation supérieurs au montant net à rembourser'
      );
    }

    const refunded = await Balance.findOneAndUpdate(
      { user: tx.sender },
      { $inc: { amount: refundAmt } },
      { new: true, upsert: true, session }
    );
    if (!refunded) {
      throw createError(
        500,
        'Erreur lors du remboursement au compte expéditeur'
      );
    }

    // Crédit admin sur les frais d’annulation
    const adminCurrency = 'CAD';
    let adminFeeConverted = 0;

    if (cancellationFee > 0) {
      const { converted } = await convertAmount(
        tx.senderCurrencySymbol,
        adminCurrency,
        cancellationFee
      );
      adminFeeConverted = parseFloat(converted.toFixed(2));
    }

    const adminEmail = 'admin@paynoval.com';
    const adminUser = await User.findOne({ email: adminEmail })
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

    tx.status = 'cancelled';
    tx.cancelledAt = new Date();
    tx.cancelReason = `${
      userId === receiverId
        ? 'Annulé par le destinataire'
        : 'Annulé par l’expéditeur'
    } : ${sanitize(reason)}`;
    tx.cancellationFee = cancellationFee;
    tx.cancellationFeeType = cancellationFeeType;
    tx.cancellationFeePercent = cancellationFeePercent;
    tx.cancellationFeeId = cancellationFeeId;
    await tx.save({ session });

    await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);

    await session.commitTransaction();
    session.endSession();

    return res.json({
      success: true,
      refunded,
      cancellationFeeInSenderCurrency: cancellationFee,
      cancellationFeeType,
      cancellationFeePercent,
      cancellationFeeId,
      adminFeeCredited: adminFeeConverted,
      adminCurrency,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
};

// -------------------------------------------------------------------
// REFUND (admin)
exports.refundController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { transactionId, reason = 'Remboursement demandé' } = req.body;

    const tx = await Transaction.findById(transactionId).session(session);
    if (!tx || tx.status !== 'confirmed') {
      throw createError(400, 'Transaction non remboursable');
    }

    if (tx.refundedAt) {
      throw createError(400, 'Déjà remboursée');
    }

    const amt = parseFloat(tx.localAmount.toString());
    if (amt <= 0) {
      throw createError(400, 'Montant de remboursement invalide');
    }

    const debited = await Balance.findOneAndUpdate(
      { user: tx.receiver },
      { $inc: { amount: -amt } },
      { new: true, session }
    );
    if (!debited || debited.amount < 0) {
      throw createError(400, 'Solde du destinataire insuffisant');
    }

    await Balance.findOneAndUpdate(
      { user: tx.sender },
      { $inc: { amount: amt } },
      { new: true, upsert: true, session }
    );

    tx.status = 'refunded';
    tx.refundedAt = new Date();
    tx.refundReason = reason;
    await tx.save({ session });

    logger.warn(
      `[ALERTE REFUND] Remboursement manuel ! tx=${transactionId}, by=${
        req.user?.email || req.user?.id
      }, amount=${amt}`
    );

    await session.commitTransaction();
    session.endSession();

    res.json({ success: true, refunded: amt });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    next(err);
  }
};

// -------------------------------------------------------------------
// VALIDATE (admin)
exports.validateController = async (req, res, next) => {
  try {
    const { transactionId, status, adminNote } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx || tx.status !== 'pending') {
      throw createError(400, 'Transaction non validable');
    }

    if (!['confirmed', 'rejected'].includes(status)) {
      throw createError(400, 'Statut de validation invalide');
    }

    tx.status = status;
    tx.validatedAt = new Date();
    tx.adminNote = adminNote || null;
    await tx.save();

    res.json({ success: true, message: `Transaction ${status}` });
  } catch (err) {
    next(err);
  }
};

// -------------------------------------------------------------------
// REASSIGN (admin)
exports.reassignController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { transactionId, newReceiverEmail } = req.body;

    const tx = await Transaction.findById(transactionId).session(session);
    if (!tx || !['pending', 'confirmed'].includes(tx.status)) {
      throw createError(400, 'Transaction non réassignable');
    }

    const newReceiver = await User.findOne({ email: newReceiverEmail })
      .select('_id fullName email')
      .session(session);
    if (!newReceiver) {
      throw createError(404, 'Nouveau destinataire introuvable');
    }
    if (String(newReceiver._id) === String(tx.receiver)) {
      throw createError(
        400,
        'Déjà affectée à ce destinataire'
      );
    }

    tx.receiver = newReceiver._id;
    tx.nameDestinataire = newReceiver.fullName;
    tx.recipientEmail = newReceiver.email;
    tx.reassignedAt = new Date();
    await tx.save({ session });

    logger.warn(
      `ALERTE REASSIGN: tx=${transactionId} réassignée par ${
        req.user?.email || req.user?.id
      } à ${newReceiverEmail}`
    );

    await session.commitTransaction();
    session.endSession();

    res.json({
      success: true,
      newReceiver: { id: newReceiver._id, email: newReceiver.email },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    next(err);
  }
};

// -------------------------------------------------------------------
// ARCHIVE (admin)
exports.archiveController = async (req, res, next) => {
  try {
    const { transactionId } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx) throw createError(404, 'Transaction non trouvée');
    if (tx.archived) throw createError(400, 'Déjà archivée');

    tx.archived = true;
    tx.archivedAt = new Date();
    tx.archivedBy = req.user?.email || req.user?.id || null;
    await tx.save();

    res.json({ success: true, archived: true });
  } catch (err) {
    next(err);
  }
};

// -------------------------------------------------------------------
// RELAUNCH (admin)
exports.relaunchController = async (req, res, next) => {
  try {
    const { transactionId } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx)
      throw createError(404, 'Transaction non trouvée');
    if (!['pending', 'cancelled'].includes(tx.status)) {
      throw createError(
        400,
        'Seules les transactions en attente ou annulées peuvent être relancées'
      );
    }

    tx.status = 'relaunch';
    tx.relaunchedAt = new Date();
    tx.relaunchedBy = req.user?.email || req.user?.id || null;
    tx.relaunchCount = (tx.relaunchCount || 0) + 1;
    await tx.save();

    res.json({ success: true, relaunched: true, txId: tx._id });
  } catch (err) {
    next(err);
  }
};

// Export pour réutilisation éventuelle
exports.notifyParties = notifyParties;
