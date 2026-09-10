"use strict";

const crypto = require("crypto");

const runtime = require("./shared/runtime");

/**
 * `logger` et `maybeSessionOpts` sont des fonctions :
 * les déstructurer ne déclenche aucune connexion. `User`, en revanche, est un
 * getter paresseux qui résout la base au premier accès — il est donc lu DANS
 * les fonctions, jamais ici.
 */
const { logger, maybeSessionOpts } = runtime;
const { publishDomainEvent } = require("../events/publisher");

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

/**
 * ⚠️ CE SERVICE NE RÉSOUT PLUS AUCUN MODÈLE DU BACKEND — 2026-09-10.
 *
 * Il détenait `Notification` et `Outbox`, résolus sur la connexion des
 * UTILISATEURS, et écrivait donc dans deux collections dont le backend
 * principal déclare les schémas, les index et la machine à états.
 *
 * Ces deux accesseurs ont disparu avec le passage au bus d'événements, et leur
 * ABSENCE est ce qui mesure le découplage : tant qu'ils étaient là, une écriture
 * directe pouvait revenir en une ligne. Verrouillé par
 * `test/notificationsOnBus.test.js`.
 *
 * Effet de bord bienvenu : ce fichier — et tout handler de transaction qui
 * l'importe — se charge désormais sans connexion Mongo.
 */

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

  if (!recipient) return;

  /**
   * ══════════════════════════════════════════════════════════════════════════
   * ⚠️ CETTE FONCTION N'ÉCRIT PLUS DANS LES COLLECTIONS DU BACKEND — 2026-09-10
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ── Ce qu'elle faisait ─────────────────────────────────────────────────────
   *
   *   · `notifications` → `Notification.create([...])`
   *   · `outboxes`      → `Outbox.insertMany([...])`
   *
   * Ces deux collections appartiennent au backend principal, qui en déclare les
   * schémas, les index et la machine à états. Tx-Core y écrivait avec SA propre
   * déclaration.
   *
   * C'est exactement la classe de défaut refermée sur `tx_wallet_balances`
   * (R-06) : deux services écrivant une même collection avec deux schémas. Là
   * -bas, un `Number` était stocké sous un champ relu comme `Decimal128` — un
   * écart de centimes invisible pendant des mois. Ici l'enjeu n'est pas
   * monétaire, mais le mécanisme est le même, et la divergence est garantie
   * dès la première évolution de schéma.
   *
   * Le symptôme le plus parlant, déjà rencontré : le champ `priority`, absent
   * du document écrit ici, triait en BSON comme `null` — donc AVANT les alertes
   * de sécurité `CRITICAL`. Une notification de virement passait devant une
   * alerte de sécurité, parce qu'un service écrivait sans connaître le tri de
   * l'autre.
   *
   * ── Ce qui la remplace ─────────────────────────────────────────────────────
   *
   * Un événement de domaine publié DANS LA MÊME SESSION. L'équivalence est
   * conservée à l'identique :
   *
   *     la transaction est confirmée  ⟺  la notification est demandée
   *
   * `services/notifications/notificationConsumer.js` le consomme et appelle
   * `POST /api/v1/internal/notifications/enqueue`. Le backend redevient le seul
   * écrivain de ses collections — et c'est lui qui crée la notification affichée
   * ET la met en file, avec SES règles de priorité et SES index.
   *
   * ── La clé d'idempotence n'a pas changé ────────────────────────────────────
   *
   * `buildOutboxIdempotencyKey(txId, recipient, status, channel)` reste la
   * source : le backend s'en sert pour `dedupeKey` et pour l'unicité de son
   * outbox. La changer ferait réapparaître les notifications déjà envoyées.
   *
   * ⚠️ UN ÉVÉNEMENT PAR CANAL, comme avant un document d'outbox par canal. Un
   * seul événement portant tous les canaux rendrait la clé d'idempotence
   * ambiguë : un échec sur le courriel forcerait à rejouer la poussée.
   */
  for (const channel of channels.length ? channels : ["push"]) {
    await publishDomainEvent(
      {
        name: "notification.requested.v1",
        aggregateId: txId || recipient,
        occurredAt: new Date(),
        payload: {
          recipient,
          notificationType: String(type || ""),
          title: String(title || ""),
          message: String(message || ""),
          channels: [channel],
          /**
           * 2 = HIGH dans `paynoval-backend/services/notifications/priority.js` :
           * « Transactions, cagnottes : l'utilisateur attend le message ».
           * Sans cette valeur, le champ était absent et triait AVANT les
           * alertes de sécurité `CRITICAL`.
           */
          priority: 2,
          idempotencyKey: buildOutboxIdempotencyKey(
            txId,
            recipient,
            status,
            channel
          ),
          aggregateId: txId,
          data: {
            ...(data && typeof data === "object" ? data : {}),
            meta: {
              type: String(type || ""),
              status: String(status || ""),
              txId,
              reference: tx?.reference || "",
              role:
                String(recipient) === String(tx?.sender || "")
                  ? "sender"
                  : "receiver",
              category: "transaction",
            },
          },
        },
      },
      sessOpts?.session || null
    );
  }
}

async function notifyTransactionEvent(tx, status, session, senderCurrencySymbol) {
  try {
    const sessOpts = maybeSessionOpts(session);

    const [sender, receiver] = await Promise.all([
      runtime.User.findById(tx.sender)
        .select("_id email fullName wantsEmail notificationPreferences preferences countryCode country")
        .lean()
        .session(sessOpts.session || null),

      runtime.User.findById(tx.receiver)
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

    /**
     * Ordre `(message, meta)` — celui de winston. L'appel inverse
     * `(objet, message)` produisait une ligne illisible, observée telle quelle
     * sur le banc le 2026-09-03 :
     *
     *   [object Object] {"0":"[","1":"t","2":"r","3":"a", … }
     *
     * Le message devenait `[object Object]` et la chaîne était éclatée
     * caractère par caractère dans les métadonnées. Une trace du chemin de
     * l'argent illisible ne vaut pas mieux qu'une trace absente.
     */
    logger?.info?.(
      "[transactionNotificationService] notifications persisted to principal DB",
      {
        txId: tx?._id?.toString?.(),
        reference: tx?.reference || "",
        status,
        senderId: sender._id?.toString?.(),
        receiverId: receiver._id?.toString?.(),
        senderChannels,
        receiverChannels,
        targetDb: "users/main",
      }
    );
  } catch (err) {
    /**
     * PERTE D'ÉVÉNEMENT ASSUMÉE — mais plus jamais muette.
     * ========================================================================
     *
     * On n'élève PAS l'erreur, et c'est délibéré : cette fonction est appelée
     * APRÈS le commit du mouvement d'argent. La faire échouer rendrait un 500
     * pour un virement acquis, ce qui pousserait le client à rejouer un
     * paiement déjà passé. Une notification perdue est moins grave qu'un
     * virement rejoué.
     *
     * Ce qui n'était PAS acceptable, jusqu'au 2026-09-03 : que la perte n'ait
     * aucun signal exploitable. Le §6 de `transaction-engine.md` annonce
     * « ou les deux existent, ou aucun » — l'atomicité porte sur l'écriture
     * conjointe notification+outbox, PAS sur le fait que l'appel ait lieu.
     * Quand ce bloc s'exécute, ni l'un ni l'autre n'existe, et le bénéficiaire
     * ne sera pas prévenu que son argent est arrivé.
     *
     * Le marqueur `OUTBOX_EVENT_LOST` est STABLE : c'est sur lui que se règle
     * une alerte. Ne pas le reformuler sans mettre à jour l'alerte.
     *
     * `logger?.error?.` reste en accès optionnel parce que `logger` vient de
     * `runtime` par un getter paresseux : il peut être absent si le module est
     * chargé avant la connexion. Le `console.error` de repli garantit qu'une
     * perte d'événement financier laisse une trace même dans ce cas — un
     * silence sur un silence serait le pire des deux.
     */
    const details = {
      marqueur: "OUTBOX_EVENT_LOST",
      err: err?.message || String(err),
      txId: tx?._id?.toString?.() || null,
      reference: tx?.reference || null,
      status,
      consequence:
        "notification ET événement d'outbox absents : le destinataire ne sera " +
        "pas prévenu, et aucun worker ne rattrapera l'envoi",
    };

    if (typeof logger?.error === "function") {
      logger.error("[transactionNotificationService] OUTBOX_EVENT_LOST", details);
    } else {
      // eslint-disable-next-line no-console
      console.error("[transactionNotificationService] OUTBOX_EVENT_LOST", details);
    }
  }
}

module.exports = {
  notifyTransactionEvent,

  // Exposé pour les tests d'intégration ; la lecture des montants, elle, se
  // teste directement sur `utils/txMoneyFields.js`.
  buildNotificationData,
};