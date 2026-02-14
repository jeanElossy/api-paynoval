"use strict";
const router = require("express").Router();
const { internalProtect } = require("../middleware/authMiddleware");
const ctrl = require("../controllers/internalTransactions.controller");

router.post("/transactions/import", internalProtect, ctrl.importTransaction);

module.exports = router;
