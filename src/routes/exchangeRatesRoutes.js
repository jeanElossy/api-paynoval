"use strict";

/**
 * Taux de change — déplacé depuis l'API Gateway le 2026-09-10.
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

const ctrl = require("../controllers/pricing/exchangeRatesController");

/**
 * `/rate` était SANS authentification côté passerelle — c'est le taux affiché
 * au mobile avant connexion. Il reste ouvert au monde PAR LA PASSERELLE, qui
 * le sert derrière sa signature publique et son limiteur de débit ; ici, sur le
 * réseau privé, le jeton interne s'applique comme aux autres.
 */
router.get("/rate", internalProtect, ctrl.getRatePublic);

router.get("/", internalProtect, ctrl.listRates);
router.post("/", internalProtect, ctrl.createRate);
router.put("/:id", internalProtect, ctrl.updateRate);
router.delete("/:id", internalProtect, ctrl.deleteRate);

module.exports = router;
