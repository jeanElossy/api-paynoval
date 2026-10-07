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

module.exports = router;
