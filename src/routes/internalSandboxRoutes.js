"use strict";

/**
 * Provisionnement des comptes de simulation — `/api/v1/internal/sandbox`.
 * Appelé par le backend principal (jeton de service, `internalProtect`) : c'est lui qui crée
 * le compte, Tx-Core ouvre le portefeuille et le crédite par le grand livre.
 */

const express = require("express");

const { internalProtect } = require("../middleware/authMiddleware");
const controller = require("../controllers/sandboxController");

const router = express.Router();

// Même garde que les autres appels du principal (`/internal/wallets/ensure`).
router.use(internalProtect);

router.post("/accounts/:userId/provision", controller.provisionAccount);
router.post("/treasuries/provision", controller.provisionTreasuries);

// Back-office : les mêmes outils que le monteur, sur le compte désigné.
router.get("/accounts/:userId/state", controller.adminGetState);
router.put("/accounts/:userId/scenario", controller.adminUpdateScenario);
router.post("/accounts/:userId/reset", controller.adminReset);
router.post("/accounts/:userId/dataset", controller.applyDataset);

module.exports = router;
