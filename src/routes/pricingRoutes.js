"use strict";

/**
 * Tarification — `POST/GET /api/v1/pricing/quote` et `POST /api/v1/pricing/lock`.
 *
 * ── Qui appelle ces routes ──────────────────────────────────────────────────
 *
 * La PASSERELLE, et elle seule. Elle expose `/api/v1/pricing/*` au monde,
 * authentifie, limite le débit, puis relaie ici sur le canal interne.
 *
 * ⚠️ Tx-Core lui-même n'appelle PAS ces routes : depuis le 2026-09-10 il
 * utilise `services/pricing/quoteService` en direct. Le devis n'est plus un
 * saut réseau sur le chemin de l'argent, et le moteur ne dépend plus du bord.
 *
 * Le jeton interne est exigé sur les deux : ces routes lisent `x-user-id` pour
 * le verrou, en-tête qui ne vaut que si le canal est authentifié.
 */

const router = require("express").Router();
const { internalProtect } = require("../middleware/authMiddleware");
const pricing = require("../controllers/pricingController");

router.get("/quote", internalProtect, pricing.quote);
router.post("/quote", internalProtect, pricing.quote);

/** Alias historique servi par la passerelle. Même traitement. */
router.get("/preview", internalProtect, pricing.quote);
router.post("/preview", internalProtect, pricing.quote);

router.post("/lock", internalProtect, pricing.lock);

module.exports = router;
