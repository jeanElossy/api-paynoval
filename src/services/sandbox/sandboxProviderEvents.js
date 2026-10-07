"use strict";

/**
 * ============================================================================
 * REGISTRE DES ORDRES PRESTATAIRE SIMULÉS
 * ============================================================================
 *
 * Écrit par les adapters de simulation, lu par le worker de règlement et par la
 * page 3-D Secure de test. Voir `models/SandboxProviderEvent.js` pour le cycle
 * de vie et la raison d'un stockage en base plutôt qu'en mémoire.
 */

const crypto = require("crypto");
const mongoose = require("mongoose");

const runtime = require("../transactions/shared/runtime");
const { planThreeDSDecline } = require("../../providers/sandbox/sandboxScenario");

const THREE_DS_TTL_MS = 15 * 60 * 1000;
const DELIVERED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const DEFAULT_LOCK_MS = 60 * 1000;

/** Chemin de la page de test, servi par la passerelle (route publique). */
const THREE_DS_PATH_PREFIX = "/api/v1/sandbox/3ds/";

function model() {
  return require("../../models/SandboxProviderEvent")(runtime.txConn);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function newThreeDSToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function isDuplicateKey(err) {
  return err?.code === 11000 || err?.code === 11001;
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + Number(seconds || 0) * 1000);
}

/**
 * Action suivante rendue au client — la forme du `next_action` de Stripe.
 * Le CHEMIN seulement : l'application le résout contre l'adresse de l'API
 * qu'elle utilise déjà, ce qui évite à ce service de connaître son adresse
 * publique.
 */
function buildThreeDSNextAction(token) {
  return {
    type: "redirect_to_url",
    redirectToUrl: { path: `${THREE_DS_PATH_PREFIX}${token}` },
  };
}

/**
 * Enregistre l'ordre et son issue. Idempotent sur `{transactionId, kind}` :
 * une seconde soumission rend l'ordre existant (et, pour un 3DS encore en
 * attente, un nouveau jeton — l'ancien n'est connu que haché).
 */
async function scheduleProviderEvent({
  transaction,
  rail,
  provider,
  kind,
  providerReference,
  plan,
  now = new Date(),
}) {
  const Event = model();
  const requiresAction = plan.requiresThreeDS === true;
  const token = requiresAction ? newThreeDSToken() : null;

  const doc = {
    transactionId: transaction._id,
    userId: transaction.userId,
    reference: transaction.reference || null,
    rail,
    provider,
    kind,
    providerReference,
    settle: plan.settle,
    failureCode: plan.failureCode,
    failureMessage: plan.failureMessage,
    delaySeconds: plan.delaySeconds,
    status: requiresAction ? "awaiting_action" : plan.settle ? "scheduled" : "held",
    dueAt: requiresAction || !plan.settle ? null : addSeconds(now, plan.delaySeconds),
    threeDS: requiresAction
      ? { tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + THREE_DS_TTL_MS) }
      : {},
  };

  try {
    await Event.create(doc);

    return {
      providerReference,
      requiresAction,
      nextAction: requiresAction ? buildThreeDSNextAction(token) : null,
    };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;

    const existing = await Event.findOne({ transactionId: transaction._id, kind }).lean();

    if (existing?.status === "awaiting_action") {
      const fresh = newThreeDSToken();
      await Event.updateOne(
        { _id: existing._id, status: "awaiting_action" },
        {
          $set: {
            "threeDS.tokenHash": hashToken(fresh),
            "threeDS.expiresAt": new Date(now.getTime() + THREE_DS_TTL_MS),
          },
        }
      );

      return {
        providerReference: existing.providerReference,
        requiresAction: true,
        nextAction: buildThreeDSNextAction(fresh),
      };
    }

    return {
      providerReference: existing?.providerReference || providerReference,
      requiresAction: false,
      nextAction: null,
    };
  }
}

/**
 * Prend UN événement échu. Verrou avec propriétaire et durée de vie
 * (invariant 5) : un événement « processing » dont le verrou a expiré est
 * repris — son worker est mort en route.
 */
async function claimNextDueEvent({ workerId, lockMs = DEFAULT_LOCK_MS, now = new Date() }) {
  if (!workerId) throw new Error("claimNextDueEvent : workerId requis.");

  return model().findOneAndUpdate(
    {
      $or: [
        { status: "scheduled", dueAt: { $lte: now } },
        { status: "processing", lockExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "processing",
        lockedBy: workerId,
        lockExpiresAt: new Date(now.getTime() + lockMs),
      },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { dueAt: 1 } }
  );
}

/** Clôture par le SEUL détenteur du verrou. */
async function markDelivered(event, workerId, { note = null, now = new Date() } = {}) {
  return model().updateOne(
    { _id: event._id, lockedBy: workerId, status: "processing" },
    {
      $set: {
        status: "delivered",
        deliveredAt: now,
        lastError: note ? String(note).slice(0, 300) : null,
        lockedBy: null,
        lockExpiresAt: null,
        expireAt: new Date(now.getTime() + DELIVERED_RETENTION_MS),
      },
    }
  );
}

/**
 * Échec de livraison : nouvel essai avec attente croissante, puis `error` —
 * qui se SIGNALE (journal du worker) au lieu de boucler sans fin.
 */
async function markRetry(event, workerId, err, { now = new Date() } = {}) {
  const exhausted = Number(event.attempts || 0) >= MAX_ATTEMPTS;
  const backoffSeconds = Math.min(60, 2 ** Number(event.attempts || 1));

  return model().updateOne(
    { _id: event._id, lockedBy: workerId, status: "processing" },
    {
      $set: {
        status: exhausted ? "error" : "scheduled",
        dueAt: exhausted ? null : addSeconds(now, backoffSeconds),
        lastError: String(err?.message || err || "erreur").slice(0, 300),
        lockedBy: null,
        lockExpiresAt: null,
      },
    }
  );
}

/** Événement 3DS encore décidable pour ce jeton, ou `null`. */
async function findThreeDSByToken(token, { now = new Date() } = {}) {
  const raw = String(token || "").trim();
  if (!raw || raw.length > 128) return null;

  return model()
    .findOne({
      "threeDS.tokenHash": hashToken(raw),
      status: "awaiting_action",
      "threeDS.expiresAt": { $gt: now },
    })
    .lean();
}

/**
 * Décision du titulaire sur la page 3DS. Approuvé : l'issue prévue par le
 * scénario est planifiée maintenant + délai. Refusé : échec immédiat.
 * Le jeton est consommé (une seule décision possible).
 */
async function decideThreeDS(token, decision, { now = new Date() } = {}) {
  if (decision !== "approved" && decision !== "declined") {
    const err = new Error("Décision 3-D Secure invalide.");
    err.status = 400;
    err.statusCode = 400;
    throw err;
  }

  const event = await findThreeDSByToken(token, { now });
  if (!event) return null;

  const $set = {
    "threeDS.decision": decision,
    "threeDS.decidedAt": now,
    "threeDS.tokenHash": null,
  };

  if (decision === "declined") {
    const plan = planThreeDSDecline();
    Object.assign($set, {
      settle: plan.settle,
      failureCode: plan.failureCode,
      failureMessage: plan.failureMessage,
      status: "scheduled",
      dueAt: now,
    });
  } else if (event.settle) {
    Object.assign($set, { status: "scheduled", dueAt: addSeconds(now, event.delaySeconds) });
  } else {
    // Scénario « en attente » : authentifié, mais le prestataire ne répond pas.
    Object.assign($set, { status: "held", dueAt: null });
  }

  const res = await model().updateOne(
    { _id: event._id, status: "awaiting_action" },
    { $set }
  );

  return res.modifiedCount === 1 ? { ...event, ...$set } : null;
}

/**
 * Réinitialisation : tout ordre encore ouvert de ce compte reçoit un rappel
 * d'ÉCHEC immédiat. Le règlement passe ensuite par le vrai moteur, qui libère
 * ou rembourse les fonds réservés — aucun chemin de traverse.
 */
async function failOpenEventsForUser(userId, { failureCode, failureMessage, now = new Date() }) {
  const res = await model().updateMany(
    {
      userId: new mongoose.Types.ObjectId(String(userId)),
      status: { $in: ["awaiting_action", "scheduled", "held"] },
    },
    {
      $set: {
        settle: "failure",
        failureCode,
        failureMessage,
        status: "scheduled",
        dueAt: now,
        "threeDS.tokenHash": null,
      },
    }
  );

  return res.modifiedCount || 0;
}

async function countOpenEventsForUser(userId) {
  return model().countDocuments({
    userId: new mongoose.Types.ObjectId(String(userId)),
    status: { $in: ["awaiting_action", "scheduled", "held", "processing"] },
  });
}

module.exports = {
  THREE_DS_PATH_PREFIX,
  MAX_ATTEMPTS,
  hashToken,
  buildThreeDSNextAction,
  scheduleProviderEvent,
  claimNextDueEvent,
  markDelivered,
  markRetry,
  findThreeDSByToken,
  decideThreeDS,
  failOpenEventsForUser,
  countOpenEventsForUser,
};
