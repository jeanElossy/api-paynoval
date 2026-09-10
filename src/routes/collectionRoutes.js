"use strict";

/**
 * Encaissements entrants — l'argent qui ENTRE.
 *
 * Échange service-à-service : la passerelle appelle cette route pour le compte
 * d'un payeur qui n'a pas de compte PayNoval. Le jeton interne est exigé, et
 * comparé en temps constant par l'implémentation unique du service.
 */

const express = require("express");
const { body, validationResult } = require("express-validator");
const {
  extractInternalToken,
  matchesAnyToken,
} = require("../utils/internalTokens");
const { initiate } = require("../controllers/collectionIntentController");
const publicCollectionAml = require("../middleware/publicCollectionAml");

const router = express.Router();

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

router.post(
  "/initiate",
  verifyInternalToken,

  body("rail").exists().isString().trim().notEmpty(),
  body("provider").exists().isString().trim().notEmpty(),
  body("purpose").exists().isString().trim().notEmpty(),
  body("amount").exists().isFloat({ gt: 0 }).toFloat(),
  body("currency").exists().isString().trim().isLength({ min: 3, max: 4 }),

  /**
   * ⚠️ Aucune validation de `cardNumber`, `cvc` ou `pan` — pas même pour les
   * refuser ici. Le refus est porté par `assertAucuneDonneeCarte`, qui balaie la
   * charge utile À TOUTE PROFONDEUR : un contrôle par champ nommé se contourne
   * en emballant la donnée dans un sous-objet, ce que faisait déjà l'adaptateur
   * avec `source.pan`.
   */
  body("cardToken").optional().isString().trim().isLength({ max: 512 }),

  checkValidation,

  /**
   * ⚠️ LE CRIBLAGE VIENT APRÈS `checkValidation`, ET C'EST DÉLIBÉRÉ.
   *
   * Cribler un montant ou un pays qu'on n'a pas encore validés reviendrait à
   * envoyer des champs non contraints à un fournisseur de conformité externe.
   * L'ordre « forme d'abord, décision ensuite » est le même qu'au bord pour les
   * données de carte.
   *
   * Ce contrôle a vécu dans `api-gateway/src/middlewares/publicCollectionAml.js`
   * jusqu'au 2026-09-10. Il est ici parce qu'un contrôle de conformité au bord
   * ne protège que ce qui passe par le bord — verrouillé par
   * `test/security/amlLivesInTxCore.test.js`.
   */
  publicCollectionAml,

  initiate
);

module.exports = router;
