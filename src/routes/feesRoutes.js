"use strict";

/**
 * Frais — administration et simulation — déplacé depuis l'API Gateway le 2026-09-10.
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

const feesCtrl = require("../controllers/pricing/feesController");

/** Simulation : lecture, servie aussi au public via le relais de la passerelle. */
router.get("/simulate", internalProtect, feesCtrl.simulateFee);

router.get("/", internalProtect, feesCtrl.getFees);
router.get("/:id", internalProtect, feesCtrl.getFeeById);
router.post("/", internalProtect, feesCtrl.createFee);
router.put("/:id", internalProtect, feesCtrl.updateFee);
router.patch("/:id", internalProtect, feesCtrl.updateFee);
router.delete("/:id", internalProtect, feesCtrl.deleteFee);

module.exports = router;
