// File: src/controllers/transactionsController.js
'use strict';

/**
 * ✅ transactionsController (API Transactions interne PayNoval)
 * Objectif :
 * - Initiation PayNoval -> PayNoval : débit expéditeur, calcul frais (Gateway), stockage tx.
 * - Confirmation (destinataire) : vérif code sécurité, crédit destinataire dans SA devise locale.
 * - Annulation / remboursement / actions admin : gestion avancée.
 */

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

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Nettoie un texte simple (anti injection / caractères dangereux).
 * NB: ce n’est pas un sanitize HTML complet, juste une protection légère.
 */
const sanitize = (text) =>
  String(text || '').replace(/[<>\\/{};]/g, '').trim();

const MAX_DESC_LENGTH = 500;

/**
 * Convertit proprement un nombre (string/Decimal128/number) en float.
 */
function toFloat(v, fallback = 0) {
  try {
    if (v === null || v === undefined) return fallback;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Arrondi monnaie (2 décimales).
 */
function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return parseFloat(x.toFixed(2));
}

/**
 * Decimal128 safe (2 décimales).
 */
function dec2(n) {
  return mongoose.Types.Decimal128.fromString(round2(n).toFixed(2));
}

/* ------------------------------------------------------------------ */
/* Notifications (push + in-app + outbox + email via gateway)          */
/* ------------------------------------------------------------------ */

/**
 * NOTIFY PARTIES
 * - Push + in-app + outbox gérés ici
 * - Emails transactionnels délégués au Gateway
 */
async function notifyParties(tx, status, session, senderCurrencySymbol) {
  try {
    // 1) Récupérer expéditeur et destinataire (infos utiles notifications)
    const [sender, receiver] = await Promise.all([
      User.findById(tx.sender)
        .select('email fullName pushTokens notificationSettings')
        .lean(),
      User.findById(tx.receiver)
        .select('email fullName pushTokens notificationSettings')
        .lean(),
    ]);

    if (!sender || !receiver) return;

    // 2) Construire liens + payloads
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

    /**
     * ✅ IMPORTANT : dataReceiver.amount = tx.localAmount
     * Ici tx.localAmount est le montant réellement crédité (net converti).
     */
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

    // 3) Lire settings notifications (fallback safe)
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

    // 4) Déterminer type notif selon statut
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

    // 5) Helper push via principal /internal/notify
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
        console.warn(`Échec push pour user ${userId} : ${err.message || err}`);
      }
    }

    // ------------------- Sender -------------------
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

    // ------------------- Receiver -------------------
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

    // 6) Outbox (pour replay / async processing)
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

    // 7) Emails via Gateway (SendGrid)
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
          name: tx.nameDestinataire || receiver.fullName || receiver.email,
          wantsEmail: shouldEmailReceiver,
        },
        reason: status === 'cancelled' ? tx.cancelReason : undefined,
        links: {
          sender: `${PRINCIPAL_URL}/transactions/${tx._id}`,
          receiverConfirm: webLink,
        },
      };

      notifyTransactionViaGateway(status, payloadForGateway).catch((err) =>
        console.error('[notifyParties] Erreur notif via Gateway:', err?.message || err)
      );
    }
  } catch (err) {
    console.error('notifyParties : erreur lors de l’envoi des notifications', err);
  }
}

/* ------------------------------------------------------------------ */
/* LIST                                                                */
/* ------------------------------------------------------------------ */

/**
 * Liste des transactions internes de l'utilisateur connecté
 * GET /api/v1/transactions?skip=0&limit=25
 */
exports.listInternal = async (req, res, next) => {
  try {
    // 1) Pagination
    const userId = req.user.id;
    const skip = parseInt(req.query.skip, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);

    // 2) Query : expéditeur OU destinataire
    const query = {
      $or: [{ sender: userId }, { receiver: userId }],
    };

    // 3) Récupération + total
    const [txs, total] = await Promise.all([
      Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Transaction.countDocuments(query),
    ]);

    // 4) Réponse
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

/* ------------------------------------------------------------------ */
/* GET BY ID                                                           */
/* ------------------------------------------------------------------ */

/**
 * Retourne une transaction par ID (doit être sender OU receiver)
 */
exports.getTransactionController = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const tx = await Transaction.findById(id).lean();
    if (!tx) {
      return res.status(404).json({ success: false, message: 'Transaction non trouvée' });
    }

    const isSender = tx.sender?.toString() === userId;
    const isReceiver = tx.receiver?.toString() === userId;
    if (!isSender && !isReceiver) {
      return res.status(404).json({ success: false, message: 'Transaction non trouvée' });
    }

    return res.status(200).json({ success: true, data: tx });
  } catch (err) {
    next(err);
  }
};

/* ------------------------------------------------------------------ */
/* INITIATE (PayNoval -> PayNoval)                                     */
/* ------------------------------------------------------------------ */

/**
 * INITIATE
 * - Vérifie inputs
 * - Appelle Gateway /fees/simulate pour frais + taux + net converti
 * - Débite expéditeur (montant brut)
 * - Crédite admin (fees convertis en CAD)
 * - Stocke Transaction (pending)
 */
exports.initiateInternal = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // 1) Récupération body
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

    // 2) Validations basiques
    if (!toEmail || !sanitize(toEmail)) throw createError(400, 'Email du destinataire requis');
    if (!question || !securityCode) throw createError(400, 'Question et code de sécurité requis');
    if (!destination || !funds || !country) throw createError(400, 'Données de transaction incomplètes');
    if (description && description.length > MAX_DESC_LENGTH) throw createError(400, 'Description trop longue');

    // 3) Auth requis (pour forward gateway si besoin)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) throw createError(401, 'Token manquant');

    // 4) Vérification sender + receiver
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

    if (receiver._id.toString() === senderId) throw createError(400, 'Auto-transfert impossible');

    // 5) Anti-fraude / validations (service)
    await validationService.validateTransactionAmount({ amount: req.body.amount });
    await validationService.detectBasicFraud({
      sender: req.user.id,
      receiver: receiver._id,
      amount: req.body.amount,
      currency: req.body.senderCurrencySymbol,
    });

    const amt = toFloat(amount);
    if (!amt || Number.isNaN(amt) || amt <= 0) throw createError(400, 'Montant invalide');

    // 6) Gateway base URL + /fees/simulate
    let gatewayBase =
      GATEWAY_URL ||
      process.env.GATEWAY_URL ||
      'https://api-gateway-8cgy.onrender.com';

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
    };

    // 7) Appel Gateway pour récupérer fees + netAfterFees + convertedNetAfterFees
    let feeData;
    try {
      const feeRes = await axios.get(feeUrl, {
        params: simulateParams,
        headers: {
          Authorization: authHeader,
          ...(process.env.INTERNAL_TOKEN ? { 'x-internal-token': process.env.INTERNAL_TOKEN } : {}),
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

    // 8) Lire frais / net (devises expéditeur)
    const fee = round2(toFloat(feeData.fees));
    const netAmount = round2(toFloat(feeData.netAfterFees));
    const feeId = feeData.feeId || null;
    const feeSnapshot = feeData;

    // 9) Vérifier solde expéditeur, puis débiter le BRUT (amt)
    const balDoc = await Balance.findOne({ user: senderId }).session(session);
    const balanceFloat = toFloat(balDoc?.amount, 0);

    if (balanceFloat < amt) {
      throw createError(400, `Solde insuffisant : ${balanceFloat.toFixed(2)}`);
    }

    const debited = await Balance.findOneAndUpdate(
      { user: senderId },
      { $inc: { amount: -amt } },
      { new: true, session }
    );

    if (!debited) throw createError(500, 'Erreur lors du débit du compte expéditeur');

    // 10) Crédit admin sur les fees (en CAD)
    let adminFeeInCAD = 0;
    if (fee > 0) {
      const { converted } = await convertAmount(senderCurrencySymbol, 'CAD', fee);
      adminFeeInCAD = round2(converted);
    }

    const adminEmail = 'admin@paynoval.com';
    const adminUser = await User.findOne({ email: adminEmail })
      .select('_id')
      .session(session);

    if (!adminUser) throw createError(500, 'Compte administrateur introuvable');

    if (adminFeeInCAD > 0) {
      await Balance.findOneAndUpdate(
        { user: adminUser._id },
        { $inc: { amount: adminFeeInCAD } },
        { new: true, upsert: true, session }
      );
    }

    /**
     * ✅ 11) Conversion du NET après frais vers devise destinataire
     * Priorité au snapshot gateway (même taux / cohérence).
     * On veut un localAmount = net converti (montant crédité).
     */
    let rateUsed = null;
    let convertedLocalNet = null;

    // Si le gateway fournit exchangeRate + convertedNetAfterFees => meilleur cas
    if (
      feeSnapshot &&
      typeof feeSnapshot.exchangeRate === 'number' &&
      Number.isFinite(feeSnapshot.exchangeRate) &&
      feeSnapshot.convertedNetAfterFees !== undefined
    ) {
      rateUsed = feeSnapshot.exchangeRate;
      convertedLocalNet = round2(toFloat(feeSnapshot.convertedNetAfterFees));
    } else if (feeSnapshot && feeSnapshot.convertedNetAfterFees !== undefined) {
      // au cas où exchangeRate est string, on accepte quand même
      rateUsed = toFloat(feeSnapshot.exchangeRate, null);
      convertedLocalNet = round2(toFloat(feeSnapshot.convertedNetAfterFees));
    } else {
      // fallback : conversion live
      const { rate, converted } = await convertAmount(
        senderCurrencySymbol,
        localCurrencySymbol,
        netAmount
      );
      rateUsed = rate;
      convertedLocalNet = round2(converted);
    }

    if (!Number.isFinite(convertedLocalNet) || convertedLocalNet <= 0) {
      throw createError(500, 'Conversion devise échouée (montant local invalide)');
    }

    // 12) Construire champs Decimal128
    const decAmt = dec2(amt);
    const decFees = dec2(fee);
    const decNet = dec2(netAmount);
    const decLocal = dec2(convertedLocalNet);
    const decExchange = mongoose.Types.Decimal128.fromString(String(rateUsed || 1));

    // 13) Nom destinataire
    const nameDest =
      recipientInfo.name && sanitize(recipientInfo.name)
        ? sanitize(recipientInfo.name)
        : receiver.fullName;

    // 14) Référence unique tx
    const reference = await generateTransactionRef();

    // 15) Création transaction en DB (status = pending)
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
          localAmount: decLocal, // ✅ montant réellement crédité en devise destinataire
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

    // 16) Notifier (sender + receiver)
    await notifyParties(tx, 'initiated', session, senderCurrencySymbol);

    // 17) Commit transaction Mongo
    await session.commitTransaction();
    session.endSession();

    // 18) Réponse API
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

/* ------------------------------------------------------------------ */
/* CONFIRM                                                             */
/* ------------------------------------------------------------------ */

/**
 * CONFIRM
 * - Seul le destinataire peut confirmer
 * - Vérifie le code de sécurité + anti brute-force (attemptCount/lockedUntil)
 * - Crédite le destinataire en devise locale avec le NET CONVERTI
 */
exports.confirmController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // 1) Inputs obligatoires
    const { transactionId, securityCode } = req.body;
    if (!transactionId || !securityCode) {
      throw createError(400, 'transactionId et securityCode sont requis');
    }

    // 2) Auth obligatoire
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw createError(401, 'Token manquant');
    }

    // 3) Charger la transaction (avec champs sensibles)
    const tx = await Transaction.findById(transactionId)
      .select([
        '+securityCode',
        '+amount',
        '+transactionFees',
        '+netAmount',
        '+senderCurrencySymbol',
        '+localCurrencySymbol',
        '+localAmount', // ✅ important
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

    // 4) Vérifier que le statut permet la confirmation
    validationService.validateTransactionStatusChange(tx.status, 'confirmed');

    if (tx.status !== 'pending') {
      throw createError(400, 'Transaction déjà traitée ou annulée');
    }

    // 5) Anti brute-force : lock temporaire
    const now = new Date();
    if (tx.lockedUntil && tx.lockedUntil > now) {
      throw createError(
        423,
        `Transaction temporairement bloquée, réessayez après ${tx.lockedUntil.toLocaleTimeString('fr-FR')}`
      );
    }

    // 6) Si trop d'essais déjà enregistrés => annule
    if ((tx.attemptCount || 0) >= 3) {
      tx.status = 'cancelled';
      tx.cancelledAt = now;
      tx.cancelReason = 'Code de sécurité erroné (trop d’essais)';
      tx.lockedUntil = new Date(now.getTime() + 15 * 60 * 1000);
      await tx.save({ session });

      await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);
      throw createError(401, 'Nombre d’essais dépassé, transaction annulée');
    }

    // 7) Seul le destinataire peut confirmer
    if (String(tx.receiver) !== String(req.user.id)) {
      throw createError(403, 'Vous n’êtes pas le destinataire de cette transaction');
    }

    // 8) Vérifier code (sanitized)
    const sanitizedCode = String(securityCode).replace(/[<>\\/{};]/g, '').trim();

    if (sanitizedCode !== tx.securityCode) {
      tx.attemptCount = (tx.attemptCount || 0) + 1;
      tx.lastAttemptAt = now;

      // 8.1) Si troisième erreur => annule et lock
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
      }

      // 8.2) Sinon, on sauvegarde et on renvoie le nombre restant
      await tx.save({ session });
      throw createError(
        401,
        `Code de sécurité incorrect. Il vous reste ${3 - tx.attemptCount} essai(s).`
      );
    }

    // 9) Code OK => reset brute-force
    tx.attemptCount = 0;
    tx.lastAttemptAt = null;
    tx.lockedUntil = null;

    /**
     * ✅ 10) Calcul du montant à créditer :
     * - Priorité : tx.localAmount (stocké à l’initiation = net converti)
     * - Sinon : snapshot gateway convertedNetAfterFees
     * - Sinon : conversion live sur netAmount
     */
    const netBrut = toFloat(tx.netAmount);

    let creditAmount = null;

    // 10.1) localAmount
    if (tx.localAmount !== undefined && tx.localAmount !== null) {
      const v = toFloat(tx.localAmount, null);
      if (Number.isFinite(v) && v > 0) creditAmount = v;
    }

    // 10.2) snapshot convertedNetAfterFees
    if (!creditAmount || !Number.isFinite(creditAmount) || creditAmount <= 0) {
      const snap = tx.feeSnapshot || {};
      const snapLocal =
        snap.convertedNetAfterFees ??
        snap.convertedNet ??
        snap.convertedNetAfterFee ??
        null;

      const v = toFloat(snapLocal, null);
      if (Number.isFinite(v) && v > 0) creditAmount = v;
    }

    // 10.3) fallback conversion live
    if (!creditAmount || !Number.isFinite(creditAmount) || creditAmount <= 0) {
      if (String(tx.senderCurrencySymbol || '').trim() === String(tx.localCurrencySymbol || '').trim()) {
        creditAmount = netBrut;
      } else {
        const { converted } = await convertAmount(
          tx.senderCurrencySymbol,
          tx.localCurrencySymbol,
          netBrut
        );
        creditAmount = round2(converted);
      }
    }

    creditAmount = round2(creditAmount);
    if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
      throw createError(500, 'Montant à créditer invalide après conversion');
    }

    // 11) Créditer le destinataire
    const credited = await Balance.findOneAndUpdate(
      { user: tx.receiver },
      { $inc: { amount: creditAmount } },
      { new: true, upsert: true, session }
    );

    if (!credited) throw createError(500, 'Erreur lors du crédit au destinataire');

    // 12) Finaliser tx
    tx.status = 'confirmed';
    tx.confirmedAt = now;

    // 12.1) Sécuriser localAmount (utile si tx anciennes)
    if (!tx.localAmount || round2(toFloat(tx.localAmount)) !== creditAmount) {
      tx.localAmount = dec2(creditAmount);
    }

    await tx.save({ session });

    // 13) Notifier les parties
    await notifyParties(tx, 'confirmed', session, tx.senderCurrencySymbol);

    // 14) Commit transaction Mongo
    await session.commitTransaction();
    session.endSession();

    // 15) Réponse API
    return res.json({
      success: true,
      credited: creditAmount,
      currencyCredited: tx.localCurrencySymbol,
      feeId: tx.feeId,
      feeSnapshot: tx.feeSnapshot,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    return next(err);
  }
};

/* ------------------------------------------------------------------ */
/* CANCEL                                                              */
/* ------------------------------------------------------------------ */

/**
 * CANCEL
 * - Expéditeur ou destinataire peut annuler si status pending
 * - Calcule frais d'annulation (gateway ou fallback)
 * - Rembourse expéditeur (netAmount - cancellationFee)
 * - Crédite admin (fee annulation convertie CAD)
 */
exports.cancelController = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // 1) Inputs
    const { transactionId, reason = 'Annulé' } = req.body;
    if (!transactionId) {
      throw createError(400, 'transactionId requis pour annuler');
    }

    // 2) Charger tx
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

    // 3) Statut compatible
    validationService.validateTransactionStatusChange(tx.status, 'cancelled');

    if (tx.status !== 'pending') {
      throw createError(400, 'Transaction déjà traitée ou annulée');
    }

    // 4) Autorisation : sender ou receiver
    const userId = String(req.user.id);
    const senderId = String(tx.sender);
    const receiverId = String(tx.receiver);

    if (userId !== senderId && userId !== receiverId) {
      throw createError(403, 'Vous n’êtes pas autorisé à annuler cette transaction');
    }

    // 5) Frais d’annulation via Gateway
    let cancellationFee = 0;
    let cancellationFeeType = 'fixed';
    let cancellationFeePercent = 0;
    let cancellationFeeId = null;

    try {
      let gatewayBase =
        GATEWAY_URL ||
        process.env.GATEWAY_URL ||
        'https://api-gateway-8cgy.onrender.com';

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
        cancellationFee = toFloat(data.data.fees, 0);
        cancellationFeeType = data.data.type || 'fixed';
        cancellationFeePercent = data.data.feePercent || 0;
        cancellationFeeId = data.data.feeId || null;
      } else {
        cancellationFee = 0;
      }
    } catch (e) {
      // 6) fallback legacy
      const symbol = String(tx.senderCurrencySymbol || '').trim();
      if (['USD', '$USD', 'CAD', '$CAD', 'EUR', '€'].includes(symbol)) {
        cancellationFee = 2.99;
      } else if (['XOF', 'XAF', 'F CFA'].includes(symbol)) {
        cancellationFee = 300;
      }
    }

    cancellationFee = round2(cancellationFee);

    // 7) Montant remboursé = netAmount - cancellationFee
    const netStored = toFloat(tx.netAmount);
    const refundAmt = round2(netStored - cancellationFee);
    if (refundAmt < 0) {
      throw createError(400, 'Frais d’annulation supérieurs au montant net à rembourser');
    }

    // 8) Rembourse expéditeur
    const refunded = await Balance.findOneAndUpdate(
      { user: tx.sender },
      { $inc: { amount: refundAmt } },
      { new: true, upsert: true, session }
    );

    if (!refunded) throw createError(500, 'Erreur lors du remboursement au compte expéditeur');

    // 9) Crédit admin sur frais d'annulation (CAD)
    const adminCurrency = 'CAD';
    let adminFeeConverted = 0;

    if (cancellationFee > 0) {
      const { converted } = await convertAmount(tx.senderCurrencySymbol, adminCurrency, cancellationFee);
      adminFeeConverted = round2(converted);
    }

    const adminEmail = 'admin@paynoval.com';
    const adminUser = await User.findOne({ email: adminEmail })
      .select('_id')
      .session(session);

    if (!adminUser) throw createError(500, 'Compte administrateur introuvable');

    if (adminFeeConverted > 0) {
      await Balance.findOneAndUpdate(
        { user: adminUser._id },
        { $inc: { amount: adminFeeConverted } },
        { new: true, upsert: true, session }
      );
    }

    // 10) Mettre à jour la tx
    tx.status = 'cancelled';
    tx.cancelledAt = new Date();
    tx.cancelReason = `${
      userId === receiverId ? 'Annulé par le destinataire' : 'Annulé par l’expéditeur'
    } : ${sanitize(reason)}`;
    tx.cancellationFee = cancellationFee;
    tx.cancellationFeeType = cancellationFeeType;
    tx.cancellationFeePercent = cancellationFeePercent;
    tx.cancellationFeeId = cancellationFeeId;

    await tx.save({ session });

    // 11) Notifier
    await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);

    // 12) Commit
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

/* ------------------------------------------------------------------ */
/* REFUND (admin)                                                      */
/* ------------------------------------------------------------------ */

/**
 * REFUND (admin)
 * - Réservé admin : rembourse une tx confirmed
 * - Débite le destinataire (localAmount)
 * - Crédite l’expéditeur (localAmount) (NB: logique existante conservée)
 */
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

    // Montant de remboursement = localAmount (devise destinataire)
    const amt = toFloat(tx.localAmount);
    if (amt <= 0) throw createError(400, 'Montant de remboursement invalide');

    // 1) Débiter destinataire
    const debited = await Balance.findOneAndUpdate(
      { user: tx.receiver },
      { $inc: { amount: -amt } },
      { new: true, session }
    );

    if (!debited || toFloat(debited.amount) < 0) {
      throw createError(400, 'Solde du destinataire insuffisant');
    }

    // 2) Crédite expéditeur
    await Balance.findOneAndUpdate(
      { user: tx.sender },
      { $inc: { amount: amt } },
      { new: true, upsert: true, session }
    );

    // 3) Mettre à jour tx
    tx.status = 'refunded';
    tx.refundedAt = new Date();
    tx.refundReason = reason;
    await tx.save({ session });

    logger.warn(
      `[ALERTE REFUND] Remboursement manuel ! tx=${transactionId}, by=${req.user?.email || req.user?.id}, amount=${amt}`
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

/* ------------------------------------------------------------------ */
/* VALIDATE (admin)                                                    */
/* ------------------------------------------------------------------ */

/**
 * VALIDATE (admin)
 * - Permet validation admin (confirmed/rejected) d'une tx pending
 * - (comportement existant conservé)
 */
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

/* ------------------------------------------------------------------ */
/* REASSIGN (admin)                                                    */
/* ------------------------------------------------------------------ */

/**
 * REASSIGN (admin)
 * - Réassigne un destinataire par email
 */
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
    if (!newReceiver) throw createError(404, 'Nouveau destinataire introuvable');

    if (String(newReceiver._id) === String(tx.receiver)) {
      throw createError(400, 'Déjà affectée à ce destinataire');
    }

    tx.receiver = newReceiver._id;
    tx.nameDestinataire = newReceiver.fullName;
    tx.recipientEmail = newReceiver.email;
    tx.reassignedAt = new Date();
    await tx.save({ session });

    logger.warn(
      `ALERTE REASSIGN: tx=${transactionId} réassignée par ${req.user?.email || req.user?.id} à ${newReceiverEmail}`
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

/* ------------------------------------------------------------------ */
/* ARCHIVE (admin)                                                     */
/* ------------------------------------------------------------------ */

/**
 * ARCHIVE (admin)
 * - Marque une transaction comme archivée
 */
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

/* ------------------------------------------------------------------ */
/* RELAUNCH (admin)                                                    */
/* ------------------------------------------------------------------ */

/**
 * RELAUNCH (admin)
 * - Permet relancer une tx pending/cancelled
 */
exports.relaunchController = async (req, res, next) => {
  try {
    const { transactionId } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx) throw createError(404, 'Transaction non trouvée');

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
