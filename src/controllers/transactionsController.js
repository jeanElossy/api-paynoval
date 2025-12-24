// File: api paynoval microservice paynoval src/controllers/transactionsController.js
'use strict';

/**
 * ✅ transactionsController (API Transactions interne PayNoval)
 * Objectif :
 * - Initiation PayNoval -> PayNoval : débit expéditeur, calcul frais (Gateway), stockage tx.
 * - Confirmation (destinataire) : vérif code sécurité, crédit destinataire dans SA devise locale.
 * - Annulation / remboursement / actions admin : gestion avancée.
 *
 * ✅ Correctifs apportés :
 * 1) Sessions Mongo robustes avec multi-connections (usersConn / txConn) :
 *    - Détection si les 2 connexions partagent le même client pour pouvoir utiliser une transaction Mongo.
 *    - Sinon, on évite de passer un session incompatible (qui crash), et on fait “best effort”.
 *
 * 2) Débit/Crédit atomiques anti race-condition :
 *    - Débit expéditeur via findOneAndUpdate conditionnel (solde >= montant).
 *    - Refund/admin/receiver crédités de manière plus sûre.
 *
 * 3) Sécurité code :
 *    - On stocke maintenant le code de sécurité en SHA-256 (dans le champ securityCode existant),
 *      tout en gardant la compatibilité avec les anciennes tx (plain) lors de la confirmation.
 *
 * 4) Annulation automatique après 3 mauvais codes => remboursement du NET à l’expéditeur :
 *    - Avant : status=cancelled mais aucun remboursement.
 *    - Maintenant : refund du netAmount (frais conservés) + notifications.
 */

const axios = require('axios');
const config = require('../config');
const mongoose = require('mongoose');
const createError = require('http-errors');
const crypto = require('crypto');

const { getUsersConn, getTxConn } = require('../config/db');
const validationService = require('../services/validationService');

const usersConn = getUsersConn();
const txConn = getTxConn();

const User = require('../models/User')(usersConn);
const Notification = require('../models/Notification')(usersConn);
const Outbox = require('../models/Outbox')(usersConn);
const Transaction = require('../models/Transaction')(txConn);
const Balance = require('../models/Balance')(usersConn);

const logger = require('../utils/logger');
const { notifyTransactionViaGateway } = require('../services/notifyGateway');
const { convertAmount } = require('../tools/currency');
const generateTransactionRef = require('../utils/generateRef');

const PRINCIPAL_URL = config.principalUrl;
const GATEWAY_URL = config.gatewayUrl;

const INTERNAL_TOKEN =
  process.env.INTERNAL_TOKEN || config.internalToken || '';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Nettoie un texte simple (anti injection / caractères dangereux).
 * NB: ce n’est pas un sanitize HTML complet, juste une protection légère.
 */
const sanitize = (text) => String(text || '').replace(/[<>\\/{};]/g, '').trim();

const MAX_DESC_LENGTH = 500;

function isEmailLike(v) {
  const s = String(v || '').trim().toLowerCase();
  // Simple check (volontairement léger)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/**
 * Convertit proprement un nombre (string/Decimal128/number) en float.
 */
function toFloat(v, fallback = 0) {
  try {
    if (v === null || v === undefined) return fallback;
    // Decimal128 -> string -> parseFloat ok
    const n = parseFloat(String(v).replace(',', '.'));
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

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '').trim()).digest('hex');
}

function looksLikeSha256Hex(v) {
  return typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v);
}

/**
 * Sessions multi-conn :
 * - Si usersConn et txConn partagent le même client Mongo, on peut utiliser une transaction multi-DB.
 * - Sinon, on évite de passer un session incompatible aux modèles (sinon crash).
 */
function sameMongoClient(connA, connB) {
  try {
    const a = connA?.getClient?.();
    const b = connB?.getClient?.();
    return !!a && !!b && a === b;
  } catch {
    return false;
  }
}

const CAN_USE_SHARED_SESSION = sameMongoClient(usersConn, txConn);

async function startTxSession() {
  // On démarre la session depuis txConn (Transaction est sur txConn)
  if (typeof txConn?.startSession === 'function') {
    return txConn.startSession();
  }
  // fallback
  return mongoose.startSession();
}

function maybeSessionOpts(session) {
  return CAN_USE_SHARED_SESSION && session ? { session } : {};
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
    const sessOpts = maybeSessionOpts(session);

    // 1) Récupérer expéditeur et destinataire
    const [sender, receiver] = await Promise.all([
      User.findById(tx.sender)
        .select('email fullName pushTokens notificationSettings')
        .lean()
        .session(sessOpts.session || null)
        .catch(() => null),
      User.findById(tx.receiver)
        .select('email fullName pushTokens notificationSettings')
        .lean()
        .session(sessOpts.session || null)
        .catch(() => null),
    ]);

    if (!sender || !receiver) return;

    // 2) Liens + payloads
    const dateStr = new Date().toLocaleString('fr-FR');
    const token = tx.verificationToken ? String(tx.verificationToken) : '';
    const webLink = token
      ? `${PRINCIPAL_URL}/confirm/${tx._id}?token=${encodeURIComponent(token)}`
      : `${PRINCIPAL_URL}/confirm/${tx._id}`;
    const mobileLink = token
      ? `paynoval://confirm/${tx._id}?token=${encodeURIComponent(token)}`
      : `paynoval://confirm/${tx._id}`;

    const dataSender = {
      transactionId: tx._id.toString(),
      amount: tx.amount?.toString?.() ? tx.amount.toString() : String(tx.amount || ''),
      currency: senderCurrencySymbol,
      name: sender.fullName,
      senderEmail: sender.email,
      receiverEmail: tx.recipientEmail || receiver.email,
      date: dateStr,
      confirmLinkWeb: webLink,
      country: tx.country,
      securityQuestion: tx.securityQuestion,
    };

    // ✅ IMPORTANT : dataReceiver.amount = tx.localAmount (montant réellement crédité)
    const dataReceiver = {
      transactionId: tx._id.toString(),
      amount: tx.localAmount?.toString?.() ? tx.localAmount.toString() : String(tx.localAmount || ''),
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

    // 3) Settings notifications (fallback safe)
    const sSettings = sender.notificationSettings || {};
    const rSettings = receiver.notificationSettings || {};

    const {
      channels: { email: sEmailChan = true, push: sPushChan = true, inApp: sInAppChan = true } = {},
      types: { txSent: sTxSentType = true, txReceived: sTxReceivedType = true, txFailed: sTxFailedType = true } = {},
    } = sSettings;

    const {
      channels: { email: rEmailChan = true, push: rPushChan = true, inApp: rInAppChan = true } = {},
      types: { txSent: rTxSentType = true, txReceived: rTxReceivedType = true, txFailed: rTxFailedType = true } = {},
    } = rSettings;

    // 4) Type notif selon statut
    let sTypeKey;
    let rTypeKey;
    if (status === 'initiated' || status === 'confirmed') {
      sTypeKey = 'txSent';
      rTypeKey = 'txReceived';
    } else if (status === 'cancelled') {
      sTypeKey = 'txFailed';
      rTypeKey = 'txFailed';
    } else {
      sTypeKey = 'txSent';
      rTypeKey = 'txReceived';
    }

    const statusTextMap = {
      initiated: 'Transaction en attente',
      confirmed: 'Transaction confirmée',
      cancelled: 'Transaction annulée',
    };
    const statusText = statusTextMap[status] || `Transaction ${status}`;

    const messageForSender = `${statusText}\nMontant : ${dataSender.amount} ${dataSender.currency}`;
    const messageForReceiver = `${statusText}\nMontant : ${dataReceiver.amount} ${dataReceiver.currency}`;

    // 5) Push via principal /internal/notify
    async function triggerPush(userId, message) {
      try {
        await axios.post(
          `${PRINCIPAL_URL}/internal/notify`,
          { userId, message },
          {
            headers: {
              'Content-Type': 'application/json',
              ...(INTERNAL_TOKEN ? { 'x-internal-token': INTERNAL_TOKEN } : {}),
            },
            timeout: 8000,
          }
        );
      } catch (err) {
        logger?.warn?.(`Échec push pour user ${userId} : ${err?.message || err}`) ||
          console.warn(`Échec push pour user ${userId} : ${err?.message || err}`);
      }
    }

    // ------------------- Sender -------------------
    if (sPushChan && ((sTypeKey === 'txSent' && sTxSentType) || (sTypeKey === 'txFailed' && sTxFailedType))) {
      if (sender.pushTokens && sender.pushTokens.length) {
        await triggerPush(sender._id.toString(), messageForSender);
      }
    }

    if (sInAppChan && ((sTypeKey === 'txSent' && sTxSentType) || (sTypeKey === 'txFailed' && sTxFailedType))) {
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
        sessOpts
      );
    }

    // ------------------- Receiver -------------------
    if (rPushChan && ((rTypeKey === 'txReceived' && rTxReceivedType) || (rTypeKey === 'txFailed' && rTxFailedType))) {
      if (receiver.pushTokens && receiver.pushTokens.length) {
        await triggerPush(receiver._id.toString(), messageForReceiver);
      }
    }

    if (rInAppChan && ((rTypeKey === 'txReceived' && rTxReceivedType) || (rTypeKey === 'txFailed' && rTxFailedType))) {
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
        sessOpts
      );
    }

    // 6) Outbox (replay / async)
    const events = [sender, receiver].map((u) => ({
      service: 'notifications',
      event: `transaction_${status}`,
      payload: {
        userId: u._id.toString(),
        type: `transaction_${status}`,
        data: u._id.toString() === sender._id.toString() ? dataSender : dataReceiver,
      },
    }));

    await Outbox.insertMany(events, sessOpts);

    // 7) Emails via Gateway
    const shouldEmailSender =
      sEmailChan && ((sTypeKey === 'txSent' && sTxSentType) || (sTypeKey === 'txFailed' && sTxFailedType));

    const shouldEmailReceiver =
      rEmailChan && ((rTypeKey === 'txReceived' && rTxReceivedType) || (rTypeKey === 'txFailed' && rTxFailedType));

    if (shouldEmailSender || shouldEmailReceiver) {
      const payloadForGateway = {
        transaction: {
          id: tx._id.toString(),
          reference: tx.reference,
          amount: toFloat(tx.amount),
          currency: senderCurrencySymbol,
          dateIso: tx.createdAt?.toISOString?.() || new Date().toISOString(),
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

      notifyTransactionViaGateway(status, payloadForGateway).catch((err) => {
        logger?.error?.('[notifyParties] Erreur notif via Gateway:', err?.message || err) ||
          console.error('[notifyParties] Erreur notif via Gateway:', err?.message || err);
      });
    }
  } catch (err) {
    logger?.error?.('notifyParties : erreur lors de l’envoi des notifications', err) ||
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
    const userId = req.user.id;
    const skip = parseInt(req.query.skip, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);

    const query = { $or: [{ sender: userId }, { receiver: userId }] };

    const [txs, total] = await Promise.all([
      Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Transaction.countDocuments(query),
    ]);

    res.json({ success: true, count: txs.length, total, data: txs, skip, limit });
  } catch (err) {
    next(err);
  }
};

/* ------------------------------------------------------------------ */
/* GET BY ID                                                           */
/* ------------------------------------------------------------------ */

exports.getTransactionController = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const tx = await Transaction.findById(id).lean();
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction non trouvée' });

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

exports.initiateInternal = async (req, res, next) => {
  const session = await startTxSession();
  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

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

    const cleanEmail = String(toEmail || '').trim().toLowerCase();
    if (!cleanEmail || !isEmailLike(cleanEmail)) throw createError(400, 'Email du destinataire requis');

    if (!question || !securityCode) throw createError(400, 'Question et code de sécurité requis');
    if (!destination || !funds || !country) throw createError(400, 'Données de transaction incomplètes');
    if (description && description.length > MAX_DESC_LENGTH) throw createError(400, 'Description trop longue');

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) throw createError(401, 'Token manquant');

    const senderId = req.user.id;

    // validations (service)
    await validationService.validateTransactionAmount({ amount: amount });
    await validationService.detectBasicFraud({
      sender: senderId,
      receiver: cleanEmail,
      amount: amount,
      currency: senderCurrencySymbol,
    });

    const amt = toFloat(amount);
    if (!amt || Number.isNaN(amt) || amt <= 0) throw createError(400, 'Montant invalide');

    const sessOpts = maybeSessionOpts(session);

    // Sender + receiver
    const senderUser = await User.findById(senderId)
      .select('fullName email')
      .lean()
      .session(sessOpts.session || null);
    if (!senderUser) throw createError(403, 'Utilisateur invalide');

    const receiver = await User.findOne({ email: cleanEmail })
      .select('_id fullName email')
      .lean()
      .session(sessOpts.session || null);
    if (!receiver) throw createError(404, 'Destinataire introuvable');

    if (receiver._id.toString() === senderId) throw createError(400, 'Auto-transfert impossible');

    // Gateway base + simulate fees
    let gatewayBase = (GATEWAY_URL || process.env.GATEWAY_URL || 'https://api-gateway-8cgy.onrender.com').replace(
      /\/+$/,
      ''
    );
    if (!gatewayBase.endsWith('/api/v1')) gatewayBase = `${gatewayBase}/api/v1`;

    const feeUrl = `${gatewayBase}/fees/simulate`;
    const simulateParams = {
      provider: 'paynoval',
      amount: amt,
      fromCurrency: senderCurrencySymbol,
      toCurrency: localCurrencySymbol,
      country,
    };

    let feeData;
    try {
      const feeRes = await axios.get(feeUrl, {
        params: simulateParams,
        headers: {
          Authorization: authHeader,
          ...(INTERNAL_TOKEN ? { 'x-internal-token': INTERNAL_TOKEN } : {}),
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

    const fee = round2(toFloat(feeData.fees));
    const netAmount = round2(toFloat(feeData.netAfterFees));
    const feeId = feeData.feeId || null;
    const feeSnapshot = feeData;

    // ✅ Débit expéditeur atomique (solde >= amt)
    const debited = await Balance.findOneAndUpdate(
      { user: senderId, amount: { $gte: amt } },
      { $inc: { amount: -amt } },
      { new: true, ...sessOpts }
    );

    if (!debited) {
      throw createError(400, 'Solde insuffisant');
    }

    // Crédit admin sur fees (CAD)
    let adminFeeInCAD = 0;
    if (fee > 0) {
      const { converted } = await convertAmount(senderCurrencySymbol, 'CAD', fee);
      adminFeeInCAD = round2(converted);
    }

    const adminEmail = 'admin@paynoval.com';
    const adminUser = await User.findOne({ email: adminEmail }).select('_id').session(sessOpts.session || null);
    if (!adminUser) throw createError(500, 'Compte administrateur introuvable');

    if (adminFeeInCAD > 0) {
      await Balance.findOneAndUpdate(
        { user: adminUser._id },
        { $inc: { amount: adminFeeInCAD } },
        { new: true, upsert: true, ...sessOpts }
      );
    }

    // Conversion du NET vers devise destinataire (priorité snapshot gateway)
    let rateUsed = null;
    let convertedLocalNet = null;

    if (
      feeSnapshot &&
      feeSnapshot.convertedNetAfterFees !== undefined &&
      feeSnapshot.convertedNetAfterFees !== null
    ) {
      rateUsed = toFloat(feeSnapshot.exchangeRate, null);
      convertedLocalNet = round2(toFloat(feeSnapshot.convertedNetAfterFees));
    }

    if (!Number.isFinite(convertedLocalNet) || convertedLocalNet <= 0) {
      const { rate, converted } = await convertAmount(senderCurrencySymbol, localCurrencySymbol, netAmount);
      rateUsed = rate;
      convertedLocalNet = round2(converted);
    }

    if (!Number.isFinite(convertedLocalNet) || convertedLocalNet <= 0) {
      throw createError(500, 'Conversion devise échouée (montant local invalide)');
    }

    const decAmt = dec2(amt);
    const decFees = dec2(fee);
    const decNet = dec2(netAmount);
    const decLocal = dec2(convertedLocalNet);
    const decExchange = mongoose.Types.Decimal128.fromString(String(rateUsed || 1));

    const nameDest =
      recipientInfo.name && sanitize(recipientInfo.name) ? sanitize(recipientInfo.name) : receiver.fullName;

    const reference = await generateTransactionRef();

    // ✅ Stockage SHA-256 dans le champ existant securityCode (compatible anciens)
    const storedSecurityCode = sha256Hex(String(securityCode).replace(/[<>\\/{};]/g, '').trim());

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
          localAmount: decLocal, // ✅ montant réellement crédité
          localCurrencySymbol: sanitize(localCurrencySymbol),
          senderName: senderUser.fullName,
          senderEmail: senderUser.email,
          nameDestinataire: nameDest,
          recipientEmail: cleanEmail,
          country: sanitize(country),
          description: sanitize(description),
          securityQuestion: sanitize(question),
          securityCode: storedSecurityCode, // ✅ hashed
          destination: sanitize(destination),
          funds: sanitize(funds),
          status: 'pending',
          attemptCount: 0,
          lockedUntil: null,
        },
      ],
      sessOpts
    );

    await notifyParties(tx, 'initiated', session, senderCurrencySymbol);

    if (CAN_USE_SHARED_SESSION) {
      await session.commitTransaction();
    }
    session.endSession();

    return res.status(201).json({
      success: true,
      transactionId: tx._id.toString(),
      reference: tx.reference,
      adminFeeInCAD,
    });
  } catch (err) {
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    return next(err);
  }
};

/* ------------------------------------------------------------------ */
/* CONFIRM                                                             */
/* ------------------------------------------------------------------ */

exports.confirmController = async (req, res, next) => {
  const session = await startTxSession();
  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

    const { transactionId, securityCode } = req.body;
    if (!transactionId || !securityCode) throw createError(400, 'transactionId et securityCode sont requis');

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) throw createError(401, 'Token manquant');

    const sessOpts = maybeSessionOpts(session);

    // Charger la transaction
    const tx = await Transaction.findById(transactionId)
      .select([
        '+securityCode',
        '+amount',
        '+transactionFees',
        '+netAmount',
        '+senderCurrencySymbol',
        '+localCurrencySymbol',
        '+localAmount',
        '+receiver',
        '+sender',
        '+feeSnapshot',
        '+feeId',
        '+attemptCount',
        '+lastAttemptAt',
        '+lockedUntil',
        '+status',
      ])
      .session(sessOpts.session || null);

    if (!tx) throw createError(400, 'Transaction introuvable');

    validationService.validateTransactionStatusChange(tx.status, 'confirmed');
    if (tx.status !== 'pending') throw createError(400, 'Transaction déjà traitée ou annulée');

    const now = new Date();
    if (tx.lockedUntil && tx.lockedUntil > now) {
      throw createError(
        423,
        `Transaction temporairement bloquée, réessayez après ${tx.lockedUntil.toLocaleTimeString('fr-FR')}`
      );
    }

    // Seul destinataire
    if (String(tx.receiver) !== String(req.user.id)) throw createError(403, 'Vous n’êtes pas le destinataire de cette transaction');

    // Code check (compat legacy plain / new sha256)
    const sanitizedCode = String(securityCode).replace(/[<>\\/{};]/g, '').trim();
    const stored = String(tx.securityCode || '');

    const ok =
      looksLikeSha256Hex(stored) ? sha256Hex(sanitizedCode) === stored : sanitizedCode === stored;

    if (!ok) {
      tx.attemptCount = (tx.attemptCount || 0) + 1;
      tx.lastAttemptAt = now;

      // 3ème erreur => cancelled + lock + ✅ remboursement du NET à l’expéditeur
      if (tx.attemptCount >= 3) {
        tx.status = 'cancelled';
        tx.cancelledAt = now;
        tx.cancelReason = 'Code de sécurité erroné (trop d’essais)';
        tx.lockedUntil = new Date(now.getTime() + 15 * 60 * 1000);

        // ✅ Refund du netAmount (frais conservés)
        const refundNet = round2(toFloat(tx.netAmount, 0));
        if (refundNet > 0) {
          await Balance.findOneAndUpdate(
            { user: tx.sender },
            { $inc: { amount: refundNet } },
            { new: true, upsert: true, ...sessOpts }
          );
        }

        await tx.save(sessOpts);
        await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);

        throw createError(401, 'Code de sécurité incorrect. Nombre d’essais dépassé, transaction annulée.');
      }

      await tx.save(sessOpts);
      throw createError(401, `Code de sécurité incorrect. Il vous reste ${3 - tx.attemptCount} essai(s).`);
    }

    // Code OK => reset brute-force
    tx.attemptCount = 0;
    tx.lastAttemptAt = null;
    tx.lockedUntil = null;

    // Montant à créditer (priorité localAmount)
    const netBrut = toFloat(tx.netAmount);
    let creditAmount = null;

    if (tx.localAmount !== undefined && tx.localAmount !== null) {
      const v = toFloat(tx.localAmount, null);
      if (Number.isFinite(v) && v > 0) creditAmount = v;
    }

    if (!creditAmount || !Number.isFinite(creditAmount) || creditAmount <= 0) {
      const snap = tx.feeSnapshot || {};
      const snapLocal =
        snap.convertedNetAfterFees ?? snap.convertedNet ?? snap.convertedNetAfterFee ?? null;
      const v = toFloat(snapLocal, null);
      if (Number.isFinite(v) && v > 0) creditAmount = v;
    }

    if (!creditAmount || !Number.isFinite(creditAmount) || creditAmount <= 0) {
      if (String(tx.senderCurrencySymbol || '').trim() === String(tx.localCurrencySymbol || '').trim()) {
        creditAmount = netBrut;
      } else {
        const { converted } = await convertAmount(tx.senderCurrencySymbol, tx.localCurrencySymbol, netBrut);
        creditAmount = round2(converted);
      }
    }

    creditAmount = round2(creditAmount);
    if (!Number.isFinite(creditAmount) || creditAmount <= 0) throw createError(500, 'Montant à créditer invalide après conversion');

    // Créditer le destinataire
    const credited = await Balance.findOneAndUpdate(
      { user: tx.receiver },
      { $inc: { amount: creditAmount } },
      { new: true, upsert: true, ...sessOpts }
    );
    if (!credited) throw createError(500, 'Erreur lors du crédit au destinataire');

    // Finaliser tx
    tx.status = 'confirmed';
    tx.confirmedAt = now;

    // sécuriser localAmount
    if (!tx.localAmount || round2(toFloat(tx.localAmount)) !== creditAmount) {
      tx.localAmount = dec2(creditAmount);
    }

    await tx.save(sessOpts);

    await notifyParties(tx, 'confirmed', session, tx.senderCurrencySymbol);

    if (CAN_USE_SHARED_SESSION) {
      await session.commitTransaction();
    }
    session.endSession();

    return res.json({
      success: true,
      credited: creditAmount,
      currencyCredited: tx.localCurrencySymbol,
      feeId: tx.feeId,
      feeSnapshot: tx.feeSnapshot,
    });
  } catch (err) {
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    return next(err);
  }
};

/* ------------------------------------------------------------------ */
/* CANCEL                                                              */
/* ------------------------------------------------------------------ */

exports.cancelController = async (req, res, next) => {
  const session = await startTxSession();
  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

    const { transactionId, reason = 'Annulé' } = req.body;
    if (!transactionId) throw createError(400, 'transactionId requis pour annuler');

    const sessOpts = maybeSessionOpts(session);

    const tx = await Transaction.findById(transactionId)
      .select(['+netAmount', '+amount', '+senderCurrencySymbol', '+sender', '+receiver', '+status', '+funds'])
      .session(sessOpts.session || null);

    if (!tx) throw createError(400, 'Transaction introuvable');

    validationService.validateTransactionStatusChange(tx.status, 'cancelled');
    if (tx.status !== 'pending') throw createError(400, 'Transaction déjà traitée ou annulée');

    const userId = String(req.user.id);
    const senderId = String(tx.sender);
    const receiverId = String(tx.receiver);
    if (userId !== senderId && userId !== receiverId) throw createError(403, 'Vous n’êtes pas autorisé à annuler cette transaction');

    // Frais d’annulation via Gateway
    let cancellationFee = 0;
    let cancellationFeeType = 'fixed';
    let cancellationFeePercent = 0;
    let cancellationFeeId = null;

    try {
      let gatewayBase = (GATEWAY_URL || process.env.GATEWAY_URL || 'https://api-gateway-8cgy.onrender.com').replace(
        /\/+$/,
        ''
      );
      if (!gatewayBase.endsWith('/api/v1')) gatewayBase = `${gatewayBase}/api/v1`;

      const { data } = await axios.get(`${gatewayBase}/fees/simulate`, {
        params: {
          provider: tx.funds || 'paynoval',
          amount: String(tx.amount),
          fromCurrency: tx.senderCurrencySymbol,
          toCurrency: tx.senderCurrencySymbol,
          type: 'cancellation',
        },
        headers: {
          ...(INTERNAL_TOKEN ? { 'x-internal-token': INTERNAL_TOKEN } : {}),
          ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        },
        timeout: 8000,
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
      // fallback legacy
      const symbol = String(tx.senderCurrencySymbol || '').trim();
      if (['USD', '$USD', 'CAD', '$CAD', 'EUR', '€'].includes(symbol)) cancellationFee = 2.99;
      else if (['XOF', 'XAF', 'F CFA'].includes(symbol)) cancellationFee = 300;
    }

    cancellationFee = round2(cancellationFee);

    const netStored = toFloat(tx.netAmount);
    const refundAmt = round2(netStored - cancellationFee);
    if (refundAmt < 0) throw createError(400, 'Frais d’annulation supérieurs au montant net à rembourser');

    // Rembourse expéditeur
    const refunded = await Balance.findOneAndUpdate(
      { user: tx.sender },
      { $inc: { amount: refundAmt } },
      { new: true, upsert: true, ...sessOpts }
    );
    if (!refunded) throw createError(500, 'Erreur lors du remboursement au compte expéditeur');

    // Crédit admin sur frais d'annulation (CAD)
    const adminCurrency = 'CAD';
    let adminFeeConverted = 0;

    if (cancellationFee > 0) {
      const { converted } = await convertAmount(tx.senderCurrencySymbol, adminCurrency, cancellationFee);
      adminFeeConverted = round2(converted);
    }

    const adminEmail = 'admin@paynoval.com';
    const adminUser = await User.findOne({ email: adminEmail }).select('_id').session(sessOpts.session || null);
    if (!adminUser) throw createError(500, 'Compte administrateur introuvable');

    if (adminFeeConverted > 0) {
      await Balance.findOneAndUpdate(
        { user: adminUser._id },
        { $inc: { amount: adminFeeConverted } },
        { new: true, upsert: true, ...sessOpts }
      );
    }

    tx.status = 'cancelled';
    tx.cancelledAt = new Date();
    tx.cancelReason = `${userId === receiverId ? 'Annulé par le destinataire' : 'Annulé par l’expéditeur'} : ${sanitize(reason)}`;
    tx.cancellationFee = cancellationFee;
    tx.cancellationFeeType = cancellationFeeType;
    tx.cancellationFeePercent = cancellationFeePercent;
    tx.cancellationFeeId = cancellationFeeId;

    await tx.save(sessOpts);

    await notifyParties(tx, 'cancelled', session, tx.senderCurrencySymbol);

    if (CAN_USE_SHARED_SESSION) {
      await session.commitTransaction();
    }
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
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    return next(err);
  }
};

/* ------------------------------------------------------------------ */
/* REFUND (admin)                                                      */
/* ------------------------------------------------------------------ */

exports.refundController = async (req, res, next) => {
  const session = await startTxSession();
  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

    const { transactionId, reason = 'Remboursement demandé' } = req.body;

    const sessOpts = maybeSessionOpts(session);

    const tx = await Transaction.findById(transactionId).session(sessOpts.session || null);
    if (!tx || tx.status !== 'confirmed') throw createError(400, 'Transaction non remboursable');
    if (tx.refundedAt) throw createError(400, 'Déjà remboursée');

    const amt = toFloat(tx.localAmount);
    if (amt <= 0) throw createError(400, 'Montant de remboursement invalide');

    // Débiter destinataire atomiquement (solde >= amt)
    const debited = await Balance.findOneAndUpdate(
      { user: tx.receiver, amount: { $gte: amt } },
      { $inc: { amount: -amt } },
      { new: true, ...sessOpts }
    );

    if (!debited) throw createError(400, 'Solde du destinataire insuffisant');

    // Crédit expéditeur
    await Balance.findOneAndUpdate(
      { user: tx.sender },
      { $inc: { amount: amt } },
      { new: true, upsert: true, ...sessOpts }
    );

    tx.status = 'refunded';
    tx.refundedAt = new Date();
    tx.refundReason = reason;
    await tx.save(sessOpts);

    logger.warn(
      `[ALERTE REFUND] Remboursement manuel ! tx=${transactionId}, by=${req.user?.email || req.user?.id}, amount=${amt}`
    );

    if (CAN_USE_SHARED_SESSION) {
      await session.commitTransaction();
    }
    session.endSession();

    res.json({ success: true, refunded: amt });
  } catch (err) {
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    next(err);
  }
};

/* ------------------------------------------------------------------ */
/* VALIDATE (admin)                                                    */
/* ------------------------------------------------------------------ */

exports.validateController = async (req, res, next) => {
  try {
    const { transactionId, status, adminNote } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx || tx.status !== 'pending') throw createError(400, 'Transaction non validable');

    if (!['confirmed', 'rejected'].includes(status)) throw createError(400, 'Statut de validation invalide');

    // ⚠️ Note: cette action ne crédite/débite pas les balances.
    // Elle est laissée telle quelle (comportement existant conservé).
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

exports.reassignController = async (req, res, next) => {
  const session = await startTxSession();
  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

    const { transactionId, newReceiverEmail } = req.body;

    const sessOpts = maybeSessionOpts(session);

    const tx = await Transaction.findById(transactionId).session(sessOpts.session || null);
    if (!tx || !['pending', 'confirmed'].includes(tx.status)) throw createError(400, 'Transaction non réassignable');

    const cleanNewEmail = String(newReceiverEmail || '').trim().toLowerCase();
    if (!isEmailLike(cleanNewEmail)) throw createError(400, 'Email destinataire invalide');

    const newReceiver = await User.findOne({ email: cleanNewEmail })
      .select('_id fullName email')
      .session(sessOpts.session || null);

    if (!newReceiver) throw createError(404, 'Nouveau destinataire introuvable');

    if (String(newReceiver._id) === String(tx.receiver)) throw createError(400, 'Déjà affectée à ce destinataire');

    tx.receiver = newReceiver._id;
    tx.nameDestinataire = newReceiver.fullName;
    tx.recipientEmail = newReceiver.email;
    tx.reassignedAt = new Date();
    await tx.save(sessOpts);

    logger.warn(
      `ALERTE REASSIGN: tx=${transactionId} réassignée par ${req.user?.email || req.user?.id} à ${cleanNewEmail}`
    );

    if (CAN_USE_SHARED_SESSION) {
      await session.commitTransaction();
    }
    session.endSession();

    res.json({ success: true, newReceiver: { id: newReceiver._id, email: newReceiver.email } });
  } catch (err) {
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    next(err);
  }
};

/* ------------------------------------------------------------------ */
/* ARCHIVE (admin)                                                     */
/* ------------------------------------------------------------------ */

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

exports.relaunchController = async (req, res, next) => {
  try {
    const { transactionId } = req.body;

    const tx = await Transaction.findById(transactionId);
    if (!tx) throw createError(404, 'Transaction non trouvée');

    if (!['pending', 'cancelled'].includes(tx.status)) {
      throw createError(400, 'Seules les transactions en attente ou annulées peuvent être relancées');
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
