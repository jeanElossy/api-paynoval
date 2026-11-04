"use strict";

/**
 * Réclamation d'un transfert par son destinataire — base transactions
 * (2026-11-04, `services/transferClaims/`).
 *
 * Un document par transfert vers un portefeuille mobile money ou une carte.
 * Il ne porte AUCUN montant : l'argent se lit sur la transaction et au grand
 * livre. Il porte ce qui prouve que la bonne personne réclame :
 *
 *   - l'EMPREINTE du jeton du lien (jamais le jeton) ;
 *   - le numéro du destinataire, illisible par défaut (`select: false`) ;
 *   - l'EMPREINTE du code SMS en cours (jamais le code), son expiration ;
 *   - les essais manqués, qui bloquent le lien à `MAX_FAILED_ATTEMPTS`.
 *
 * Rien n'est effacé : un lien utilisé, refusé ou bloqué reste en base comme
 * trace (invariant 4). Le statut ne fait qu'avancer.
 */

const mongoose = require("mongoose");
const { MODE_VALUES } = require("../utils/accountMode");
const { CLAIM_STATUSES, MAX_FAILED_ATTEMPTS } = require("../services/transferClaims/claimRules");

const schema = new mongoose.Schema(
  {
    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },

    /** Mode de la transaction : une réclamation ne change jamais de monde. */
    mode: { type: String, enum: MODE_VALUES, required: true, immutable: true },

    sender: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },

    tokenHash: { type: String, required: true },

    recipientPhoneE164: { type: String, required: true, select: false, immutable: true },
    recipientPhoneLast4: { type: String, default: "" },

    status: {
      type: String,
      enum: Object.values(CLAIM_STATUSES),
      default: CLAIM_STATUSES.OPEN,
    },

    /** Expire avec la transaction (`autoCancelAt`). */
    expiresAt: { type: Date, required: true },

    failedAttempts: { type: Number, default: 0, min: 0, max: MAX_FAILED_ATTEMPTS },

    otpHash: { type: String, default: null, select: false },
    otpExpiresAt: { type: Date, default: null },
    otpSendCount: { type: Number, default: 0, min: 0 },
    otpLastSentAt: { type: Date, default: null },

    /**
     * SIMULATION SEULEMENT : le code en clair, pour l'afficher à la place du
     * SMS qui n'est pas envoyé. Refusé sur un lien réel (garde ci-dessous).
     */
    sandboxOtp: { type: String, default: null, select: false },

    linkSmsSentAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    refusedAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "transfer_claims",
  }
);

schema.index({ transaction: 1 }, { unique: true });
schema.index({ tokenHash: 1 }, { unique: true });

schema.pre("validate", function (next) {
  // Un code en clair n'a rien à faire sur un lien qui porte de l'argent réel.
  if (this.mode !== "sandbox" && this.sandboxOtp) {
    return next(new Error("sandboxOtp interdit hors simulation"));
  }
  return next();
});

module.exports = (conn = mongoose) =>
  conn.models.TransferClaim || conn.model("TransferClaim", schema);
