"use strict";

const crypto = require("crypto");

const runtime = require("./runtime");
/**
 * `notifyTransactionViaGateway` a été retiré de cette destructuration le
 * 2026-09-09 : `runtime` ne l'expose pas, il valait `undefined`, et son seul
 * appelant a été supprimé (voir le bloc commenté dans `notifyParties`).
 */
const { logger, maybeSessionOpts } = runtime;

/**
 * Modèles liés PARESSEUSEMENT : chaque accès de propriété va chercher le
 * modèle au moment de l'usage. Les déstructurer directement résolvait la
 * connexion Mongo au chargement du fichier, ce qui rendait ce module
 * impossible à charger hors d'un serveur démarré.
 */
const { User, Notification, NotificationOutbox: Outbox } = runtime.lazyModels([
  "User",
  "Notification",
  "NotificationOutbox",
]);

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
          // 2 = HIGH. Voir le commentaire du champ `priority` dans
          // `models/Outbox.js` : sans lui, ces envois passaient devant les
          // alertes de sécurité.
          priority: 2,
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
          priority: 2,
          idempotencyKey: buildOutboxIdempotencyKey(
            tx._id.toString(),
            receiver._id.toString(),
            status
          ),
        },
      ],
      { ordered: false, ...sessOpts }
    );

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * IL Y AVAIT ICI UN SECOND CANAL DE NOTIFICATION — RETIRÉ LE 2026-09-09
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Un appel direct `notifyTransactionViaGateway(status, {...}).catch(...)`
     * suivait l'écriture d'outbox ci-dessus. Il était cassé DEPUIS TOUJOURS, et
     * de la façon la plus discrète qui soit :
     *
     *   • `notifyTransactionViaGateway` était déstructuré de `runtime`, qui ne
     *     l'expose pas. Il valait donc `undefined` ;
     *   • l'appeler levait un `TypeError` **synchrone** — avant que la promesse
     *     n'existe. Le `.catch()` écrit pour ce cas était **inatteignable** ;
     *   • le `TypeError` remontait au `catch` général ci-dessous, qui
     *     journalisait `[notifyParties] error` — le message générique, jamais
     *     le message spécifique. Rien, dans les journaux, ne désignait ce bloc.
     *
     * Il n'a pas été réparé, il a été RETIRÉ, pour deux raisons :
     *
     *   1. **La notification est déjà durable.** L'`insertMany` ci-dessus écrit
     *      un événement d'outbox porteur d'une clé d'idempotence, dans la MÊME
     *      transaction que le fait métier. Un worker le draine. C'est le motif
     *      « transactional outbox » — un seul canal, rejouable, dédoublonné.
     *   2. **Cet appel était un envoi réseau À L'INTÉRIEUR d'une transaction
     *      Mongo** (`notifyParties` est appelée depuis le bloc transactionnel
     *      de `externalSettlementController`). Le réparer sans le déplacer
     *      aurait armé un défaut pire que celui qu'il corrigeait : une
     *      transaction annulée après l'envoi aurait notifié un client d'un
     *      règlement qui n'a pas eu lieu, sans clé d'idempotence pour rattraper.
     *
     * ⚠️ NE PAS LE RÉINTRODUIRE. Deux canaux pour un même message, c'est un
     * double envoi le jour où le premier remarche.
     */
  } catch (err) {
    logger?.error?.("[notifyParties] error", err?.message || err);
  }
}

module.exports = {
  notifyParties,
};