"use strict";

/**
 * Réglages de simulation d'un compte sandbox — base transactions.
 *
 * Un document par compte : l'issue des prochaines opérations prestataire, le
 * délai de confirmation, et le point de départ de l'historique affiché
 * (`historyStartsAt`, avancé par « réinitialiser la démo »). Le grand livre,
 * lui, n'est jamais effacé : la réinitialisation pose des contre-écritures
 * (invariant 4), elle ne réécrit rien.
 *
 * Ne contient AUCUNE donnée financière : le solde se lit au portefeuille, qui
 * est une projection du grand livre.
 */

const mongoose = require("mongoose");
const {
  OUTCOME_VALUES,
  SCOPE_VALUES,
  DELAY_BOUNDS,
} = require("../providers/sandbox/sandboxScenario");

const schema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },

    /** `next` : consommé par le prochain ordre, puis retour au défaut. */
    applyTo: {
      type: String,
      enum: SCOPE_VALUES,
      default: "all",
    },

    outcome: {
      type: String,
      enum: OUTCOME_VALUES,
      required: true,
    },

    confirmationDelaySeconds: {
      type: Number,
      required: true,
      min: DELAY_BOUNDS.min,
      max: DELAY_BOUNDS.max,
    },

    /**
     * État initial de la démo : la devise du compte et le solde auquel
     * « réinitialiser » le ramène. Posés au provisionnement.
     */
    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },

    initialBalance: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
    },

    /** Jeu de départ et sa contrepartie, rejoués à chaque réinitialisation. */
    dataset: { type: String, default: null },
    seedGeneration: { type: Number, default: 0 },
    counterpartyId: { type: mongoose.Schema.Types.ObjectId, default: null },
    ownerName: { type: String, trim: true, default: null },
    counterpartyName: { type: String, trim: true, default: null },

    /** Historique affiché à partir de cette date (réinitialisation). */
    historyStartsAt: {
      type: Date,
      default: null,
    },

    lastResetAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "sandbox_scenarios",
  }
);

schema.index({ userId: 1 }, { unique: true });

module.exports = (conn = mongoose) =>
  conn.models.SandboxScenario || conn.model("SandboxScenario", schema);
