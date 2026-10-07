"use strict";

/**
 * ============================================================================
 * ORDRE PRESTATAIRE SIMULÉ — ET LE RAPPEL QUI LE RÈGLERA
 * ============================================================================
 *
 * Quand un adapter de simulation reçoit un ordre, il l'enregistre ici avec
 * l'issue que le scénario du compte a choisie. Le worker de simulation livre
 * ensuite le rappel au moteur de règlement, à l'échéance (`dueAt`).
 *
 * ── Pourquoi en base et pas un `setTimeout` ────────────────────────────────
 * Un délai en mémoire meurt avec le processus : un redéploiement, une mise en
 * sommeil (Render gratuit) ou une seconde instance, et la transaction reste en
 * cours pour toujours. Ici l'échéance survit à tout, et n'importe quelle
 * instance peut la livrer.
 *
 * ── Verrou : propriétaire ET durée de vie (invariant 5) ────────────────────
 * Un worker prend l'événement en posant `lockedBy` et `lockExpiresAt`. Seul
 * le détenteur le clôt ; un verrou expiré est repris par un autre worker.
 * Le règlement est de toute façon idempotent (`eventId` dans l'historique de
 * la transaction, drapeaux monétaires) : une double livraison ne double rien.
 *
 * ── 3-D Secure ─────────────────────────────────────────────────────────────
 * Un encaissement par carte attend la décision du titulaire (`awaiting_action`).
 * Le jeton de la page de test n'est stocké que HACHÉ (SHA-256) : la base ne
 * contient rien qui permette d'ouvrir la page à la place du titulaire.
 *
 * Unicité `{transactionId, kind}` : rejouer la soumission d'un ordre ne crée
 * pas un second rappel — c'est l'idempotence du prestataire fictif.
 */

const mongoose = require("mongoose");

const STATUSES = Object.freeze([
  "awaiting_action", // 3DS en attente de la décision du titulaire
  "scheduled", // rappel planifié à `dueAt`
  "held", // scénario « en attente » : aucun rappel ne viendra
  "processing", // pris par un worker
  "delivered", // règlement livré au moteur
  "error", // livraison en échec après plusieurs tentatives
]);

const schema = new mongoose.Schema(
  {
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    reference: { type: String, default: null },
    rail: { type: String, enum: ["mobilemoney", "card"], required: true },
    provider: { type: String, required: true },
    kind: { type: String, enum: ["payout", "collect"], required: true },
    providerReference: { type: String, required: true },

    settle: { type: String, enum: ["success", "failure", null], default: null },
    failureCode: { type: String, default: null },
    failureMessage: { type: String, default: null },
    delaySeconds: { type: Number, default: 0 },

    status: { type: String, enum: STATUSES, required: true },
    dueAt: { type: Date, default: null },

    lockedBy: { type: String, default: null },
    lockExpiresAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null, maxlength: 300 },
    deliveredAt: { type: Date, default: null },

    threeDS: {
      tokenHash: { type: String, default: null },
      expiresAt: { type: Date, default: null },
      decision: { type: String, enum: ["approved", "declined", null], default: null },
      decidedAt: { type: Date, default: null },
    },

    /** Purge automatique 30 jours après livraison — données de démonstration. */
    expireAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "sandbox_provider_events",
  }
);

schema.index({ transactionId: 1, kind: 1 }, { unique: true });
schema.index({ status: 1, dueAt: 1 });
schema.index({ "threeDS.tokenHash": 1 }, { sparse: true });
schema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = (conn = mongoose) =>
  conn.models.SandboxProviderEvent || conn.model("SandboxProviderEvent", schema);

module.exports.STATUSES = STATUSES;
