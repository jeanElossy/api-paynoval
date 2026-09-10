"use strict";

/**
 * ============================================================================
 * TARIFICATION — POINTS D'ENTRÉE HTTP
 * ============================================================================
 *
 * Ce contrôleur ne calcule rien : il traduit du HTTP vers
 * `services/pricing/quoteService` et retour. Toute la logique de prix vit dans
 * le service, ce qui permet à `services/transactions/shared/pricing.js` de
 * l'appeler DIRECTEMENT, sans fabriquer un faux `req`/`res` ni faire un aller-
 * retour réseau vers soi-même.
 *
 * ── L'identité vient du bord, et de lui seul ────────────────────────────────
 *
 * `POST /lock` fige un prix pour QUELQU'UN : il lui faut un utilisateur. Mais
 * Tx-Core ne vérifie pas de session utilisateur — c'est le travail de la
 * passerelle, qui authentifie puis relaie `x-user-id` sur le canal interne.
 *
 * C'est le partage de responsabilité de Stripe et d'Adyen : le bord prouve
 * l'identité, le moteur la reçoit signée par le canal, et ne la redemande pas.
 * Le canal est protégé par le jeton interne — sans lui, `x-user-id` serait
 * déclaratif, donc n'importe qui pourrait verrouiller un prix au nom d'un autre.
 */

const logger = require("../logger");
const {
  buildRequest,
  validateRequest,
  computeFullQuote,
  lockQuote,
  buildQuoteResponsePayload,
  buildLockResponsePayload,
  recordCoverageGap,
} = require("../services/pricing/quoteService");

function pickBody(req) {
  return req.body && Object.keys(req.body).length ? req.body : req.query || {};
}

function pickRequestId(req) {
  return (
    req.headers["x-request-id"] ||
    req.headers["x-correlation-id"] ||
    req.id ||
    ""
  );
}

function sendPricingError(res, status, message, details = null) {
  return res.status(status).json({
    success: false,
    ok: false,
    error: message,
    message,
    details,
  });
}

/**
 * Traduction unique des erreurs du service.
 *
 * ⚠️ Deux cas ne doivent JAMAIS devenir un 200 avec un prix par défaut :
 *
 *   · 404 — aucun barème ne couvre ce corridor. Servir un prix inventé ferait
 *     accepter un virement à un tarif que personne n'a décidé.
 *   · 503 — le taux de change est indisponible. Un taux de repli ferait perdre
 *     ou gagner de l'argent en silence sur chaque opération (règle B.2).
 */
function traduireErreur(res, e, next) {
  if (e && e.status === 404 && e.details) {
    /**
     * Consigné HORS du chemin de réponse : un incident de journalisation ne
     * doit jamais empêcher la réponse au client.
     */
    recordCoverageGap(e.details.normalizedRequest || {});

    return sendPricingError(
      res,
      404,
      e.message || "No pricing rule matched",
      e.details
    );
  }

  if (e && (e.status === 503 || e.message === "FX rate unavailable")) {
    return sendPricingError(res, 503, "FX rate unavailable", e.details || null);
  }

  if (e && e.status === 401) {
    return sendPricingError(res, 401, "Unauthorized");
  }

  return next(e);
}

async function quote(req, res, next) {
  try {
    const request = buildRequest(pickBody(req));
    const validationError = validateRequest(request);

    if (validationError) return sendPricingError(res, 400, validationError);

    const resultat = await computeFullQuote({
      request,
      requestId: pickRequestId(req),
    });

    return res.status(200).json(buildQuoteResponsePayload({ quote: resultat }));
  } catch (e) {
    return traduireErreur(res, e, next);
  }
}

async function lock(req, res, next) {
  try {
    /**
     * ⚠️ L'identité vient de l'en-tête relayé par la passerelle, qui a
     * authentifié. Le jeton interne, exigé par la route, est ce qui rend cet
     * en-tête digne de confiance : sans lui il serait purement déclaratif.
     */
    const userId = String(
      req.headers["x-user-id"] || req.body?.userId || ""
    ).trim();

    if (!userId) {
      return sendPricingError(
        res,
        401,
        "Identité absente : un verrou de prix engage PayNoval envers quelqu'un."
      );
    }

    const request = buildRequest(pickBody(req));
    const validationError = validateRequest(request);

    if (validationError) return sendPricingError(res, 400, validationError);

    const doc = await lockQuote({
      request,
      requestId: pickRequestId(req),
      userId,
    });

    logger.info("[pricing] verrou de prix posé", {
      quoteId: doc.quoteId,
      expiresAt: doc.expiresAt,
    });

    return res.status(200).json(buildLockResponsePayload({ doc }));
  } catch (e) {
    return traduireErreur(res, e, next);
  }
}

module.exports = { quote, lock };
