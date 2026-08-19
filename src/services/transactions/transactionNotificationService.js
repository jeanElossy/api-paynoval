"use strict";

const crypto = require("crypto");

const {
  User,
  logger,
  maybeSessionOpts,
  getUsersConnectionSafe,
} = require("./shared/runtime");

/**
 * Lecture des montants : logique pure, isolée dans `utils/txMoneyFields.js`
 * pour être testable sans connexion Mongo ni environnement complet. Voir ce
 * fichier pour la raison — contre-intuitive — pour laquelle `tx.amount` est le
 * TOTAL débité et non le montant envoyé.
 */
const {
  readMoneyField,
  buildSenderFee,
  buildSenderNet,
  buildSenderTotal,
} = require("../../utils/txMoneyFields");

const Notification = require("../../models/Notification")(getUsersConnectionSafe());
const Outbox = require("../../models/Outbox")(getUsersConnectionSafe());

function toFloat(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickCurrency(...values) {
  for (const value of values) {
    const s = String(value || "").trim().toUpperCase();
    if (s) return s;
  }
  return "XOF";
}

function normalizeCurrencyCode(code) {
  const upper = String(code || "").trim().toUpperCase();

  if (!upper) return "XOF";
  if (upper === "FCFA") return "XOF";
  if (upper === "$CAD") return "CAD";
  if (upper === "$USD") return "USD";

  return upper;
}

function buildCurrencySuffix(code) {
  const upper = normalizeCurrencyCode(code);

  if (upper === "XOF" || upper === "XAF" || upper === "CFA") return "F CFA";
  if (upper === "CAD") return "$CAD";
  if (upper === "USD") return "$USD";
  if (upper === "EUR") return "€";
  if (upper === "GBP") return "£GBP";

  return upper;
}

function isZeroDecimalCurrency(code) {
  const upper = normalizeCurrencyCode(code);
  return upper === "XOF" || upper === "XAF" || upper === "CFA";
}

function formatAmount(amount, currency) {
  const value = toFloat(amount, 0);
  const normalizedCurrency = normalizeCurrencyCode(pickCurrency(currency));

  const formattedNumber = value.toLocaleString("fr-FR", {
    minimumFractionDigits: isZeroDecimalCurrency(normalizedCurrency) ? 0 : 2,
    maximumFractionDigits: isZeroDecimalCurrency(normalizedCurrency) ? 0 : 2,
  });

  const suffix = buildCurrencySuffix(normalizedCurrency);
  return suffix ? `${formattedNumber} ${suffix}` : formattedNumber;
}

function buildTxDateIso(tx) {
  return (
    tx?.createdAt?.toISOString?.() ||
    tx?.updatedAt?.toISOString?.() ||
    new Date().toISOString()
  );
}

function buildSenderCurrency(tx, senderCurrencySymbol) {
  return normalizeCurrencyCode(
    pickCurrency(
      senderCurrencySymbol,
      tx?.senderCurrencySymbol,
      tx?.senderCurrencyCode,
      tx?.currency,
      tx?.fromCurrency
    )
  );
}

function buildReceiverCurrency(tx, senderCurrency) {
  return normalizeCurrencyCode(
    pickCurrency(
      tx?.localCurrencySymbol,
      tx?.localCurrencyCode,
      tx?.receiverCurrency,
      tx?.destinationCurrency,
      tx?.toCurrency,
      senderCurrency
    )
  );
}

function buildSenderAmount(tx) {
  return toFloat(
    tx?.amount ??
      tx?.grossAmount ??
      tx?.grossFrom ??
      tx?.sourceAmount,
    0
  );
}

function buildReceiverAmount(tx) {
  return toFloat(
    tx?.localAmount ??
      tx?.netTo ??
      tx?.destinationAmount ??
      tx?.receivedAmount ??
      tx?.amount,
    0
  );
}

function getEmailPreference(userLike) {
  return userLike?.notificationPreferences?.email ?? userLike?.wantsEmail ?? true;
}

function getPushPreference(userLike) {
  return userLike?.notificationPreferences?.push ?? true;
}

function buildMessages(status, ctx) {
  const {
    senderName,
    receiverName,
    senderAmount,
    receiverAmount,
    senderCurrency,
    receiverCurrency,
    reference,
  } = ctx;

  const senderPretty = formatAmount(senderAmount, senderCurrency);
  const receiverPretty = formatAmount(receiverAmount, receiverCurrency);

  if (status === "initiated") {
    return {
      sender: {
        type: "transaction_initiated",
        title: "Transfert initié",
        message: `Votre transfert de ${senderPretty} vers ${receiverName} a été initié. Référence: ${reference}.`,
      },
      receiver: {
        type: "transaction_initiated",
        title: "Transfert en attente",
        message: `Un transfert de ${receiverPretty} de ${senderName} vous attend. Référence: ${reference}.`,
      },
    };
  }

  if (status === "confirmed") {
    return {
      sender: {
        type: "transaction_confirmed",
        title: "Transfert confirmé",
        message: `Votre transfert de ${senderPretty} vers ${receiverName} a été confirmé. Référence: ${reference}.`,
      },
      receiver: {
        type: "transaction_confirmed",
        title: "Fonds reçus",
        message: `Vous avez reçu ${receiverPretty} de ${senderName}. Référence: ${reference}.`,
      },
    };
  }

  if (status === "cancelled") {
    return {
      sender: {
        type: "transaction_cancelled",
        title: "Transfert annulé",
        message: `Votre transfert de ${senderPretty} vers ${receiverName} a été annulé. Référence: ${reference}.`,
      },
      receiver: {
        type: "transaction_cancelled",
        title: "Transfert annulé",
        message: `Le transfert de ${senderName} vers vous a été annulé. Référence: ${reference}.`,
      },
    };
  }

  return {
    sender: {
      type: `transaction_${status}`,
      title: "Mise à jour transaction",
      message: `Votre transaction ${reference} a changé de statut: ${status}.`,
    },
    receiver: {
      type: `transaction_${status}`,
      title: "Mise à jour transaction",
      message: `La transaction ${reference} a changé de statut: ${status}.`,
    },
  };
}

function buildNotificationData(tx, status, amount, currency, sender, receiver, options = {}) {
  const normalizedCurrency = normalizeCurrencyCode(currency);

  /**
   * Les frais ne concernent que l'expéditeur : le destinataire reçoit un
   * montant net, aucun prélèvement n'est opéré sur lui. Lui envoyer une ligne
   * « Frais » — fût-elle à zéro — laisserait croire le contraire.
   */
  const isSender = options.role === "sender";
  const fee = isSender ? buildSenderFee(tx) : null;
  const net = isSender ? buildSenderNet(tx) : null;
  const total = isSender ? buildSenderTotal(tx) : null;

  return {
    transactionId: tx?._id?.toString?.() || "",
    reference: tx?.reference || "",
    status,

    /**
     * `amount` reste ce qu'il a toujours été pour ne casser aucun consommateur
     * (application mobile, push, back-office). Pour l'EXPÉDITEUR, l'e-mail
     * affiche `net` en « Montant » afin que Montant + Frais = Total soit vrai.
     */
    amount,
    net,
    fee,
    total,
    feeCurrency: normalizedCurrency,
    totalCurrency: normalizedCurrency,

    currency: normalizedCurrency,
    displayAmount: formatAmount(amount, normalizedCurrency),
    senderId: sender?._id?.toString?.() || "",
    receiverId: receiver?._id?.toString?.() || "",
    senderEmail: sender?.email || "",
    receiverEmail: receiver?.email || "",
    senderName: sender?.fullName || sender?.email || "",
    receiverName: receiver?.fullName || receiver?.email || "",
    dateIso: buildTxDateIso(tx),
    flow: tx?.flow || tx?.txType || "PAYNOVAL_INTERNAL_TRANSFER",

    /**
     * Langue et pays du DESTINATAIRE de l'e-mail — pas ceux de la transaction.
     * Sans eux, le backend principal ne peut ni traduire le message ni choisir
     * le bon numéro de support.
     */
    locale: options.locale || "",
    countryCode: options.countryCode || "",
    reason: tx?.cancelReason || tx?.reason || "",
  };
}

function buildOutboxIdempotencyKey(txId, userId, status, channel) {
  return crypto
    .createHash("sha256")
    .update(`${txId}:${userId}:${status}:${channel}`)
    .digest("hex");
}

/**
 * Écrit la notification et son ordre de livraison DANS LA TRANSACTION appelante.
 *
 * ⚠️ CORRECTIF. `sessOpts` était calculé par `notifyTransactionEvent` puis
 * jamais transmis : la notification et l'entrée d'Outbox étaient écrites HORS
 * transaction. Une transaction annulée après cet appel laissait donc
 * l'utilisateur prévenu d'un virement qui n'a jamais eu lieu — et l'ordre de
 * livraison partait quand même.
 *
 * C'est tout l'intérêt de l'Outbox transactionnel, celui qu'appliquent Stripe
 * et Wise : l'événement est écrit dans la MÊME transaction que le changement
 * d'état, et livré ensuite par un worker. Ou les deux existent, ou aucun.
 *
 * Ce n'était pas réparable avant le 2026-08-19 : `Notification` et `Outbox`
 * vivent sur la connexion Users tandis que la transaction naît côté
 * Transactions, et les deux connexions utilisaient deux `MongoClient`
 * distincts. Le client partagé rend la session valable sur les deux bases.
 */
async function enqueueUserNotification({
  tx,
  status,
  recipientId,
  title,
  message,
  type,
  data,
  channels = ["push"],
  sessOpts = {},
}) {
  const recipient = String(recipientId || "");
  const txId = tx?._id?.toString?.() || "";

  // Forme tableau : c'est la seule que `create()` accepte avec des options.
  await Notification.create(
    [
      {
        recipient,
        type,
        title,
        message,
        data,
        read: false,
        readAt: null,
        date: new Date(),
        channels: ["in_app", ...channels],
      },
    ],
    { ...sessOpts }
  );

  const outboxDocs = channels.map((channel) => ({
    service: "notifications",
    event: "notification.deliver",
    aggregateType: "transaction",
    aggregateId: txId,
    status: "pending",
    attempts: 0,
    maxAttempts: 8,
    payload: {
      userId: recipient,
      title,
      message,
      data,
      channels: [channel],
      meta: {
        type,
        status,
        txId,
        reference: tx?.reference || "",
        role: String(recipient) === String(tx?.sender || "") ? "sender" : "receiver",
        category: "transaction",
      },
    },
    idempotencyKey: buildOutboxIdempotencyKey(txId, recipient, status, channel),
    availableAt: new Date(),
    processedAt: null,
    lockedAt: null,
    lockedBy: "",
    lastError: "",
  }));

  if (outboxDocs.length) {
    await Outbox.insertMany(outboxDocs, { ordered: false, ...sessOpts });
  }
}

async function notifyTransactionEvent(tx, status, session, senderCurrencySymbol) {
  try {
    const sessOpts = maybeSessionOpts(session);

    const [sender, receiver] = await Promise.all([
      User.findById(tx.sender)
        .select("_id email fullName wantsEmail notificationPreferences preferences countryCode country")
        .lean()
        .session(sessOpts.session || null),

      User.findById(tx.receiver)
        .select("_id email fullName wantsEmail notificationPreferences preferences countryCode country")
        .lean()
        .session(sessOpts.session || null),
    ]);

    if (!sender || !receiver) {
      logger?.warn?.("[transactionNotificationService] sender or receiver missing", {
        txId: tx?._id?.toString?.() || null,
        hasSender: !!sender,
        hasReceiver: !!receiver,
      });
      return;
    }

    const senderCurrency = buildSenderCurrency(tx, senderCurrencySymbol);
    const receiverCurrency = buildReceiverCurrency(tx, senderCurrency);

    const senderAmount = buildSenderAmount(tx);
    const receiverAmount = buildReceiverAmount(tx);

    const messages = buildMessages(status, {
      senderName: sender.fullName || sender.email || "Expéditeur",
      receiverName: receiver.fullName || receiver.email || "Destinataire",
      senderAmount,
      receiverAmount,
      senderCurrency,
      receiverCurrency,
      reference: tx.reference || "",
    });

    const senderData = buildNotificationData(
      tx,
      status,
      senderAmount,
      senderCurrency,
      sender,
      receiver,
      {
        role: "sender",
        locale: sender.preferences?.language || "",
        countryCode: sender.countryCode || sender.country || "",
      }
    );

    const receiverData = buildNotificationData(
      tx,
      status,
      receiverAmount,
      receiverCurrency,
      sender,
      receiver,
      {
        role: "receiver",
        locale: receiver.preferences?.language || "",
        countryCode: receiver.countryCode || receiver.country || "",
      }
    );

    const senderChannels = [];
    const receiverChannels = [];

    if (getPushPreference(sender)) senderChannels.push("push");
    if (getPushPreference(receiver)) receiverChannels.push("push");
    if (getEmailPreference(sender)) senderChannels.push("email");
    if (getEmailPreference(receiver)) receiverChannels.push("email");

    await enqueueUserNotification({
      tx,
      status,
      recipientId: sender._id.toString(),
      title: messages.sender.title,
      message: messages.sender.message,
      type: messages.sender.type,
      data: senderData,
      channels: senderChannels,
      sessOpts,
    });

    await enqueueUserNotification({
      tx,
      status,
      recipientId: receiver._id.toString(),
      title: messages.receiver.title,
      message: messages.receiver.message,
      type: messages.receiver.type,
      data: receiverData,
      channels: receiverChannels,
      sessOpts,
    });

    logger?.info?.(
      {
        txId: tx?._id?.toString?.(),
        reference: tx?.reference || "",
        status,
        senderId: sender._id?.toString?.(),
        receiverId: receiver._id?.toString?.(),
        senderChannels,
        receiverChannels,
        targetDb: "users/main",
      },
      "[transactionNotificationService] notifications persisted to principal DB"
    );
  } catch (err) {
    logger?.error?.(
      { err: err?.message || err, txId: tx?._id?.toString?.() || null, status },
      "[transactionNotificationService] notifyTransactionEvent failed"
    );
  }
}

module.exports = {
  notifyTransactionEvent,

  // Exposé pour les tests d'intégration ; la lecture des montants, elle, se
  // teste directement sur `utils/txMoneyFields.js`.
  buildNotificationData,
};