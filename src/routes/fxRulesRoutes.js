"use strict";

/**
 * Règles de marge de change — LECTURE SEULE — déplacé depuis l'API Gateway le 2026-09-10.
 *
 * ── Qui appelle, et qui autorise ────────────────────────────────────────────
 *
 * La PASSERELLE, et elle seule. C'est elle qui expose ces chemins au monde,
 * qui vérifie le jeton de session et qui contrôle le RÔLE de l'appelant. Puis
 * elle relaie ici sur le canal interne.
 *
 * Tx-Core ne revérifie pas de session : il fait confiance au canal, ce qui
 * n'est légitime que parce que `internalProtect` l'authentifie.
 *
 * ⚠️ Corollaire : si la passerelle cessait de contrôler le rôle, ces routes
 * deviendraient accessibles à tout porteur du jeton interne. Verrouillé par
 * `test/pricingOwnership.test.js`.
 *
 * ============================================================================
 * L'ÉCRITURE EST RETIRÉE — 410 GONE (2026-09-16)
 * ============================================================================
 *
 * ⚠️ MESURE DU 2026-09-16 : la collection `FxRule` N'A PLUS AUCUN CONSOMMATEUR.
 * `services/pricing/fxRulesService.js` n'est appelé que par le contrôleur
 * d'administration de `FxRule` lui-même — c'est-à-dire par personne d'utile. Le
 * moteur de tarification lit la marge de change dans `PricingRule.fx`, jamais
 * ici.
 *
 * Écrire dans cette collection ne changeait donc RIEN aux prix, tout en
 * répondant succès. La lecture reste servie pour que l'on puisse constater ce
 * que la base contient encore.
 */

const router = require("express").Router();
const { internalProtect } = require("../middleware/authMiddleware");

const ctrl = require("../controllers/pricing/fxRulesController");
const { routeRetiree } = require("./pricingDeprecation");

const gone = routeRetiree({
  code: "FX_RULES_WRITE_REMOVED",
  quoi:
    "Les règles de marge de change ne se modifient plus par cette route — " +
    "et cette collection n'était plus lue par aucun calcul de prix.",
});

router.get("/", internalProtect, ctrl.list);
router.get("/:id", internalProtect, ctrl.getById);

/* ── Écritures retirées ──────────────────────────────────────────────────── */
router.post("/", internalProtect, gone);
router.put("/:id", internalProtect, gone);
router.patch("/:id", internalProtect, gone);
router.delete("/:id", internalProtect, gone);

module.exports = router;
