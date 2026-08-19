"use strict";

const crypto = require("crypto");

const {
  User,
  Notification,
  NotificationOutbox: Outbox,
  notifyTransactionViaGateway,
  logger,
  PRINCIPAL_URL,
  maybeSessionOpts,
} = require("./runtime");

/**
 * `Notification` et `NotificationOutbox` viennent de `runtime`, et pointent
 * tous deux sur la base USERS — c'est là que le mobile lit ses notifications
 * et que le worker du backend principal draine la file.
 *
 * Ce fichier prenait auparavant `Outbox` de `runtime`, un nom qui désignait
 * alors la file du PARRAINAGE, dans la base transactions. Les notifications
 * des règlements externes y partaient donc sans lecteur : jamais délivrées,
 * jamais signalées. `runtime.Outbox` lève désormais une erreur explicite pour
 * que personne n'y retombe.
 */

/**
 * Même construction de clé que `transactionNotificationService`, et pour la
 * même raison : ce corps est REJOUABLE. Sans clé, un rejeu sur conflit
 * d'écriture notifierait l'utilisateur deux fois du même règlement. L'index
 * unique partiel de `paynoval.outboxes` fait le reste.
 */
function buildOutboxIdempotencyKey(txId, userId, status) {
  return crypto
    .createHash("sha256")
    .update(`settlement:${txId}:${userId}:${status}`)
    .digest("hex");
}

const { toFloat, pickCurrency } = require("./helpers");

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
      tx?.receivedAmount,
    0
  );
}

function getEmailPreference(userLike) {
  return userLike?.notificationPreferences?.email ?? userLike?.wantsEmail ?? true;
}

async function notifyParties(tx, status, session, senderCurrencySymbol) {
  try {
    const sessOpts = maybeSessionOpts(session);

    let sender = null;
    let receiver = null;

    try {
      sender = await User.findById(tx.sender)
        .select("email fullName wantsEmail notificationPreferences")
        .lean()
        .session(sessOpts.session || null);
    } catch (err) {
      logger?.warn?.("[notifyParties] sender fetch failed", err?.message || err);
    }

    try {
      receiver = await User.findById(tx.receiver)
        .select("email fullName wantsEmail notificationPreferences")
        .lean()
        .session(sessOpts.session || null);
    } catch (err) {
      logger?.warn?.("[notifyParties] receiver fetch failed", err?.message || err);
    }

    if (!sender || !receiver) {
      logger?.warn?.("[notifyParties] sender or receiver missing", {
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

    const receiverEmail = tx?.recipientEmail || receiver.email;
    const senderWantsEmail = getEmailPreference(sender);
    const receiverWantsEmail = getEmailPreference(receiver);

    const dataSender = {
      transactionId: tx._id.toString(),
      amount: senderAmount,
      currency: senderCurrency,
      senderEmail: sender.email,
      receiverEmail,
      reference: tx.reference,
      status,
    };

    const dataReceiver = {
      transactionId: tx._id.toString(),
      amount: receiverAmount,
      currency: receiverCurrency,
      senderEmail: sender.email,
      receiverEmail,
      reference: tx.reference,
      status,
    };

    await Notification.create(
      [
        {
          recipient: sender._id.toString(),
          type: `transaction_${status}`,
          data: dataSender,
          read: false,
          date: new Date(),
        },
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

    await Outbox.insertMany(
      [
        {
          service: "notifications",
          event: `transaction_${status}`,
          payload: { userId: sender._id.toString(), data: dataSender },
          idempotencyKey: buildOutboxIdempotencyKey(
            tx._id.toString(),
            sender._id.toString(),
            status
          ),
        },
        {
          service: "notifications",
          event: `transaction_${status}`,
          payload: { userId: receiver._id.toString(), data: dataReceiver },
          idempotencyKey: buildOutboxIdempotencyKey(
            tx._id.toString(),
            receiver._id.toString(),
            status
          ),
        },
      ],
      { ordered: false, ...sessOpts }
    );

    notifyTransactionViaGateway(status, {
      transaction: {
        id: tx._id.toString(),
        reference: tx.reference,
        amount: senderAmount,
        currency: senderCurrency,
        dateIso: buildTxDateIso(tx),
      },
      sender: {
        email: sender.email,
        name: sender.fullName || sender.email,
        wantsEmail: senderWantsEmail,
      },
      receiver: {
        email: receiverEmail,
        name: tx.nameDestinataire || receiver.fullName || receiver.email,
        wantsEmail: receiverWantsEmail,
      },
      links: {
        sender: `${PRINCIPAL_URL}/transactions/${tx._id}`,
        receiverConfirm: `${PRINCIPAL_URL}/confirm/${tx._id}`,
      },
    }).catch((err) => {
      logger?.error?.("[notifyParties] gateway notify error", err?.message || err);
    });
  } catch (err) {
    logger?.error?.("[notifyParties] error", err?.message || err);
  }
}

module.exports = {
  notifyParties,
};