"use strict";

/**
 * ============================================================================
 * PORTÉE D'UNE CAGNOTTE — SON MODE ET SON GROUPE DE DÉMONSTRATION
 * ============================================================================
 *
 * Une cagnotte naît dans le mode de son créateur (`live` ou `sandbox`) et n'en
 * change jamais : le backend principal pose `mode` et `sandboxGroupId` à la
 * création, sur le document `cagnottes` de la base Users. Tx-Core RELIT ce
 * document à chaque règlement — il ne croit pas le mode qu'un appelant lui
 * enverrait.
 *
 * Conséquences, tenues par les contrôleurs de règlement :
 *   - le portefeuille débité ou crédité est du mode de la cagnotte ;
 *   - le participant connecté est du même mode ET, en simulation, du même
 *     groupe de démo (sinon : cagnotte introuvable, comme Stripe qui ne montre
 *     pas un objet de test à une clé live) ;
 *   - frais et marge vont aux trésoreries du mode ;
 *   - un invité paie une cagnotte de simulation par un prestataire de
 *     SIMULATION : aucun argent réel n'entre dans un coffre fictif.
 *
 * Un document antérieur à la migration n'a pas de `mode` : il hérite de celui
 * de son propriétaire (`resolveUserMode`, ancien drapeau compris).
 */

const mongoose = require("mongoose");

const runtime = require("../transactions/shared/runtime");
const {
  ACCOUNT_MODES,
  isAccountMode,
  resolveUserMode,
  isCounterpartyInScope,
} = require("../../utils/accountMode");

function scopeError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.code = code;
  return err;
}

/** Portée d'un document cagnotte déjà lu (et de son propriétaire). Pure. */
function scopeOfCagnotte(cagnotte, owner = null) {
  if (!cagnotte) return null;

  const mode = isAccountMode(cagnotte.mode)
    ? cagnotte.mode
    : owner
      ? resolveUserMode(owner)
      : ACCOUNT_MODES.LIVE;

  return {
    mode,
    sandboxGroupId: cagnotte.sandboxGroupId
      ? String(cagnotte.sandboxGroupId)
      : owner?.sandboxGroupId
        ? String(owner.sandboxGroupId)
        : null,
  };
}

async function loadCagnotteScope(cagnotteId) {
  const id = String(cagnotteId || "").trim();

  if (!mongoose.isValidObjectId(id)) {
    throw scopeError(400, "INVALID_CAGNOTTE_ID", "Identifiant de cagnotte invalide.");
  }

  const db = runtime.usersConn.db;
  const cagnotte = await db
    .collection("cagnottes")
    .findOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { projection: { mode: 1, sandboxGroupId: 1, userId: 1 } }
    );

  if (!cagnotte) {
    throw scopeError(404, "CAGNOTTE_NOT_FOUND", "Cagnotte introuvable.");
  }

  let owner = null;
  if (!isAccountMode(cagnotte.mode) && cagnotte.userId) {
    owner = await db
      .collection("users")
      .findOne(
        { _id: cagnotte.userId },
        { projection: { mode: 1, isSandbox: 1, isReviewerAccount: 1, sandboxGroupId: 1 } }
      );
  }

  return scopeOfCagnotte(cagnotte, owner);
}

/**
 * Portée d'une cagnotte désignée par son CODE de participation (parcours
 * invité). `null` si le code ne désigne rien.
 */
async function loadCagnotteScopeByCode(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;

  const db = runtime.usersConn.db;
  const cagnotte = await db
    .collection("cagnottes")
    .findOne({ codeParticipation: c }, { projection: { mode: 1, sandboxGroupId: 1, userId: 1 } });

  if (!cagnotte) return null;

  let owner = null;
  if (!isAccountMode(cagnotte.mode) && cagnotte.userId) {
    owner = await db
      .collection("users")
      .findOne(
        { _id: cagnotte.userId },
        { projection: { mode: 1, isSandbox: 1, isReviewerAccount: 1, sandboxGroupId: 1 } }
      );
  }

  return scopeOfCagnotte(cagnotte, owner);
}

/**
 * Un compte hors de la portée de la cagnotte la voit INTROUVABLE — même
 * réponse qu'un code inconnu, pour ne rien révéler.
 */
function assertUserInCagnotteScope(user, scope) {
  if (!isCounterpartyInScope(user, scope)) {
    throw scopeError(404, "CAGNOTTE_NOT_FOUND", "Cagnotte introuvable.");
  }
  return scope.mode;
}

module.exports = {
  scopeOfCagnotte,
  loadCagnotteScope,
  loadCagnotteScopeByCode,
  assertUserInCagnotteScope,
};
