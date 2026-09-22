"use strict";

/**
 * Provisionnement de portefeuille — échange service-à-service.
 *
 * Monté dans `server.js` via `app.use("/api/v1/internal", internalWalletRoutes)`
 * ⇒ `POST /api/v1/internal/wallets/ensure`.
 *
 * ⚠️ Aucune route ne doit accepter de MONTANT ici. Créditer un portefeuille est
 * un mouvement d'argent : il passe par le grand livre, pas par une route de
 * provisionnement.
 */

const router = require("express").Router();
const { internalProtect } = require("../middleware/authMiddleware");
const { ensureWallet } = require("../controllers/internalWallets.controller");
const { ensureTreasury } = require("../controllers/internalTreasuries.controller");

router.post("/wallets/ensure", internalProtect, ensureWallet);

/**
 * `POST /api/v1/internal/treasuries/ensure` — le backend DEMANDE l'ouverture
 * d'un compte interne ; Tx-Core l'écrit. Fin du second écrivain sur
 * `txsystembalances` (2026-09-22). À zéro, sans aucun montant.
 */
router.post("/treasuries/ensure", internalProtect, ensureTreasury);

module.exports = router;
