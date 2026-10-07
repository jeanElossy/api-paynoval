"use strict";

/**
 * Action suivante d'un ordre prestataire — la forme du `next_action` de Stripe
 * (`{ type: "redirect_to_url", redirect_to_url: { url } }`).
 *
 * Liste blanche stricte : seuls le type connu et un CHEMIN relatif propre à
 * PayNoval passent. Une URL absolue, un schéma, un chemin hors de
 * `/api/v1/sandbox/3ds/` sont écartés — la réponse ne doit jamais devenir un
 * redirecteur ouvert vers un site tiers.
 *
 * Fonction pure.
 */

const ALLOWED_PATH = /^\/api\/v1\/sandbox\/3ds\/[A-Za-z0-9_-]{16,128}$/;

function sanitizeNextAction(nextAction) {
  if (!nextAction || nextAction.type !== "redirect_to_url") return null;

  const path = nextAction.redirectToUrl?.path;
  if (typeof path !== "string" || !ALLOWED_PATH.test(path)) return null;

  return { type: "redirect_to_url", redirectToUrl: { path } };
}

module.exports = { sanitizeNextAction };
