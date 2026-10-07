"use strict";

/**
 * Lecture et écriture des réglages de simulation d'un compte
 * (`models/SandboxScenario`). Aucune règle métier ici : la validation vit dans
 * `providers/sandbox/sandboxScenario.normalizeScenario`.
 */

const mongoose = require("mongoose");

const runtime = require("../transactions/shared/runtime");
const {
  DEFAULT_SCENARIO,
  normalizeScenario,
} = require("../../providers/sandbox/sandboxScenario");

function model() {
  return require("../../models/SandboxScenario")(runtime.txConn);
}

function toObjectId(userId) {
  const id = String(userId || "").trim();

  if (!mongoose.isValidObjectId(id)) {
    const err = new Error("Identifiant de compte sandbox invalide.");
    err.status = 400;
    err.statusCode = 400;
    throw err;
  }

  return new mongoose.Types.ObjectId(id);
}

async function getProfile(userId, { session = null } = {}) {
  return model()
    .findOne({ userId: toObjectId(userId) })
    .session(session)
    .lean();
}

/**
 * Scénario applicable aux prochains ordres. Un compte sans réglage suit le
 * scénario par défaut (succès) : c'est le comportement d'un prestataire sain,
 * pas un repli sur une donnée financière.
 */
async function loadScenario(userId) {
  const doc = await getProfile(userId);

  if (!doc) return { ...DEFAULT_SCENARIO };

  return normalizeScenario({
    outcome: doc.outcome,
    confirmationDelaySeconds: doc.confirmationDelaySeconds,
  });
}

async function saveScenario(userId, input) {
  const scenario = normalizeScenario(input);

  const doc = await model().findOneAndUpdate(
    { userId: toObjectId(userId) },
    { $set: scenario },
    { new: true }
  );

  if (!doc) {
    const err = new Error("Compte de simulation non provisionné.");
    err.code = "SANDBOX_NOT_PROVISIONED";
    err.status = 409;
    err.statusCode = 409;
    throw err;
  }

  return scenario;
}

/** Crée le profil s'il n'existe pas ; ne réécrit jamais un profil existant. */
async function ensureProfile(userId, { currency, initialBalance }, { session = null } = {}) {
  return model().findOneAndUpdate(
    { userId: toObjectId(userId) },
    {
      $setOnInsert: {
        userId: toObjectId(userId),
        ...DEFAULT_SCENARIO,
        currency: String(currency).trim().toUpperCase(),
        initialBalance: mongoose.Types.Decimal128.fromString(String(initialBalance)),
        historyStartsAt: null,
        lastResetAt: null,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
}

/** Réinitialisation : réglages par défaut, historique repart de `at`. */
async function markReset(userId, at = new Date()) {
  return model().findOneAndUpdate(
    { userId: toObjectId(userId) },
    {
      $set: {
        ...DEFAULT_SCENARIO,
        historyStartsAt: at,
        lastResetAt: at,
      },
    },
    { new: true }
  );
}

module.exports = {
  getProfile,
  loadScenario,
  saveScenario,
  ensureProfile,
  markReset,
};
