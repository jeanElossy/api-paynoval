"use strict";

/**
 * Frais — SIMULATION ET LECTURE — déplacé depuis l'API Gateway le 2026-09-10.
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
 * de cette garde. Verrouillé par `test/pricingOwnership.test.js` — qui, lui,
 * a réellement été écrit le 2026-09-16 : les cinq fichiers de routes le
 * citaient depuis le déplacement, et il n'existait pas.
 *
 * ============================================================================
 * L'ÉCRITURE EST RETIRÉE — 410 GONE (2026-09-16)
 * ============================================================================
 *
 * La collection `Fee` n'alimente PLUS les prix prélevés. Les frais appliqués
 * viennent de `PricingRule`, et d'elle seule, par le circuit gouverné
 * (`/api/v1/pricing-change-requests` : second valideur, version immuable).
 *
 * `/fees/simulate` reste servi, mais c'est déjà un ADAPTATEUR au-dessus du
 * moteur de tarification : il lit `PricingRule`, pas `Fee`.
 *
 * ── Pourquoi 410 plutôt qu'une suppression ──────────────────────────────────
 *
 * Le danger n'était pas que ces écritures soient inutiles : c'est qu'elles
 * RÉPONDAIENT SUCCÈS. Un administrateur baissait un barème, recevait une
 * confirmation, et pas un seul client n'était facturé différemment.
 *
 * Un 404 serait indiscernable d'une faute de frappe. `410 Gone` dit « cela a
 * existé, c'est parti, voici où » — ce que font Stripe, PayPal et Wise de
 * leurs points d'entrée retirés : la réponse ENSEIGNE au lieu de disparaître.
 * Les en-têtes suivent la RFC 8594, pour qu'un outil le lise aussi.
 *
 * ⚠️ NE PAS RÉTABLIR CES ÉCRITURES. Deux sources de vérité sur un prix, c'est
 * un client facturé autrement que ce qui lui a été annoncé.
 */

const router = require("express").Router();
const { internalProtect } = require("../middleware/authMiddleware");

const feesCtrl = require("../controllers/pricing/feesController");
const { routeRetiree } = require("./pricingDeprecation");

const gone = routeRetiree({
  code: "FEES_WRITE_REMOVED",
  quoi: "Les barèmes de frais ne se modifient plus par cette route.",
});

/** Simulation : lecture, servie aussi au public via le relais de la passerelle. */
router.get("/simulate", internalProtect, feesCtrl.simulateFee);

router.get("/", internalProtect, feesCtrl.getFees);
router.get("/:id", internalProtect, feesCtrl.getFeeById);

/* ── Écritures retirées ──────────────────────────────────────────────────── */
router.post("/", internalProtect, gone);
router.put("/:id", internalProtect, gone);
router.patch("/:id", internalProtect, gone);
router.delete("/:id", internalProtect, gone);

module.exports = router;
