"use strict";

/**
 * /api/v1/limit-policies — gouvernance des plafonds (2026-10-17).
 *
 * Interne uniquement (`internalProtect`) : la passerelle relaie les appels du
 * back-office après contrôle du rôle, et Tx-Core RECONTRÔLE le rôle de
 * l'agent, relu en base (`limitPolicyService.assertLimitStaff`) — un jeton
 * interne seul ne change aucun plafond.
 */

const express = require("express");
const { param, body } = require("express-validator");

const { internalProtect } = require("../middleware/authMiddleware");
const requestValidator = require("../middleware/requestValidator");
const ctrl = require("../controllers/limitsController");

const router = express.Router();

const version = param("version").isInt({ min: 1 }).toInt();

router.get("/", internalProtect, ctrl.listPolicies);

router.post(
  "/",
  internalProtect,
  body("limits").isObject().withMessage("Politique requise."),
  body("reason").isString().trim().isLength({ min: 10, max: 1000 }).withMessage("Motif de 10 à 1000 caractères."),
  requestValidator,
  ctrl.proposePolicy
);

router.post("/:version/approve", internalProtect, version, requestValidator, ctrl.approvePolicy);

router.post(
  "/:version/reject",
  internalProtect,
  version,
  body("reason").isString().trim().isLength({ min: 5, max: 1000 }).withMessage("Motif de rejet requis."),
  requestValidator,
  ctrl.rejectPolicy
);

module.exports = router;
