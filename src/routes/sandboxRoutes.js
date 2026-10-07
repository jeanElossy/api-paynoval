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

const router = express.Router();

router.get("/3ds/:token", requireInternalAuth("gateway"), controller.getThreeDSChallenge);
router.post(
  "/3ds/:token/decision",
  requireInternalAuth("gateway"),
  controller.submitThreeDSDecision
);

router.use(protect, controller.requireSandboxAccount);

router.get("/state", controller.getState);
router.put("/scenario", controller.updateScenario);
router.post("/faucet", controller.faucet);
router.post("/drain", controller.drain);
router.post("/reset", controller.reset);

module.exports = router;
