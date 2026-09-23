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
 * Traduction (statut, rôle) → type du catalogue de notifications.
 *
 * ⚠️ Ce module est une COPIE STRICTE de
 * `paynoval-backend/services/notifications/transactionTypes.js` — même md5.
 * Toute modification doit être portée dans les deux dépôts, dans le même
 * commit : une divergence ne lève aucune erreur, elle produit deux services qui
 * ne s'accordent plus sur le type d'une même transaction, donc deux préférences
 * différentes appliquées au même fait.
 */
const { resolveTransactionType } = require("../notifications/transactionTypes");

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

/**
 * Prénom d'affichage, pour la variable `{{firstName}}` des gabarits.
 *
 * Rend `""` plutôt qu'un repli du genre « Client » : les gabarits savent
 * absorber un prénom vide (« Bonjour, » au lieu de « Bonjour Jean, »), alors
 * qu'un faux prénom serait imprimé tel quel dans un e-mail de virement.
 */
function firstNameOf(userLike) {
  const full = String(userLike?.fullName || "").trim();

  if (full) return full.split(/\s+/)[0] || "";

  return "";
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

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * ⚠️ `getEmailPreference` ET `getPushPreference` ONT ÉTÉ RETIRÉES — ET IL FAUT
 *    SAVOIR POURQUOI, SINON ELLES REVIENDRONT.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Elles lisaient :
 *
 *     userLike?.notificationPreferences?.email ?? userLike?.wantsEmail ?? true
 *     userLike?.notificationPreferences?.push  ?? true
 *
 * **Ces deux champs n'existent dans aucun schéma.** Le backend principal stocke
 * les préférences dans `User.notificationSettings` — `{ channels: {email, push,
 * inApp}, types: {...} }`. Le code du backend le documente lui-même
 * (`services/referralBonusNotificationService.js`, en-tête de la projection).
 *
 * Les deux lectures retombaient donc TOUJOURS sur `?? true`. Mesuré : **chaque
 * notification de transaction partait en push ET en e-mail, quelles que soient
 * les préférences réelles de l'utilisateur.** Quelqu'un qui avait coupé le push
 * dans l'application en recevait un à chaque virement — l'inverse exact de
 * l'invariant du produit, sur le volume principal du système.
 *
 * Le défaut n'était pas la valeur par défaut, c'était **l'endroit de la
 * décision**. Tx-Core n'a pas à savoir ce qu'un utilisateur a coché : il ne
 * détient ni le schéma `User`, ni le catalogue des types, ni l'état des
 * appareils, ni les quotas. Réparer le nom du champ aurait donné une deuxième
 * implémentation des préférences, dans un dépôt qui ne peut pas la tenir à jour
 * — le motif de défaut que ce projet a déjà payé quatre fois (`eligibility.js`
 * en recense quatre exemplaires incompatibles avant sa création).
 *
 * Tx-Core annonce donc le FAIT (« ce transfert est confirmé, voici le type, le
 * montant et le destinataire »). Le backend décide des canaux, dans
 * `dispatchNotification` : catalogue → configuration admin → préférences →
 * disponibilité du canal → permission de l'appareil → quota.
 *
 * C'est la séparation que tiennent Stripe et Wise : le moteur de paiement émet
 * un événement, le service de notification décide qui reçoit quoi et par où.
 */

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

/**
 * Clé d'idempotence d'un (transaction, destinataire, statut).
 *
 * ⚠️ PLUS DE SUFFIXE DE CANAL, ET C'EST UN CORRECTIF.
 *
 * La version précédente incluait le canal (`…:${status}:${channel}`) parce
 * qu'elle publiait UN ÉVÉNEMENT PAR CANAL — c'était elle qui choisissait les
 * canaux. Elle ne les choisit plus : le backend décide, donc l'événement est
 * unique et la clé désigne le FAIT, pas sa livraison.
 *
 * C'est `enqueue.channelIdempotencyKey()`, côté backend, qui suffixe par canal
 * au moment de la mise en file (`<clé>:push`, `<clé>:email`). Laisser un suffixe
 * ici produirait `<hash>:push:push` : inoffensif pour la file, mais le journal
 * (`NotificationLog.idempotencyKey`) ne se raccrocherait plus à l'item — la
 * jointure casse en silence, exactement ce que l'en-tête d'`enqueue.js`
 * interdit.
 *
 * ⚠️ `scope` PRÉSERVE LA DÉDUPLICATION HISTORIQUE DES RÈGLEMENTS EXTERNES.
 * `shared/notifications.js` construisait ses clés sur `settlement:${txId}:…`.
 * En déléguant ici, il passe `scope: 'settlement'` : les clés gardent leur
 * préfixe, donc un rappel prestataire rejoué reste dédoublonné comme avant.
 * Sans ce paramètre, la même confirmation aurait pu partir une seconde fois.
 */
function buildOutboxIdempotencyKey(txId, userId, status, scope = "") {
  const prefix = scope ? `${scope}:` : "";

  return crypto
    .createHash("sha256")
    .update(`${prefix}${txId}:${userId}:${status}`)
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
  role,
  title,
  message,
  type,
  data,
  variables = {},
  scope = "",
  sessOpts = {},
}) {
  const recipient = String(recipientId || "");
  const txId = tx?._id?.toString?.() || "";

  if (!recipient) return;

  /**
   * Type du CATALOGUE, résolu ici et pas chez le consommateur.
   *
   * `transactionTypes.js` est dupliqué à l'identique dans les deux dépôts (voir
   * son en-tête). Le résoudre côté producteur a un avantage précis : un statut
   * non déclaré se signale **dans les journaux du service qui l'a introduit**,
   * au moment où il l'introduit — pas trois sauts plus loin, dans un autre
   * dépôt, où personne ne le relie au changement qui l'a causé.
   */
  const resolved = resolveTransactionType({ status, role });

  if (!resolved.matched) {
    logger?.warn?.(
      "[transactionNotificationService] statut non declare dans transactionTypes.js",
      {
        status: String(status || ""),
        role: String(role || ""),
        repli: resolved.type,
        txId,
        consequence:
          "la notification part avec un type approximatif ; declarer ce statut " +
          "dans transactionTypes.js (LES DEUX depots)",
      }
    );
  }

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
   * ⚠️ UN SEUL ÉVÉNEMENT PAR DESTINATAIRE — ET C'EST UN CHANGEMENT.
   *
   * La version précédente publiait UN ÉVÉNEMENT PAR CANAL, parce qu'elle
   * choisissait les canaux : la clé devait alors les distinguer, sinon un échec
   * e-mail aurait forcé à rejouer le push.
   *
   * Ce n'est plus Tx-Core qui choisit. Le backend décide des canaux d'après le
   * catalogue et les préférences, puis met **un item d'outbox par canal retenu**
   * avec sa propre clé suffixée (`<clé>:push`, `<clé>:email`). La séparation par
   * canal existe donc toujours, exactement où elle doit être : dans la file.
   *
   * Publier un événement par canal ici serait devenu faux : Tx-Core aurait
   * annoncé deux fois le même fait, et le backend aurait évalué deux fois les
   * mêmes préférences pour aboutir au même verdict.
   */
  const effectiveRole =
    role || (String(recipient) === String(tx?.sender || "") ? "sender" : "receiver");

  await publishDomainEvent(
    {
      name: "notification.requested.v1",
      aggregateId: txId || recipient,
      occurredAt: new Date(),
      payload: {
        recipient,

        /**
         * Le type du CATALOGUE. `legacyType` reste transmis à côté : c'est lui
         * que l'application mobile lit aujourd'hui pour choisir l'icône et la
         * couleur d'une notification in-app (`utils/notifications/
         * notificationUtils.js`). Le retirer d'un coup ferait afficher toutes
         * les notifications de transaction avec le style par défaut sur tous les
         * téléphones déjà déployés.
         */
        notificationType: resolved.type,
        legacyType: String(type || ""),

        title: String(title || ""),
        message: String(message || ""),

        /**
         * ⚠️ AUCUN CANAL DEMANDÉ, VOLONTAIREMENT.
         *
         * `channels` absent signifie « ceux du catalogue ». Envoyer une liste
         * ici la transformerait en RESTRICTION côté backend (il intersecte), et
         * Tx-Core se remettrait à décider — par une autre porte.
         */

        /**
         * 2 = HIGH dans `paynoval-backend/services/notifications/priority.js` :
         * « Transactions, cagnottes : l'utilisateur attend le message ».
         * Sans cette valeur, le champ était absent et triait AVANT les
         * alertes de sécurité `CRITICAL`.
         */
        priority: 2,

        idempotencyKey: buildOutboxIdempotencyKey(txId, recipient, status, scope),

        aggregateType: "transaction",
        aggregateId: txId,

        /** Valeurs des `{{variables}}` des gabarits. Liste blanche appliquée
         *  côté backend par `template.render()` : rien d'autre ne passe. */
        variables: variables && typeof variables === "object" ? variables : {},

        /**
         * ⚠️ `meta` AU PREMIER NIVEAU — CORRECTIF.
         *
         * Il était imbriqué dans `data.meta`, alors que la route interne lisait
         * `corps.meta`. Le champ arrivait donc toujours vide côté backend, et
         * `meta.category === 'transaction'` — la condition qui fait choisir le
         * gabarit e-mail transactionnel — n'était jamais vraie. **L'e-mail de
         * confirmation de virement partait avec le gabarit générique**, sans
         * tableau montant/frais/total et sans date au fuseau du destinataire.
         * Rien ne le signalait : l'e-mail partait, simplement mal habillé.
         *
         * Il reste AUSSI dans `data.meta` ci-dessous : les événements déjà
         * publiés le portent là, et le backend lit les deux emplacements.
         */
        meta: {
          type: resolved.type,
          legacyType: String(type || ""),
          status: String(status || ""),
          txId,
          reference: tx?.reference || "",
          role: effectiveRole,
          category: "transaction",
        },

        data: {
          ...(data && typeof data === "object" ? data : {}),
          meta: {
            type: resolved.type,
            legacyType: String(type || ""),
            status: String(status || ""),
            txId,
            reference: tx?.reference || "",
            role: effectiveRole,
            category: "transaction",
          },
        },
      },
    },
    sessOpts?.session || null
  );
}

/**
 * @param {object}  tx
 * @param {string}  status
 * @param {object}  session
 * @param {string}  senderCurrencySymbol
 * @param {object}  [options]
 * @param {string}  [options.scope]  préfixe de la clé d'idempotence. Vide pour
 *   les transferts internes ; `"settlement"` pour les règlements externes, dont
 *   `shared/notifications.js` délègue ici — c'est ce qui conserve la
 *   déduplication des clés déjà écrites par l'ancien chemin direct, et donc
 *   empêche un rappel prestataire rejoué de notifier une seconde fois.
 */
async function notifyTransactionEvent(
  tx,
  status,
  session,
  senderCurrencySymbol,
  options = {}
) {
  try {
    const sessOpts = maybeSessionOpts(session);
    const scope = String(options?.scope || "");

    const [sender, receiver] = await Promise.all([
      runtime.User.findById(tx.sender)
        .select("_id email fullName preferences countryCode country")
        .lean()
        .session(sessOpts.session || null),

      runtime.User.findById(tx.receiver)
        .select("_id email fullName preferences countryCode country")
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

    /**
     * ⚠️ PLUS AUCUN CALCUL DE CANAUX ICI.
     *
     * Ce bloc lisait `notificationPreferences` et `wantsEmail` — deux champs
     * qui n'existent dans aucun schéma — et retombait donc TOUJOURS sur
     * « push + e-mail autorisés ». Voir le long commentaire qui a remplacé
     * `getPushPreference` / `getEmailPreference` en tête de ce fichier.
     *
     * Les canaux sont désormais décidés par le backend, dans
     * `dispatchNotification` : catalogue → configuration admin → préférences de
     * l'utilisateur → disponibilité du canal → permission de l'appareil → quota.
     */
    const senderVariables = {
      firstName: firstNameOf(sender),
      amount: senderAmount,
      currency: senderCurrency,
      recipientName: receiver.fullName || receiver.email || "",
      transactionId: tx?._id?.toString?.() || "",
      reference: tx?.reference || "",
    };

    const receiverVariables = {
      firstName: firstNameOf(receiver),
      amount: receiverAmount,
      currency: receiverCurrency,
      senderName: sender.fullName || sender.email || "",
      transactionId: tx?._id?.toString?.() || "",
      reference: tx?.reference || "",
    };

    await enqueueUserNotification({
      tx,
      status,
      recipientId: sender._id.toString(),
      role: "sender",
      title: messages.sender.title,
      message: messages.sender.message,
      type: messages.sender.type,
      data: senderData,
      variables: senderVariables,
      scope,
      sessOpts,
    });

    await enqueueUserNotification({
      tx,
      status,
      recipientId: receiver._id.toString(),
      role: "receiver",
      title: messages.receiver.title,
      message: messages.receiver.message,
      type: messages.receiver.type,
      data: receiverData,
      variables: receiverVariables,
      scope,
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
        /**
         * Les canaux ne sont plus décidés ici, donc plus journalisés ici : les
         * inscrire serait affirmer une livraison qu'on ne décide plus. Le
         * verdict canal par canal est journalisé par le backend, dans
         * `NotificationLog`, avec le MOTIF de chaque refus.
         */
        notificationType: resolveTransactionType({ status, role: "sender" }).type,
        decidedBy: "principal/dispatchNotification",
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