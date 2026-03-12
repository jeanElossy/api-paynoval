"use strict";

const crypto = require("crypto");

const {
  User,
  Notification,
  Outbox,
  logger,
  maybeSessionOpts,
} = require("./shared/runtime");


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

function buildTxDateIso(tx) {
  return (
    tx?.createdAt?.toISOString?.() ||
    tx?.updatedAt?.toISOString?.() ||
    new Date().toISOString()
  );
}

function buildSenderCurrency(tx, senderCurrencySymbol) {
  return pickCurrency(
    senderCurrencySymbol,
    tx?.senderCurrencySymbol,
    tx?.senderCurrencyCode,
    tx?.currency,
    tx?.fromCurrency
  );
}

function buildReceiverCurrency(tx, senderCurrency) {
  return pickCurrency(
    tx?.localCurrencySymbol,
    tx?.localCurrencyCode,
    tx?.receiverCurrency,
    tx?.destinationCurrency,
    tx?.toCurrency,
    senderCurrency
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

function formatAmount(amount, currency) {
  return `${toFloat(amount, 0)} ${pickCurrency(currency)}`;
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

function buildNotificationData(tx, status, amount, currency, sender, receiver) {
  return {
    transactionId: tx?._id?.toString?.() || "",
    reference: tx?.reference || "",
    status,
    amount,
    currency,
    senderId: sender?._id?.toString?.() || "",
    receiverId: receiver?._id?.toString?.() || "",
    senderEmail: sender?.email || "",
    receiverEmail: receiver?.email || "",
    senderName: sender?.fullName || sender?.email || "",
    receiverName: receiver?.fullName || receiver?.email || "",
    dateIso: buildTxDateIso(tx),
    flow: tx?.flow || tx?.txType || "PAYNOVAL_INTERNAL_TRANSFER",
    reason: tx?.cancelReason || tx?.reason || "",
  };
}

function buildOutboxIdempotencyKey(txId, userId, status, channel) {
  return crypto
    .createHash("sha256")
    .update(`${txId}:${userId}:${status}:${channel}`)
    .digest("hex");
}

async function enqueueUserNotification({
  tx,
  status,
  recipientId,
  title,
  message,
  type,
  data,
  channels = ["push"],
  session,
}) {
  const sessOpts = maybeSessionOpts(session);

  await Notification.create(
    [
      {
        recipient: recipientId,
        type,
        title,
        message,
        data,
        read: false,
        date: new Date(),
        channels: ["in_app", ...channels],
      },
    ],
    sessOpts
  );

  const txId = tx?._id?.toString?.() || "";
  const recipient = String(recipientId || "");

  const outboxDocs = channels.map((channel) => ({
    service: "notifications",
    event: "notification.deliver",
    aggregateType: "transaction",
    aggregateId: txId,
    status: "pending",
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
        role:
          String(recipient) === String(tx?.sender || "")
            ? "sender"
            : "receiver",
        category: "transaction",
      },
    },
    idempotencyKey: buildOutboxIdempotencyKey(txId, recipient, status, channel),
    availableAt: new Date(),
  }));

  if (outboxDocs.length) {
    await Outbox.insertMany(outboxDocs, sessOpts);
  }
}

async function notifyTransactionEvent(tx, status, session, senderCurrencySymbol) {
  try {
    const sessOpts = maybeSessionOpts(session);

    const [sender, receiver] = await Promise.all([
      User.findById(tx.sender)
        .select("email fullName wantsEmail notificationPreferences")
        .lean()
        .session(sessOpts.session || null),

      User.findById(tx.receiver)
        .select("email fullName wantsEmail notificationPreferences")
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
      receiver
    );

    const receiverData = buildNotificationData(
      tx,
      status,
      receiverAmount,
      receiverCurrency,
      sender,
      receiver
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
      session,
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
      session,
    });
  } catch (err) {
    logger?.error?.(
      { err: err?.message || err, txId: tx?._id?.toString?.() || null, status },
      "[transactionNotificationService] notifyTransactionEvent failed"
    );
  }
}

module.exports = {
  notifyTransactionEvent,
};