"use strict";

/**
 * Routes du mode simulation — `/api/v1/sandbox`.
 *
 * - `/3ds/:token` : la passerelle seule (jeton de service), sans identité
 *   utilisateur — le navigateur intégré n'a pas le JWT. Le jeton à usage
 *   unique de l'URL est l'autorisation.
 * - le reste : JWT + compte sandbox (404 pour un compte réel). La simulation
 *   fermée (`SANDBOX_MODE_ENABLED`) est refusée dès `protect`.
 */

const express = require("express");

const { protect } = require("../middleware/authMiddleware");
const requireInternalAuth = require("../middleware/internalAuth");
const controller = require("../controllers/sandboxController");
const rateLimit = require("express-rate-limit");

const router = express.Router();

/**
 * Par COMPTE : tout arrive de la passerelle, une clé par adresse ferait partager
 * le même compteur à tous les partenaires. Posés après `protect`.
 */
const perAccount = (name, max) =>
  rateLimit({
    name,
    windowMs: 60 * 1000,
    max,
    keyGenerator: (req) => String(req.user?._id || req.user?.id),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, status: 429, message: "Trop de requêtes, veuillez réessayer plus tard." },
  });

// Même seuil que `/confirm` : cette route vérifie une réponse de sécurité.
const confirmLimiter = perAccount("sandbox-confirm", 10);
const toolsLimiter = perAccount("sandbox-tools", 20);

router.get("/3ds/:token", requireInternalAuth("gateway"), controller.getThreeDSChallenge);
router.post(
  "/3ds/:token/decision",
  requireInternalAuth("gateway"),
  controller.submitThreeDSDecision
);

router.use(protect, controller.requireSandboxAccount);

router.get("/state", controller.getState);
router.put("/scenario", controller.updateScenario);
router.post("/faucet", toolsLimiter, controller.faucet);
router.post("/drain", toolsLimiter, controller.drain);
router.post("/reset", toolsLimiter, controller.reset);
router.get("/transfers/pending", controller.listPendingTransfers);
router.post("/transfers/:id/confirm", confirmLimiter, controller.confirmAsRecipient);

module.exports = router;
