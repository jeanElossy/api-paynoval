"use strict";

const router = require("express").Router();
const { internalProtect } = require("../middleware/authMiddleware");
const ctrl = require("../controllers/internalTransactions.controller");

// Base path recommandé côté app : app.use("/internal", router)
// => POST /internal/transactions/import
router.post("/transactions/import", internalProtect, ctrl.importTransaction);

module.exports = router;
