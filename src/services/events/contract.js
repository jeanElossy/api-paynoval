"use strict";

/**
 * ============================================================================
 * LE CONTRAT D'ÉVÉNEMENT — CE QUI SORT DU MOTEUR, ET RIEN D'AUTRE
 * ============================================================================
 *
 * ── Pourquoi un contrat, et pas simplement le document ──────────────────────
 *
 * Publier `tx.toObject()` est la faute la plus courante de ce motif, et elle
 * coûte deux fois :
 *
 *   · elle DIFFUSE des données personnelles à tout consommateur présent et
 *     futur, y compris ceux qui n'en ont pas besoin (règle B.4) ;
 *   · elle lie chaque consommateur à la forme INTERNE du moteur : renommer un
 *     champ de `Transaction` casse alors des services qu'on n'a pas touchés,
 *     sans que rien ne l'ait annoncé.
 *
 * Un contrat explicite inverse les deux : ce qui sort est décidé ici, en un
 * seul endroit, et le moteur peut se réorganiser librement derrière.
 *
 * ── La version est dans le NOM ──────────────────────────────────────────────
 *
 * `transaction.initiated.v1`. Faire évoluer un événement, c'est publier
 * `.v2` À CÔTÉ de `.v1`, laisser les consommateurs migrer, puis cesser de
 * publier `.v1`. Un champ `version` séparé n'offre pas cela : il oblige chaque
 * consommateur à traiter toutes les versions dans le même gestionnaire.
 *
 * ── Ce que ce module NE fait pas ────────────────────────────────────────────
 *
 * Il ne connaît ni Mongo, ni Redis, ni Express. C'est de la logique pure, donc
 * testable sans configuration ni connexion — la propriété que toute la suite de
 * tests de ce dépôt préserve.
 */

/**
 * ⚠️ CHAMPS AUTORISÉS, PAS CHAMPS INTERDITS.
 *
 * Une liste d'interdits laisse passer tout ce qu'on n'a pas pensé à y mettre —
 * et un nouveau champ personnel ajouté à `Transaction` se retrouverait publié
 * sans que personne l'ait décidé. Une liste d'autorisés fait l'inverse : ce
 * qu'on n'a pas nommé ne sort pas.
 */
const CONTRATS = Object.freeze({
  "transaction.initiated.v1": Object.freeze({
    aggregateType: "transaction",
    champs: Object.freeze([
      "transactionId",
      "reference",
      "flow",
      "rail",
      "provider",
      "senderId",
      "receiverId",
      "amount",
      "currency",
      "amountDestination",
      "currencyDestination",
      "senderCountry",
      "receiverCountry",
      "initiatedAt",
    ]),
    requis: Object.freeze(["transactionId", "amount", "currency", "senderId"]),
  }),

  "transaction.confirmed.v1": Object.freeze({
    aggregateType: "transaction",
    champs: Object.freeze([
      "transactionId",
      "reference",
      "flow",
      "rail",
      "provider",
      "senderId",
      "receiverId",
      "amount",
      "currency",
      "confirmedAt",
    ]),
    requis: Object.freeze(["transactionId", "amount", "currency", "senderId"]),
  }),

  "transaction.cancelled.v1": Object.freeze({
    aggregateType: "transaction",
    champs: Object.freeze([
      "transactionId",
      "reference",
      "senderId",
      "amount",
      "currency",
      "reason",
      "cancelledAt",
    ]),
    requis: Object.freeze(["transactionId"]),
  }),

  "transaction.failed.v1": Object.freeze({
    aggregateType: "transaction",
    champs: Object.freeze([
      "transactionId",
      "reference",
      "senderId",
      "amount",
      "currency",
      "errorCode",
      "failedAt",
    ]),
    requis: Object.freeze(["transactionId"]),
  }),

  "collection.succeeded.v1": Object.freeze({
    aggregateType: "collection",
    champs: Object.freeze([
      "collectionId",
      "reference",
      "rail",
      "provider",
      "amount",
      "currency",
      "cagnotteId",
      /**
       * ⚠️ `payerPhoneLast4`, jamais le numéro. Le contributeur d'une cagnotte
       * publique n'a pas de compte : son numéro est la seule donnée
       * d'identification qu'on détienne, et elle n'a rien à faire sur un bus
       * que plusieurs consommateurs écoutent.
       */
      "payerPhoneLast4",
      "payerCountry",
      "succeededAt",
    ]),
    requis: Object.freeze(["collectionId", "amount", "currency"]),
  }),

  /**
   * ⚠️ CE QUE CETTE CHARGE UTILE NE CONTIENT PAS EST AUSSI IMPORTANT QUE CE
   * QU'ELLE CONTIENT.
   *
   * Ni montant, ni devise, ni bonus à verser. Le backend principal RÉÉVALUE le
   * filleul à partir de ses propres données ; cet événement dit seulement
   * « ce filleul a confirmé une activité, regarde ». C'est la traduction
   * concrète du zero-trust : même si le bus était détourné, l'attaquant ne
   * pourrait rien demander d'autre qu'une réévaluation — ce que le principal
   * fait de toute façon.
   *
   * Ajouter ici un champ `bonusAmount` transformerait un événement en ORDRE DE
   * PAIEMENT, et le bus en surface d'attaque monétaire. Ne pas le faire.
   */
  "referral.activity.confirmed.v1": Object.freeze({
    aggregateType: "transaction",
    champs: Object.freeze([
      "refereeId",
      "triggerTxId",
      "reference",
      "flow",
      "confirmedAt",
      "correlationId",
    ]),
    requis: Object.freeze(["refereeId", "triggerTxId"]),
  }),

  /**
   * Une transaction CONFIRMÉE vient d'être remboursée.
   *
   * Même règle que `referral.activity.confirmed.v1` : un fait, jamais un ordre.
   * Le principal relit l'activité à la source et décide s'il y a lieu de
   * reprendre un bonus — l'événement ne porte ni montant ni récompense.
   */
  "referral.activity.reversed.v1": Object.freeze({
    aggregateType: "transaction",
    champs: Object.freeze([
      "refereeId",
      "reversedTxId",
      "reference",
      "flow",
      "reversedAt",
      "correlationId",
    ]),
    requis: Object.freeze(["refereeId", "reversedTxId"]),
  }),

  /**
   * ⚠️ LE TEXTE DE LA NOTIFICATION TRANSITE, ET C'EST UN CHOIX ASSUMÉ.
   *
   * `title` et `message` sont rendus par Tx-Core, qui connaît le contexte de
   * la transaction (montant, devise, statut, rôle du destinataire). Les faire
   * calculer par le backend l'obligerait à relire la transaction — c'est-à-dire
   * à lire une collection de Tx-Core, soit exactement le couplage qu'on referme
   * dans l'autre sens.
   *
   * Ces textes sont destinés à l'utilisateur : ils ne portent ni identifiant de
   * document, ni numéro de téléphone, ni donnée de conformité. `recipient` est
   * un identifiant, jamais une adresse ni un numéro — le backend résout le
   * canal à partir du compte.
   */
  /**
   * ⚠️ QUATRE CHAMPS AJOUTÉS LE 2026-09-23 — ET LEUR OUBLI A COUPÉ TOUTES LES
   * NOTIFICATIONS DE TRANSACTION.
   *
   * `legacyType`, `aggregateType`, `variables` et `meta` ont été ajoutés à la
   * charge par `transactionNotificationService` (le backend choisit désormais
   * les canaux ; il lui faut le type du catalogue, les variables des gabarits
   * et la catégorie `transaction`). Le contrat, lui, n'avait pas été mis à jour.
   * `buildPayload` refusait donc CHAQUE événement (`EVENT_FIELD_UNDECLARED`), le
   * `catch` de l'appelant le journalisait en `OUTBOX_EVENT_LOST`, et aucune
   * transaction — initiée, confirmée ou annulée — ne notifiait plus personne.
   * Mesuré sur la base de dev : dernière demande de notification à 13:25,
   * aucune ensuite malgré cinq transactions.
   *
   * C'est ce refus qui est correct : il empêche un champ non relu de glisser
   * sur le bus. Le défaut était l'absence d'un test qui soumette la VRAIE
   * charge au VRAI contrat — voir `test/transactionNotificationContract.test.js`.
   *
   * `variables` et `meta` sont des objets : la liste `BANNIS` ne contrôle que
   * le premier niveau. Leur contenu est donc tenu par le producteur (noms
   * d'affichage, montants, référence, rôle — jamais d'adresse), et vérifié par
   * ce même test.
   */
  "notification.requested.v1": Object.freeze({
    aggregateType: "transaction",
    champs: Object.freeze([
      "recipient",
      "notificationType",
      "legacyType",
      "title",
      "message",
      "channels",
      "priority",
      "idempotencyKey",
      "aggregateType",
      "aggregateId",
      "variables",
      "meta",
      "data",
    ]),
    requis: Object.freeze(["recipient", "idempotencyKey"]),
  }),

  "compliance.case.opened.v1": Object.freeze({
    aggregateType: "compliance",
    champs: Object.freeze([
      "caseId",
      "code",
      "riskStatus",
      "subjectId",
      "aggregateType",
      "aggregateId",
      "detectedBy",
      "openedAt",
    ]),
    requis: Object.freeze(["caseId", "code"]),
  }),
});

/**
 * ⚠️ CHAMPS BANNIS DE TOUTE CHARGE UTILE, quel que soit le contrat.
 *
 * La liste d'autorisés ci-dessus suffirait si personne ne se trompait en
 * l'éditant. Ce second filet attrape l'erreur au moment où elle est commise :
 * ajouter `phoneNumber` à un contrat lève, au lieu de diffuser silencieusement.
 */
const BANNIS = Object.freeze([
  "password",
  "pan",
  "cardnumber",
  "card_number",
  "cvc",
  "cvv",
  "cvv2",
  "otp",
  "token",
  "jwt",
  "secret",
  "apikey",
  "api_key",
  "phonenumber",
  "phone",
  "email",
  "iban",
  "idnumber",
  "kyc",
  "raw",
  "body",
]);

class EventContractError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "EventContractError";
    this.code = code || "EVENT_CONTRACT_VIOLATION";
  }
}

function nomsConnus() {
  return Object.keys(CONTRATS);
}

/**
 * Valide et NORMALISE une charge utile contre son contrat.
 *
 * Rend une charge utile ne contenant QUE les champs autorisés et définis. Ce
 * n'est pas une politesse : c'est ce qui garantit qu'un appelant distrait ne
 * publie pas un objet entier en croyant publier trois champs.
 */
function buildPayload(name, entree = {}) {
  const contrat = CONTRATS[name];

  if (!contrat) {
    throw new EventContractError(
      `Événement inconnu : « ${name} ». Contrats déclarés : ${nomsConnus().join(", ")}.`,
      "EVENT_UNKNOWN"
    );
  }

  if (entree === null || typeof entree !== "object" || Array.isArray(entree)) {
    throw new EventContractError(
      `Charge utile de « ${name} » : un objet est attendu.`,
      "EVENT_PAYLOAD_INVALID"
    );
  }

  /**
   * Le filet anti-fuite s'applique à ce que l'APPELANT a fourni, pas seulement
   * à ce qui sortira : si quelqu'un passe `phoneNumber`, on veut le lui dire,
   * pas le retirer en silence. Un retrait silencieux ferait croire que le champ
   * est publié alors qu'il ne l'est pas — l'inverse du problème, aussi coûteux.
   */
  for (const cle of Object.keys(entree)) {
    const normalisee = cle.toLowerCase().replace(/[^a-z0-9]/g, "");

    if (BANNIS.includes(normalisee)) {
      throw new EventContractError(
        `Champ « ${cle} » interdit sur le bus : donnée sensible ou personnelle ` +
          "(règle B.4). Publier un identifiant, jamais la donnée elle-même.",
        "EVENT_FIELD_FORBIDDEN"
      );
    }
  }

  const inconnus = Object.keys(entree).filter(
    (cle) => !contrat.champs.includes(cle)
  );

  if (inconnus.length) {
    throw new EventContractError(
      `Champs hors contrat pour « ${name} » : ${inconnus.join(", ")}. ` +
        "Les ajouter au contrat si le besoin est réel — jamais les glisser.",
      "EVENT_FIELD_UNDECLARED"
    );
  }

  const sortie = {};

  for (const champ of contrat.champs) {
    if (entree[champ] !== undefined) sortie[champ] = entree[champ];
  }

  const manquants = contrat.requis.filter(
    (champ) => sortie[champ] === undefined || sortie[champ] === null || sortie[champ] === ""
  );

  if (manquants.length) {
    throw new EventContractError(
      `Champs requis manquants pour « ${name} » : ${manquants.join(", ")}.`,
      "EVENT_FIELD_MISSING"
    );
  }

  return sortie;
}

function aggregateTypeOf(name) {
  const contrat = CONTRATS[name];

  if (!contrat) {
    throw new EventContractError(
      `Événement inconnu : « ${name} ».`,
      "EVENT_UNKNOWN"
    );
  }

  return contrat.aggregateType;
}

module.exports = {
  CONTRATS,
  BANNIS,
  EventContractError,
  nomsConnus,
  buildPayload,
  aggregateTypeOf,
};
