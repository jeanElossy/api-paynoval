"use strict";

const mongoose = require("mongoose");

/**
 * ============================================================================
 * INTENTION D'ENCAISSEMENT — L'ARGENT QUI ENTRE
 * ============================================================================
 *
 * ── Ce que ce modèle corrige ────────────────────────────────────────────────
 *
 * Les cinq adaptateurs prestataires exposent `collect()` depuis leur écriture.
 * **Aucun appelant n'existait dans tout le dépôt.** La capacité d'encaisser
 * était entièrement écrite, entièrement testée par ses propres tests unitaires,
 * et entièrement morte : rien ne pouvait faire entrer un franc.
 *
 * C'est pour cette raison que la participation à une cagnotte par lien public
 * ne marchait pas de bout en bout. Le diagnostic apparent — « la passerelle
 * vise un chemin fermé en 410 » — n'était que le symptôme le plus visible. Même
 * en corrigeant l'URL, il n'y avait rien à atteindre.
 *
 * ── Pourquoi une INTENTION, et pas une Transaction ──────────────────────────
 *
 * `Transaction` décrit un mouvement SORTANT : un utilisateur PayNoval envoie de
 * l'argent. Sa machine à états, ses drapeaux monétaires et ses réservations de
 * fonds supposent tous un expéditeur qui a un portefeuille chez nous.
 *
 * Ici, l'expéditeur n'a pas de compte. Il n'y a rien à réserver, rien à
 * débiter, aucune machine à états de transfert à traverser. Ce qu'on suit,
 * c'est une DEMANDE faite à un prestataire de prélever chez un tiers — ce que
 * Stripe appelle un PaymentIntent et Adyen une payment session.
 *
 * Plier l'un dans l'autre aurait obligé à rendre facultatif tout ce qui protège
 * aujourd'hui le chemin sortant, pour tous ses documents et pas seulement les
 * nouveaux. C'est le raisonnement qui a déjà produit
 * `CagnotteExternalSettlement` à côté de `CagnotteSettlement`.
 *
 * ── ⚠️ UNE INTENTION N'EST PAS DE L'ARGENT ──────────────────────────────────
 *
 * Créer ce document n'écrit RIEN au grand livre, et c'est l'invariant central.
 * L'argent n'existe qu'au moment où le prestataire CONFIRME l'avoir prélevé —
 * c'est-à-dire au rappel signé, pas à la réponse HTTP de l'initiation
 * (règle B.3 : une 200 ne vaut pas succès financier).
 *
 * La ledgerisation se fait donc ailleurs, à la confirmation, par
 * `postCagnotteExternalParticipationEntries`. Ce document ne porte que l'état
 * de la DEMANDE.
 *
 * ── Ce qu'on ne stocke pas ──────────────────────────────────────────────────
 *
 * Aucune donnée de carte, jamais — ni PAN, ni CVV, ni date d'expiration, même
 * chiffrés. Le numéro de téléphone du payeur mobile money est nécessaire pour
 * que le prestataire le prélève, mais il ne sert plus à rien ensuite : on n'en
 * conserve que les quatre derniers chiffres, de quoi répondre à un client qui
 * demande « c'est bien mon numéro ? » sans constituer un fichier de numéros
 * (règle B.4).
 */
module.exports = function buildCollectionIntentModel(conn) {
  if (!conn) {
    throw new Error(
      "CollectionIntent : connexion Mongoose requise (base transactions)."
    );
  }

  const modelName = "CollectionIntent";
  if (conn.models[modelName]) return conn.models[modelName];

  const schema = new mongoose.Schema(
    {
      /**
       * Référence PayNoval de l'encaissement. C'est elle qui DÉRIVE le `_id`
       * (`settlementObjectIdFromReference`), si bien qu'un rejeu entre en
       * collision sur la clé primaire avant même d'atteindre l'index unique.
       */
      reference: { type: String, required: true, unique: true, trim: true },

      idempotencyKey: { type: String, required: true, index: true, trim: true },

      /**
       * Table CLOSE. Le rail désigne le compte de compensation d'entrée
       * (`PROVIDER_INBOUND:<RAIL>`) auquel l'écriture sera rapprochée.
       */
      rail: {
        type: String,
        required: true,
        enum: ["mobilemoney", "card"],
        index: true,
      },

      provider: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        index: true,
      },

      amount: { type: Number, required: true, min: 0 },
      currency: {
        type: String,
        required: true,
        uppercase: true,
        trim: true,
        maxlength: 4,
      },

      /**
       * À quoi sert cet encaissement. Table CLOSE : c'est elle qui décide QUI
       * est prévenu à la confirmation. Un motif inconnu n'a pas de destinataire
       * — l'argent serait encaissé sans que personne ne l'apprenne.
       */
      purpose: {
        type: String,
        required: true,
        enum: ["cagnotte_participation"],
        index: true,
      },

      /** Cible métier. Aucune donnée personnelle ici. */
      target: {
        cagnotteId: { type: String, default: "", trim: true, index: true },
        cagnotteCode: { type: String, default: "", trim: true },
      },

      /**
       * ⚠️ QUATRE DERNIERS CHIFFRES SEULEMENT, et uniquement pour le mobile
       * money. Le numéro complet est transmis au prestataire puis oublié.
       */
      payerPhoneLast4: { type: String, default: "", trim: true, maxlength: 4 },

      /** Nom affiché du contributeur, tel qu'il l'a saisi. */
      payerDisplayName: { type: String, default: "", trim: true, maxlength: 120 },

      /**
       * ── Machine à états ────────────────────────────────────────────────────
       *
       *   created    → la demande existe, le prestataire n'a pas encore été appelé
       *   pending    → le prestataire l'a acceptée, il prélève
       *   succeeded  → le prestataire a CONFIRMÉ le prélèvement (rappel signé)
       *   failed     → le prestataire a refusé, ou l'appel a échoué
       *
       * `succeeded` est le SEUL état qui autorise une écriture au grand livre,
       * et il n'est atteignable que depuis un rappel dont la signature a été
       * vérifiée.
       */
      status: {
        type: String,
        required: true,
        enum: ["created", "pending", "succeeded", "failed"],
        default: "created",
        index: true,
      },

      /** Référence côté prestataire — clé de jointure du rapprochement. */
      providerReference: { type: String, default: "", trim: true },

      /** Statut brut rendu par le prestataire, pour le diagnostic. */
      providerStatus: { type: String, default: "", trim: true },

      /**
       * Dernier échec. Code et message NOMMÉS — jamais la réponse brute du
       * prestataire, qui porte les coordonnées du payeur (règle B.4).
       */
      lastErrorCode: { type: String, default: "", trim: true },
      lastErrorMessage: { type: String, default: "", trim: true, maxlength: 500 },

      /** Renseigné une fois le règlement écrit au grand livre. */
      settlementReference: { type: String, default: "", trim: true },
      settledAt: { type: Date, default: null },

      confirmedAt: { type: Date, default: null },

      requestId: { type: String, default: "", trim: true },
    },
    { timestamps: true, collection: "tx_collection_intents" }
  );

  schema.index({ purpose: 1, status: 1, createdAt: -1 });
  schema.index({ rail: 1, provider: 1, createdAt: -1 });
  schema.index({ "target.cagnotteId": 1, createdAt: -1 });

  /**
   * Index PARTIEL : `providerReference` reste vide tant que le prestataire n'en
   * a pas rendu, et indexer des milliers de chaînes vides ne sert à rien.
   *
   * ⚠️ Ne PAS ajouter `index: true` sur le champ : deux déclarations sur la même
   * clé, MongoDB n'en pose qu'une et l'échec de l'autre est silencieux —
   * d'autant plus qu'`autoIndex` est coupé. Verrouillé par
   * `test/schemaIndexCollisions.test.js`.
   */
  schema.index(
    { providerReference: 1 },
    {
      partialFilterExpression: {
        providerReference: { $type: "string", $gt: "" },
      },
    }
  );

  return conn.model(modelName, schema);
};
