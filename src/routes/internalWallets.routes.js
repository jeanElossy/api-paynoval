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

router.post("/wallets/ensure", internalProtect, ensureWallet);

module.exports = router;
