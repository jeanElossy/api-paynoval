"use strict";

/**
 * ============================================================================
 * FRONTIÈRE DES MODES — LA DÉCISION, SANS EXPRESS NI BASE
 * ============================================================================
 *
 * Décide si une identité utilisateur résolue peut être servie :
 *
 *  1. le mode porté par le JETON doit être celui de la BASE. Un écart veut dire
 *     qu'un jeton émis pour un monde est présenté dans l'autre — Stripe refuse
 *     de même une clé de test sur un objet live. Un jeton antérieur sans
 *     revendication `mode` est jugé sur l'ancien drapeau `isSandbox` ;
 *  2. un compte sandbox n'est servi que si la simulation est OUVERTE ;
 *  3. un compte sandbox désactivé (`sandboxDisabledAt`) n'est plus servi —
 *     il ne redevient JAMAIS un compte réel ;
 *  4. un jeton n'est accepté que dans son monde (`appEnv`) ;
 *  5. l'environnement de simulation ne sert aucun compte client réel ;
 *  6. un accès démo expiré n'est plus servi, sans tâche de fond à attendre.
 *
 * Fonction pure : `authMiddleware` l'applique à chaque identité qu'il résout.
 * Même découpage que `deviceBinding.js` (cœur fonctionnel, coquille Express).
 */

const { evaluateTokenEnvironment } = require("../services/sandboxEnvironment");

function claimedModeOf(decoded) {
  if (!decoded) return undefined;
  if (decoded.mode !== undefined) return decoded.mode;
  if (decoded.isSandbox === true) return "sandbox";
  return undefined;
}

function evaluateModeBoundary({ user, decoded = null, sandboxEnabled, appEnv = undefined, now = new Date() }) {
  if (decoded && appEnv !== undefined) {
    const world = evaluateTokenEnvironment({ appEnv, claimedEnv: decoded.env });
    if (!world.ok) return world;
  }

  if (appEnv === "sandbox" && user?.role === "user" && user?.mode !== "sandbox") {
    return {
      ok: false,
      status: 403,
      code: "LIVE_ACCOUNT_IN_SANDBOX_ENV",
      message: "Ce compte n'existe pas dans l'environnement de simulation.",
    };
  }

  const claimed = claimedModeOf(decoded);

  if (claimed !== undefined && claimed !== user?.mode) {
    return {
      ok: false,
      status: 401,
      code: "MODE_TOKEN_MISMATCH",
      message: "Session incohérente : reconnectez-vous.",
    };
  }

  if (user?.mode === "sandbox") {
    if (sandboxEnabled !== true) {
      return {
        ok: false,
        status: 403,
        code: "SANDBOX_DISABLED",
        message: "Le mode simulation est fermé.",
      };
    }

    if (user?.sandboxDisabledAt) {
      return {
        ok: false,
        status: 403,
        code: "SANDBOX_ACCOUNT_DISABLED",
        message: "Ce compte de simulation est désactivé.",
      };
    }

    if (user?.sandboxExpiresAt && new Date(user.sandboxExpiresAt).getTime() <= now.getTime()) {
      return {
        ok: false,
        status: 403,
        code: "SANDBOX_ACCESS_EXPIRED",
        message: "Cet accès de démonstration a expiré.",
      };
    }
  }

  return { ok: true };
}

module.exports = { claimedModeOf, evaluateModeBoundary };
