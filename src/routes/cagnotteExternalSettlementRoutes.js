"use strict";

/**
 * Règlement d'une participation à une cagnotte par LIEN PUBLIC.
 *
 * Échange strictement service-à-service : le backend principal appelle cette
 * route sur le réseau privé, APRÈS avoir authentifié le rappel prestataire.
 * Elle ne doit jamais être proxifiée vers Internet — voir le commentaire de
 * `PRINCIPAL_PREFIXES` dans `api-gateway/src/app.js`, qui explique pourquoi les
 * routes de parrainage en ont été retirées pour exactement cette raison.
 */

const express = require("express");
const { body, validationResult } = require("express-validator");
const {
  extractInternalToken,
  matchesAnyToken,
} = require("../utils/internalTokens");
const {
  settleExternalParticipation,
  quoteExternalParticipation,
} = require("../controllers/cagnotteExternalSettlementController");

const router = express.Router();

/**
 * Comparaison en TEMPS CONSTANT, via l'implémentation unique du service
 * (`utils/internalTokens`). Le dépôt a compté jusqu'à quatre façons de répondre
 * à « ce jeton est-il valide ? » — ce qui garantissait qu'elles divergeraient.
 * Ne pas en ajouter une cinquième ici.
 */
function verifyInternalToken(req, res, next) {
  const expected = String(
    process.env.TX_CORE_INTERNAL_TOKEN ||
      process.env.INTERNAL_TX_TOKEN ||
      process.env.INTERNAL_TOKEN ||
      ""
  ).trim();

  if (!expected) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_INTERNAL_TOKEN non configuré.",
    });
  }

  if (!matchesAnyToken(extractInternalToken(req), [expected])) {
    return res.status(401).json({ success: false, error: "Non autorisé." });
  }

  return next();
}

function checkValidation(req, res, next) {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  return next();
}

/**
 * ⚠️ LE CHEMIN EST `/external-participation/settle`, PAS `/participation/settle`.
 *
 * Ce routeur est monté sur `/api/v1/cagnotte`, EXACTEMENT comme
 * `cagnotteSettlementRoutes`, qui déclare déjà `/participation/settle` et qui
 * est monté AVANT lui (`server.js:1280` contre `server.js:1289`). Express rend
 * la main au premier routeur qui apparie : avec le même sous-chemin, ce
 * règlement-ci n'aurait JAMAIS été atteint, et un appel destiné à une
 * participation externe serait tombé sur le règlement authentifié — qui exige
 * `userId` et `payer`, absents ici par nature.
 *
 * Le défaut ne se voyait pas au montage : `app.use` ne signale aucune collision,
 * les deux routeurs se chargent sans erreur, et les journaux de démarrage
 * annoncent les deux. Il ne se serait manifesté qu'au premier encaissement par
 * lien public, en 400 sur un champ manquant — c'est-à-dire au pire moment.
 */
router.post(
  "/external-participation/settle",
  verifyInternalToken,

  body("reference").exists().isString().trim().isLength({ min: 8, max: 200 }),
  body("idempotencyKey").exists().isString().trim().isLength({ min: 8, max: 200 }),

  /**
   * `rail` et `provider` ne sont PAS optionnels et n'ont pas de défaut : le rail
   * désigne le compte de compensation d'entrée, donc le relevé prestataire
   * auquel ce règlement devra être rapproché. Les valider ici évite un
   * aller-retour, mais le contrôleur les revalide contre sa table close — la
   * validation d'entrée dit la forme, la table close dit le périmètre.
   */
  body("rail").exists().isString().trim().notEmpty(),
  body("provider").exists().isString().trim().notEmpty(),
  body("providerReference").optional().isString().trim(),

  body("cagnotteId").exists().isString().trim().notEmpty(),
  // Le coffre est désormais OBLIGATOIRE : c'est sa position qui est créditée.
  body("vaultId").exists().isString().trim().notEmpty(),
  body("cagnotteCurrency").exists().isString().trim().isLength({ min: 3, max: 3 }).toUpperCase(),

  body("collected.amount").exists().isFloat({ gt: 0 }).toFloat(),
  body("collected.currency").exists().isString().trim().isLength({ min: 3, max: 3 }).toUpperCase(),

  // Frais et conversion sont calculés par Tx-Core : aucun montant de frais
  // n'est lu dans le corps.
  body("country").optional().isString().trim().isLength({ max: 60 }),

  checkValidation,
  settleExternalParticipation
);

router.post(
  "/external-participation/quote",
  verifyInternalToken,
  body("cagnotteId").exists().isString().trim().notEmpty(),
  body("cagnotteCurrency").exists().isString().trim().isLength({ min: 3, max: 3 }).toUpperCase(),
  body("currency").optional().isString().trim().isLength({ min: 3, max: 3 }).toUpperCase(),
  body("amount").exists().isFloat({ gt: 0 }).toFloat(),
  body("rail").exists().isString().trim().notEmpty(),
  body("provider").exists().isString().trim().notEmpty(),
  checkValidation,
  quoteExternalParticipation
);

module.exports = router;
