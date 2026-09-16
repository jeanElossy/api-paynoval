"use strict";

/**
 * Taux de change — LECTURE — déplacé depuis l'API Gateway le 2026-09-10.
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
 * ⚠️ LE PIÈGE LE PLUS COÛTEUX DES TROIS, ET IL ÉTAIT SILENCIEUX.
 *
 * Un « taux personnalisé » (`active: true`) écrit ici n'entrait dans AUCUN
 * devis : `quoteService` appelle `getExchangeRate()` en mode `live`, qui
 * interroge le marché. Le taux personnalisé n'était lu que par
 * `/exchange-rates/rate?mode=effective`, c'est-à-dire par un affichage.
 *
 * L'écran « Devises » du back-office laissait donc un administrateur croire
 * qu'il fixait le taux appliqué aux transactions, confirmation de succès à
 * l'appui. Il ne fixait rien.
 *
 * La marge de change se décide dans `PricingRule.fx` (modes `MARKUP_PERCENT`,
 * `OVERRIDE`, `DELTA_*`), par le circuit gouverné.
 */

const router = require("express").Router();
const { internalProtect } = require("../middleware/authMiddleware");

const ctrl = require("../controllers/pricing/exchangeRatesController");
const { routeRetiree } = require("./pricingDeprecation");

const gone = routeRetiree({
  code: "EXCHANGE_RATES_WRITE_REMOVED",
  quoi:
    "Les taux personnalisés ne se modifient plus par cette route — et ils " +
    "n'ont jamais été appliqués aux transactions : le devis interroge le marché.",
});

/**
 * `/rate` était SANS authentification côté passerelle — c'est le taux affiché
 * au mobile avant connexion. Il reste ouvert au monde PAR LA PASSERELLE, qui
 * le sert derrière sa signature publique et son limiteur de débit ; ici, sur le
 * réseau privé, le jeton interne s'applique comme aux autres.
 */
router.get("/rate", internalProtect, ctrl.getRatePublic);

router.get("/", internalProtect, ctrl.listRates);

/* ── Écritures retirées ──────────────────────────────────────────────────── */
router.post("/", internalProtect, gone);
router.put("/:id", internalProtect, gone);
router.delete("/:id", internalProtect, gone);

module.exports = router;
