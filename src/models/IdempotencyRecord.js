"use strict";

/**
 * ============================================================================
 * REGISTRE D'IDEMPOTENCE DE L'API — MOTIF STRIPE
 * ============================================================================
 *
 * CE QUE CE REGISTRE GARANTIT
 * ---------------------------
 * Une même requête de création, rejouée — double appui, délai d'attente réseau,
 * reprise de la passerelle — ne produit **qu'un seul effet**, et rend
 * **exactement la même réponse** que la première fois.
 *
 * C'est la garantie fondatrice de Stripe (`Idempotency-Key`), de PayPal
 * (`PayPal-Request-Id`) et de Wise. Elle est plus profonde qu'un index unique :
 * l'index empêche le doublon en base, mais laisse l'appelant face à une erreur
 * qu'il ne sait pas interpréter. Le registre, lui, lui rend la réponse
 * d'origine — le client ne voit même pas qu'il a rejoué.
 *
 * POURQUOI L'EMPREINTE DE REQUÊTE
 * -------------------------------
 * Sans elle, un client qui réutilise une clé par erreur — même identifiant pour
 * deux virements différents — recevrait la réponse du premier et croirait le
 * second effectué. L'empreinte permet de détecter le cas et de le REFUSER
 * explicitement, plutôt que de mentir. Stripe renvoie une erreur dédiée dans
 * cette situation ; on fait pareil.
 *
 * POURQUOI UN ÉTAT « EN COURS »
 * -----------------------------
 * Deux requêtes identiques peuvent arriver en même temps. La première pose la
 * clé, la seconde la trouve « en cours » et reçoit un 409 : mieux vaut demander
 * au client de réessayer que d'exécuter deux fois. Le bail évite qu'un processus
 * mort bloque la clé pour toujours.
 *
 * DURÉE DE VIE
 * ------------
 * 24 heures, comme Stripe. Au-delà, la clé est libérée : c'est un filet contre
 * les rejeux, pas un journal. Le journal, ce sont les transactions elles-mêmes.
 */

const mongoose = require("mongoose");

const { Schema } = mongoose;

/** Fenêtre de rejeu, alignée sur Stripe. */
const RETENTION_SECONDS = 24 * 60 * 60;

/** Bail d'un traitement en cours — au-delà, la clé est reprenable. */
const IN_PROGRESS_LEASE_MS = 60 * 1000;

const idempotencyRecordSchema = new Schema(
  {
    /**
     * Portée + clé. La portée isole les clés par utilisateur et par endpoint :
     * deux utilisateurs peuvent envoyer la même clé sans se marcher dessus, et
     * une clé utilisée sur `/initiate` ne vaut pas sur `/cancel`.
     */
    scope: { type: String, required: true, trim: true },
    key: { type: String, required: true, trim: true },

    /** Empreinte de la requête d'origine (méthode + chemin + corps). */
    requestFingerprint: { type: String, required: true, trim: true },

    status: {
      type: String,
      enum: ["in_progress", "completed"],
      default: "in_progress",
      required: true,
    },

    /** Réponse figée, rendue telle quelle à chaque rejeu. */
    responseStatus: { type: Number, default: null },
    responseBody: { type: Schema.Types.Mixed, default: null },

    userId: { type: String, default: "", trim: true },
    method: { type: String, default: "", trim: true },
    path: { type: String, default: "", trim: true },

    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "idempotency_records",
    minimize: false,
  }
);

/**
 * L'UNICITÉ, C'EST LA GARANTIE. Tout le reste est de l'ergonomie : c'est cet
 * index qui rend impossible deux traitements concurrents de la même clé.
 */
idempotencyRecordSchema.index(
  { scope: 1, key: 1 },
  { unique: true, name: "uniq_idempotency_scope_key" }
);

/**
 * Expiration à 24 h. Contrairement au registre des versements de parrainage —
 * qui ne doit JAMAIS expirer, puisqu'il protège de l'argent déjà versé — celui-ci
 * ne protège qu'une fenêtre de rejeu réseau.
 */
idempotencyRecordSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: RETENTION_SECONDS, name: "idempotency_ttl" }
);

module.exports = (conn = mongoose) =>
  conn.models.IdempotencyRecord ||
  conn.model("IdempotencyRecord", idempotencyRecordSchema);

module.exports.RETENTION_SECONDS = RETENTION_SECONDS;
module.exports.IN_PROGRESS_LEASE_MS = IN_PROGRESS_LEASE_MS;
