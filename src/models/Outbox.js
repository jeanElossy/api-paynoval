"use strict";

const mongoose = require("mongoose");

const outboxSchema = new mongoose.Schema(
  {
    service: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    event: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    aggregateType: {
      type: String,
      trim: true,
      default: "transaction",
      index: true,
    },

    aggregateId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },

    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      default: {},
    },

    status: {
      type: String,
      enum: ["pending", "processing", "processed", "retry", "failed"],
      default: "pending",
      index: true,
    },

    /**
     * PRIORITÉ DE TRAITEMENT — le champ manquait, et son absence INVERSAIT la file.
     *
     * Cette collection (`outboxes`, base des utilisateurs) est écrite par DEUX
     * services avec DEUX schémas : celui-ci depuis Tx Core, et
     * `paynoval-backend/models/Outbox.js` depuis le backend. Le worker qui la
     * draine (`services/outboxPublisher.js`) trie par `{ priority: 1,
     * createdAt: 1 }`.
     *
     * Or en BSON, un champ ABSENT trie comme `null`, et `null` passe AVANT tout
     * nombre en ordre croissant. Les notifications écrites ici — sans
     * `priority` — se plaçaient donc systématiquement devant les alertes de
     * sécurité `CRITICAL` (priorité 0), alors que le code du backend promet
     * l'inverse en toutes lettres.
     *
     * Le barème est celui de `paynoval-backend/services/notifications/priority.js`
     * et doit le rester : 0 CRITICAL, 2 HIGH, 5 NORMAL, 8 BULK. Plus le nombre
     * est BAS, plus l'envoi passe devant.
     */
    priority: {
      type: Number,
      default: 5,
      min: 0,
      max: 9,
      required: true,
    },

    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },

    maxAttempts: {
      type: Number,
      default: 8,
      min: 1,
    },

    availableAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    processedAt: {
      type: Date,
      default: null,
    },

    lockedAt: {
      type: Date,
      default: null,
      index: true,
    },

    lockedBy: {
      type: String,
      trim: true,
      default: "",
    },

    lastError: {
      type: String,
      trim: true,
      default: "",
      maxlength: 4000,
    },

    idempotencyKey: {
      type: String,
      trim: true,
      default: "",
      /**
       * PAS de `index: true` ici.
       *
       * Il créait un SECOND index, `idempotencyKey_1`, simple et NON UNIQUE, à
       * côté de l'index unique partiel déclaré plus bas. Deux index sur la même
       * clé : l'un porte la garantie, l'autre ne porte rien — et c'est le
       * second qui existe en base aujourd'hui, le premier n'ayant jamais été
       * créé (`autoIndex` est coupé — `config/db.js:47` — pour TOUTES les
       * connexions du service, pas seulement en production).
       *
       * Le code, lui, s'appuie sur l'unicité : `referralEventOutbox` compte sur
       * un E11000 pour reconnaître un événement déjà en file. Sans l'index
       * unique, ce E11000 ne se produit jamais et le dédoublonnage est muet.
       */
    },
  },
  {
    timestamps: true,
  }
);

outboxSchema.index(
  { status: 1, service: 1, availableAt: 1, createdAt: 1 },
  { name: "outbox_dispatch_scan" }
);

outboxSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: "string", $gt: "" },
    },
    name: "uniq_outbox_idempotency_key",
  }
);

module.exports = (conn = mongoose) =>
  conn.models.Outbox || conn.model("Outbox", outboxSchema);