"use strict";

/**
 * Routes internes de parrainage — Tx-Core.
 *
 * ⚠️ CES ROUTES DÉPLACENT DE L'ARGENT. Elles ne sont accessibles qu'au backend
 * principal, porteur du jeton `PRINCIPAL_INTERNAL_TOKEN`, comparé en timing-safe
 * par `requireInternalAuth`. Ce middleware échoue en FERMETURE : si aucun jeton
 * n'est configuré côté serveur, il répond 500 au lieu de laisser passer.
 *
 * L'ancienne version ne portait aucun middleware : le contrôle vivait dans le
 * contrôleur, avec une comparaison `===` sensible aux attaques temporelles, et
 * rien n'aurait empêché une nouvelle route d'être ajoutée sans contrôle du tout.
 */

const express = require("express");
const router = express.Router();

const requireInternalAuth = require("../middleware/internalAuth");

const {
  transferBonus,
  getActivity,
} = require("../controllers/internalReferralController");

// POST /api/v1/internal/referral/activity
router.post("/activity", requireInternalAuth("principal"), getActivity);

// POST /api/v1/internal/referral/transfer-bonus
router.post("/transfer-bonus", requireInternalAuth("principal"), transferBonus);

module.exports = router;
