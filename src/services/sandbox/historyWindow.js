"use strict";

/**
 * FENÊTRE D'HISTORIQUE D'UN COMPTE SANDBOX.
 *
 * « Réinitialiser la démo » ne supprime rien : transactions et écritures sont
 * immuables (invariant 4). Elle avance la date à partir de laquelle
 * l'historique est AFFICHÉ (`SandboxScenario.historyStartsAt`). Les listes et
 * graphiques de l'utilisateur appliquent cette fenêtre ; le grand livre, les
 * contrôles et le back-office voient tout.
 *
 * Un compte live n'a jamais de fenêtre : `resolveHistoryStart` rend `null`
 * sans aucune lecture.
 */

const { ACCOUNT_MODES } = require("../../utils/accountMode");
const { SEED_CONTEXT } = require("./demoDatasets");

async function resolveHistoryStart(req, { getProfile } = {}) {
  if (req?.user?.mode !== ACCOUNT_MODES.SANDBOX) return null;

  const userId = String(req.user._id || req.user.id || "").trim();
  if (!userId) return null;

  const load = getProfile || require("./sandboxScenarioStore").getProfile;
  const profile = await load(userId);

  return profile?.historyStartsAt ? new Date(profile.historyStartsAt) : null;
}

/**
 * Fenêtre complète : la date de réinitialisation, et le jeu de départ en cours,
 * que la réinitialisation vient de recréer avec des dates passées.
 */
async function resolveHistoryWindow(req, { getProfile } = {}) {
  if (req?.user?.mode !== ACCOUNT_MODES.SANDBOX) return null;

  const userId = String(req.user._id || req.user.id || "").trim();
  if (!userId) return null;

  const load = getProfile || require("./sandboxScenarioStore").getProfile;
  const profile = await load(userId);

  if (!profile?.historyStartsAt) return null;

  return {
    start: new Date(profile.historyStartsAt),
    seedId: profile.seedGeneration ? `${userId}:${profile.seedGeneration}` : null,
  };
}

/** Restreint une requête à la fenêtre. Fonction pure. */
function applyHistoryWindow(query, window) {
  if (!window) return query;

  const recent = { createdAt: { $gte: window.start } };
  if (!window.seedId) return { $and: [query, recent] };

  return {
    $and: [query, { $or: [recent, { context: SEED_CONTEXT, contextId: window.seedId }] }],
  };
}

/** Restreint une requête aux documents créés depuis `start`. Fonction pure. */
function applyHistoryStart(query, start) {
  if (!start) return query;
  return { $and: [query, { createdAt: { $gte: start } }] };
}

module.exports = {
  resolveHistoryStart,
  applyHistoryStart,
  resolveHistoryWindow,
  applyHistoryWindow,
};
