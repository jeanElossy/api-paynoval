// File: controllers/internalAdminAdjustments.controller.js

"use strict";

/**
 * Exécution des ajustements manuels de solde — route interne.
 *
 * Contrôleur volontairement mince : il traduit HTTP ↔ service et rien d'autre.
 * Toute la logique financière (double écriture, idempotence, contrepartie) vit
 * dans `services/adminAdjustmentExecutionService.js`.
 *
 * Appelant unique : le backend principal, une fois la demande d'ajustement
 * doublement validée. La séparation demandeur / valideur est appliquée là-bas ;
 * le TX Core ne peut pas la vérifier, il ne connaît pas les comptes du
 * back-office. Ce que le TX Core garantit, c'est qu'une décision transmise deux
 * fois ne déplace de l'argent qu'une seule fois.
 */

const {
  executeAdminAdjustment,
} = require("../services/adminAdjustmentExecutionService");

async function executeInternalAdminAdjustment(req, res, next) {
  try {
    const result = await executeAdminAdjustment(req.body || {});

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  executeInternalAdminAdjustment,
};
