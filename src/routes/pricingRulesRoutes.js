"use strict";

/**
 * Barèmes — lecture seule — déplacé depuis l'API Gateway le 2026-09-10.
 *
 * ── Qui appelle, et qui autorise ────────────────────────────────────────────
 *
 * La PASSERELLE, et elle seule. C'est elle qui expose ces chemins au monde,
 * qui vérifie le jeton de session et qui contrôle le RÔLE de l'appelant. Puis
 * elle relaie ici sur le canal interne.
 *
 * Tx-Core ne revérifie pas de session : il fait confiance au canal, ce qui
 * n'est légitime que parce que `internalProtect` l'authentifie. C'est le
 * partage de responsabilité de Stripe et d'Adyen — le bord prouve l'identité
 * et le droit, le moteur exécute.
 *
 * ⚠️ Corollaire à ne pas perdre de vue : si la passerelle cessait de contrôler
 * le rôle, ces routes deviendraient accessibles à tout porteur du jeton
 * interne. Le contrôle de rôle du bord n'est pas décoratif, il est la moitié
 * de cette garde. Verrouillé par `test/pricingOwnership.test.js`.
 */

const router = require("express").Router();
const { internalProtect } = require("../middleware/authMiddleware");

const {
  listPricingRules,
  getPricingRuleById,
  listPricingRuleVersions,
  listCoverageGaps,
} = require("../controllers/pricing/pricingRulesController");

/**
 * ⚠️ LECTURE SEULE — VOLONTAIREMENT, et cela n'a pas changé au déplacement.
 *
 * POST, PUT, PATCH et DELETE avaient été retirés côté passerelle : toute
 * évolution tarifaire passe par `/api/v1/pricing-change-requests`, qui impose
 * un second valideur et écrit une version immuable. Tant que ces verbes
 * existaient, la gouvernance se contournait en un appel.
 *
 * Ne pas les rétablir « temporairement ».
 */
router.get("/", internalProtect, listPricingRules);
router.get("/coverage-gaps", internalProtect, listCoverageGaps);
router.get("/:id", internalProtect, getPricingRuleById);
router.get("/:id/versions", internalProtect, listPricingRuleVersions);

module.exports = router;
