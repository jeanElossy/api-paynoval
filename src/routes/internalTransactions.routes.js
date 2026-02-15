"use strict";

const router = require("express").Router();
const { internalProtect } = require("../middleware/authMiddleware");
const ctrl = require("../controllers/internalTransactions.controller");

// Monté dans server.js via:
// app.use("/api/v1/internal", internalTxRoutes);
// => POST /api/v1/internal/transactions/import
router.post("/transactions/import", internalProtect, ctrl.importTransaction);

module.exports = router;
