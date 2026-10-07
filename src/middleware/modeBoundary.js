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
 *     il ne redevient JAMAIS un compte réel.
 *
 * Fonction pure : `authMiddleware` l'applique à chaque identité qu'il résout.
 * Même découpage que `deviceBinding.js` (cœur fonctionnel, coquille Express).
 */

function claimedModeOf(decoded) {
  if (!decoded) return undefined;
  if (decoded.mode !== undefined) return decoded.mode;
  if (decoded.isSandbox === true) return "sandbox";
  return undefined;
}

function evaluateModeBoundary({ user, decoded = null, sandboxEnabled }) {
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
  }

  return { ok: true };
}

module.exports = { claimedModeOf, evaluateModeBoundary };
