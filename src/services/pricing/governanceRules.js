"use strict";

/**
 * Règles de gouvernance tarifaire (pures) — déplacé depuis l'API Gateway le 2026-09-10.
 *
 * Le domaine des prix appartenait à la passerelle, qui le servait à Tx-Core en
 * HTTP : le moteur d'argent dépendait donc du bord, et une panne de la
 * passerelle arrêtait les virements de l'intérieur. Les dépendances descendent
 * — bord → services → moteur, jamais l'inverse. C'est la règle que tiennent
 * Stripe, PayPal et Adyen, et la raison pour laquelle leur passerelle ne
 * possède aucun domaine et ne détient aucune base.
 * */
/**
 * INVARIANTS DE LA GOUVERNANCE TARIFAIRE
 * -----------------------------------------------------------------------------
 * Ces gardes sont appliquées PAR LE SERVEUR. Le bouton grisé du back-office
 * n'est qu'une politesse : c'est ici que l'interdiction fait autorité.
 *
 * Fonctions pures : aucun accès base, aucun accès réseau.
 */

const BREAK_GLASS_ROLE = "superadmin";

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function actorId(actor) {
  if (!actor) return null;
  const raw = actor.staffId ?? actor._id ?? actor.id ?? null;
  return raw == null ? null : String(raw);
}

/**
 * Deux acteurs désignent-ils la même personne ? Les identifiants arrivent tantôt
 * en `staffId` (côté demande stockée), tantôt en `_id` (côté `req.user`).
 */
function isSameActor(a, b) {
  const ida = actorId(a);
  const idb = actorId(b);
  return !!ida && !!idb && ida === idb;
}

function normalizeRole(actor) {
  return String(actor?.role ?? "").trim().toLowerCase();
}

/**
 * @param {{request: object, actor: object, breakGlass: {used: boolean, reason: string}|null}} params
 * @throws {Error} portant `.status` (403 ou 409)
 */
function assertCanApprove({ request, actor, breakGlass }) {
  if (!request) {
    throw httpError(404, "Demande introuvable.");
  }

  if (request.status !== "pending_approval") {
    throw httpError(
      409,
      `Cette demande n'est plus en attente de validation (état : ${request.status}).`
    );
  }

  if (!isSameActor(request.requestedBy, actor)) {
    return; // Second valideur distinct : cas nominal.
  }

  // À partir d'ici, le valideur EST le demandeur.
  const wantsBreakGlass = !!breakGlass?.used;

  if (!wantsBreakGlass) {
    throw httpError(
      403,
      "Vous êtes le demandeur : la validation revient à un autre administrateur."
    );
  }

  if (normalizeRole(actor) !== BREAK_GLASS_ROLE) {
    throw httpError(
      403,
      "La publication sans second valideur est réservée au rôle superadmin."
    );
  }

  if (!String(breakGlass?.reason ?? "").trim()) {
    throw httpError(
      403,
      "La publication sans second valideur exige un motif, consigné au journal."
    );
  }
}

/**
 * @param {{request: object, rule: object|null}} params
 * @throws {Error} portant `.status = 409`
 */
function assertVersionMatches({ request, rule }) {
  if (request?.baseVersion == null) {
    return; // Création : aucune version antérieure à contrôler.
  }

  if (!rule) {
    throw httpError(409, "La règle visée par cette demande n'existe plus.");
  }

  if (Number(rule.currentVersion) !== Number(request.baseVersion)) {
    throw httpError(
      409,
      `La règle a été modifiée depuis le dépôt de cette demande (version ${request.baseVersion} attendue, ${rule.currentVersion} en base). Déposez une nouvelle demande à partir de l'état courant.`
    );
  }
}

/**
 * Défense en profondeur sur le RÔLE, dans Tx-Core.
 *
 * La passerelle exige déjà admin/superadmin avant de relayer. Mais les routes
 * de gouvernance de Tx-Core ne vérifiaient que le jeton interne : quiconque le
 * détient (un autre service, une fuite) pouvait déposer ou approuver une
 * tarification au nom de n'importe quel utilisateur, y compris sans rôle. Le
 * rôle relu en base (`internalProtect` recharge l'utilisateur) est donc
 * contrôlé ici aussi — c'est la règle de Stripe : chaque service vérifie
 * l'autorisation qui le concerne, il n'hérite pas de celle du bord.
 */
const STAFF_PRICING_ROLES = Object.freeze(["admin", "superadmin"]);

function assertStaffRole(actor, roles = STAFF_PRICING_ROLES) {
  if (!actorId(actor)) {
    throw httpError(401, "Utilisateur non authentifié.");
  }

  if (!roles.includes(normalizeRole(actor))) {
    throw httpError(403, "Rôle insuffisant pour la gouvernance tarifaire.");
  }
}

module.exports = {
  assertStaffRole,
  STAFF_PRICING_ROLES,
  assertCanApprove,
  assertVersionMatches,
  isSameActor,
  actorId,
  httpError,
  BREAK_GLASS_ROLE,
};
