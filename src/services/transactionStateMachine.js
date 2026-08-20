"use strict";

const STATES = Object.freeze({
  CREATED: "created",
  PENDING_CONFIRMATION: "pending",
  PENDING_REVIEW: "pending_review",
  PROCESSING: "processing",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
  RELAUNCH: "relaunch",
  LOCKED: "locked",
  FAILED: "failed",
});

const ALLOWED = Object.freeze({
  [STATES.CREATED]: [
    STATES.PENDING_CONFIRMATION,
    STATES.CANCELLED,
    STATES.FAILED,
  ],

  [STATES.PENDING_CONFIRMATION]: [
    STATES.CONFIRMED,
    STATES.CANCELLED,
    STATES.LOCKED,
    STATES.PENDING_REVIEW,
    STATES.PROCESSING,
    STATES.FAILED,
    /**
     * Relance administrative d'une transaction encore en attente. La transition
     * s'effectuait déjà en production — `relaunchController` écrivait le statut
     * en direct, sans passer par `assertTransition`. On la DÉCLARE plutôt que
     * de la laisser contourner la machine : §5 exige que chaque transition soit
     * explicitement autorisée, pas qu'elle soit rare.
     */
    STATES.RELAUNCH,
  ],

  [STATES.PENDING_REVIEW]: [
    STATES.CONFIRMED,
    STATES.CANCELLED,
    STATES.PROCESSING,
    STATES.FAILED,
  ],

  [STATES.PROCESSING]: [
    STATES.CONFIRMED,
    STATES.FAILED,
  ],

  [STATES.CONFIRMED]: [
    STATES.REFUNDED,
  ],

  [STATES.CANCELLED]: [
    STATES.RELAUNCH,
  ],

  [STATES.RELAUNCH]: [
    STATES.PENDING_CONFIRMATION,
    STATES.PROCESSING,
    STATES.CANCELLED,
    STATES.FAILED,
  ],

  [STATES.LOCKED]: [
    STATES.PENDING_CONFIRMATION,
    STATES.CANCELLED,
    /** Déverrouillage administratif — même raison que ci-dessus. */
    STATES.RELAUNCH,
  ],

  [STATES.REFUNDED]: [],
  [STATES.FAILED]: [
    STATES.RELAUNCH,
  ],
});

function normalizeState(v) {
  return String(v || "").trim().toLowerCase();
}

function canTransition(from, to) {
  const current = normalizeState(from);
  const target = normalizeState(to);
  return Array.isArray(ALLOWED[current]) && ALLOWED[current].includes(target);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const err = new Error(`Transition invalide: ${from} -> ${to}`);
    err.status = 400;
    throw err;
  }
}

module.exports = {
  STATES,
  ALLOWED,
  canTransition,
  assertTransition,
};