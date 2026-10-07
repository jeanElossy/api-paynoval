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

async function resolveHistoryStart(req, { getProfile } = {}) {
  if (req?.user?.mode !== ACCOUNT_MODES.SANDBOX) return null;

  const userId = String(req.user._id || req.user.id || "").trim();
  if (!userId) return null;

  const load = getProfile || require("./sandboxScenarioStore").getProfile;
  const profile = await load(userId);

  return profile?.historyStartsAt ? new Date(profile.historyStartsAt) : null;
}

/** Restreint une requête aux documents créés depuis `start`. Fonction pure. */
function applyHistoryStart(query, start) {
  if (!start) return query;
  return { $and: [query, { createdAt: { $gte: start } }] };
}

module.exports = { resolveHistoryStart, applyHistoryStart };
