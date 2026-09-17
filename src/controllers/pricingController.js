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
  buildPublicQuotePayload,
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

    /**
     * Seul le périmètre normalisé est rendu : `details` portait aussi le nombre
     * de règles chargées et une consigne interne (« Crée une PricingRule… »),
     * servis à un visiteur anonyme.
     */
    return sendPricingError(res, 404, "No pricing rule matched", {
      code: "PRICING_CORRIDOR_NOT_COVERED",
      normalizedRequest: e.details.normalizedRequest || null,
    });
  }

  if (e && (e.status === 503 || e.message === "FX rate unavailable")) {
    // Le mode de change de la règle n'a rien à faire dans une réponse publique.
    return sendPricingError(res, 503, "FX rate unavailable", {
      code: e.code || "FX_RATE_UNAVAILABLE",
      fromCurrency: e.details?.fromCurrency ?? null,
      toCurrency: e.details?.toCurrency ?? null,
    });
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

    // Route publique : projection par liste blanche, jamais la réponse interne.
    return res.status(200).json(buildPublicQuotePayload({ quote: resultat }));
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
    /**
     * ⚠️ L'IDENTITÉ VIENT DE L'EN-TÊTE ÉTABLI PAR LE BORD, ET DE LUI SEUL.
     *
     * Un repli sur `req.body.userId` existait ici. Il était sans effet tant que
     * le verrou n'engageait rien — mais depuis le 2026-09-16 un devis ENGAGE le
     * prix, et il se consomme au nom de son propriétaire. Laisser l'appelant
     * déclarer ce propriétaire dans le corps de la requête reviendrait à lui
     * laisser figer un taux favorable au nom de quelqu'un d'autre.
     *
     * L'en-tête ne vaut, lui, que parce que la route exige le jeton interne :
     * sans ce jeton, `x-user-id` serait purement déclaratif.
     */
    const userId = String(req.headers["x-user-id"] || "").trim();

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
