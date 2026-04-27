// File: src/services/handlers/providerWebhookTransactions.js
"use strict";

/**
 * Proxy legacy.
 *
 * Ce fichier ne doit plus contenir la logique de settlement.
 * Il redirige vers le settlement controller unique pour éviter :
 * - deux flows différents,
 * - deux traitements SUCCESS / FAILED,
 * - des webhooks qui passent par une ancienne logique non sécurisée.
 */

module.exports = require("../../../controllers/externalSettlementController");