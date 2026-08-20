"use strict";

/**
 * Garde du chemin webhook HÉRITÉ `POST /api/v1/transactions/webhooks/:provider`.
 *
 * ⚠️ CORRECTIF DE SÉCURITÉ (audit transactionnel).
 *
 * Cette route n'avait AUCUNE garde. Un commentaire disait que « la sécurité
 * webhook doit être faite via signature/provider/internal middleware » — aucun
 * de ces middlewares n'était monté, et `/api/v1/transactions` est monté sans
 * `protect` dans `server.js`. La route atteignait donc
 * `externalSettlementController`, c'est-à-dire le moteur de règlement complet,
 * depuis Internet et sans identité.
 *
 * Le seul contrôle du contrôleur est `verified: payload.verified !== false` :
 * la charge utile de l'appelant s'y déclare elle-même vérifiée. Un
 * `{ transactionId, status: "success" }` suffisait à faire créditer un
 * bénéficiaire, ou à marquer un payout SUCCESS alors qu'aucun prestataire
 * n'avait payé.
 *
 * La route de production des prestataires est
 * `POST /webhooks/providers/:rail/:provider` : signature HMAC sur `rawBody`,
 * refus en l'absence de secret, rate limit dédié. Rien dans le dépôt n'appelle
 * le chemin hérité — vérifié sur les cinq applications.
 *
 * On ne supprime pas la route (corriger plutôt que retirer une fonctionnalité),
 * mais elle échoue désormais en FERMETURE : seul un appelant interne porteur
 * d'un token valide l'emprunte.
 *
 * La décision est déléguée à `isValidInternalToken` — la MÊME fonction que le
 * reste du service, comparaison à temps constant comprise. Le dépôt compte déjà
 * plusieurs implémentations divergentes de « ce token est-il valide ? » ; on
 * n'en ajoute pas une.
 */

const createError = require("http-errors");
const { isValidInternalToken } = require("./internalAuth");

function requireInternalWebhookCaller(req, _res, next) {
  if (isValidInternalToken(req)) return next();

  return next(
    createError(
      401,
      "Webhook non authentifié. Les prestataires doivent utiliser /webhooks/providers/:rail/:provider (signature HMAC)."
    )
  );
}

module.exports = requireInternalWebhookCaller;
module.exports.requireInternalWebhookCaller = requireInternalWebhookCaller;
