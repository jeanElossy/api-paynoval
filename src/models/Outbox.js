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
       * créé (`autoIndex` est désactivé en production).
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