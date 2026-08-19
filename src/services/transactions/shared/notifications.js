"use strict";

const crypto = require("crypto");

const {
  User,
  notifyTransactionViaGateway,
  logger,
  PRINCIPAL_URL,
  maybeSessionOpts,
  usersConn,
} = require("./runtime");

/**
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CES DEUX MODÈLES NE VIENNENT PAS DE `runtime`
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `runtime.Notification` et `runtime.Outbox` sont branchés sur la connexion
 * TRANSACTIONS — `api_transactions_paynoval`. Or :
 *
 *   - le worker qui livre les notifications vit dans le backend principal et
 *     lit `paynoval.outboxes` ;
 *   - l'application mobile lit `paynoval.notifications`.
 *
 * Écrire dans les collections du tx-core, c'est donc écrire dans un cul-de-sac :
 * l'ordre de livraison n'est jamais drainé, et la notification n'est jamais
 * affichée. `runtime` porte d'ailleurs cet avertissement en toutes lettres sur
 * `getOutboxModel()` — ce fichier l'ignorait.
 *
 * Mesuré avant correctif : `api_transactions_paynoval.notifications` et
 * `.outboxes` contenaient 0 document, quand `paynoval` en comptait 172 et 52.
 * Le seul appelant est `externalSettlementController` ; le piège était armé
 * sans avoir encore tiré.
 *
 * `transactionNotificationService` fait déjà le bon choix — on l'aligne.
 */
const Notification = require("../../../models/Notification")(usersConn);
const Outbox = require("../../../models/Outbox")(usersConn);

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