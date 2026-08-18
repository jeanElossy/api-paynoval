// File: routes/internalAdminTransactions.routes.js

"use strict";

const crypto = require("crypto");
const express = require("express");
const createError = require("http-errors");

const {
  listInternalAdminTransactions,
  getInternalAdminTransactionById,
  getInternalAdminUserStats,
} = require("../controllers/internalAdminTransactions.controller");

const {
  getInternalDashboardStats,
} = require("../controllers/internalDashboardStats.controller");

const {
  getInternalTreasuryAnalytics,
} = require("../controllers/internalTreasuryAnalytics.controller");

const {
  executeInternalAdminAdjustment,
} = require("../controllers/internalAdminAdjustments.controller");

const router = express.Router();

function getExpectedInternalToken() {
  return String(
    process.env.TX_CORE_INTERNAL_TOKEN ||
      process.env.INTERNAL_API_TOKEN ||
      process.env.PAYNOVAL_INTERNAL_TOKEN ||
      ""
  ).trim();
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));

  if (left.length !== right.length) return false;

  return crypto.timingSafeEqual(left, right);
}

function requireInternalToken(req, _res, next) {
  const expectedToken = getExpectedInternalToken();

  const receivedToken = String(
    req.headers["x-internal-token"] ||
      req.headers["x-paynoval-internal-token"] ||
      req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
      ""
  ).trim();

  console.log(
    "[TX-CORE][INTERNAL ADMIN TX][AUTH] Vérification token",
    JSON.stringify({
      path: req.originalUrl,
      method: req.method,
      expectedTokenPresent: !!expectedToken,
      expectedTokenLength: expectedToken.length,
      receivedTokenPresent: !!receivedToken,
      receivedTokenLength: receivedToken.length,
    })
  );

  if (!expectedToken) {
    return next(
      createError(
        500,
        "TX_CORE_INTERNAL_TOKEN manquant dans la configuration tx-core"
      )
    );
  }

  if (!receivedToken || !safeCompare(receivedToken, expectedToken)) {
    console.warn(
      "[TX-CORE][INTERNAL ADMIN TX][AUTH] Token interne invalide",
      JSON.stringify({
        path: req.originalUrl,
        method: req.method,
        receivedTokenPresent: !!receivedToken,
        receivedTokenLength: receivedToken.length,
      })
    );

    return next(createError(401, "Token interne invalide"));
  }

  console.log(
    "[TX-CORE][INTERNAL ADMIN TX][AUTH] Token interne OK",
    JSON.stringify({
      path: req.originalUrl,
      method: req.method,
    })
  );

  return next();
}

// Agrégats du tableau de bord. Monté AVANT `/internal/admin/transactions/:id`
// n'est pas nécessaire (chemins disjoints), mais on garde les routes de
// statistiques groupées en tête pour la lisibilité.
router.get(
  "/internal/admin/dashboard/stats",
  requireInternalToken,
  getInternalDashboardStats
);

/**
 * Grand livre et analytiques de trésorerie (frais, marge de change, parrainage).
 *
 * Un seul endpoint pour les quatre écrans : le paramètre `sections` permet à
 * chaque écran du back-office de ne déclencher que les agrégations dont il a
 * besoin, sans multiplier les allers-retours HTTP ni recalculer les trois
 * autres blocs à chaque appel.
 */
router.get(
  "/internal/admin/treasury/analytics",
  requireInternalToken,
  getInternalTreasuryAnalytics
);

router.get(
  "/internal/admin/transactions",
  requireInternalToken,
  listInternalAdminTransactions
);

router.get(
  "/internal/admin/transactions/:id",
  requireInternalToken,
  getInternalAdminTransactionById
);

/**
 * Indicateurs d'un compte, agrégés côté serveur.
 *
 * Monté ici et pas sous `/internal/admin/transactions/...` : le chemin décrit
 * la ressource observée (un utilisateur), pas la collection interrogée. Un
 * `/transactions/user/:id` aurait de plus été capté par la route `:id`
 * ci-dessus, qui aurait cherché une transaction nommée « user ».
 */
router.get(
  "/internal/admin/users/:id/stats",
  requireInternalToken,
  getInternalAdminUserStats
);

/**
 * Exécution d'un ajustement manuel de solde décidé au back-office.
 *
 * Route hébergée dans ce fichier plutôt que dans un routeur dédié afin de
 * réutiliser exactement `requireInternalToken` ci-dessus. Le dépôt compte déjà
 * trois implémentations distinctes du contrôle de token interne, chacune avec
 * sa propre chaîne de repli : en ajouter une quatrième pour l'unique route qui
 * déplace de l'argent sur décision humaine serait le pire endroit où introduire
 * un écart.
 *
 * POST /api/v1/internal/admin/adjustments/execute
 */
router.post(
  "/internal/admin/adjustments/execute",
  requireInternalToken,
  executeInternalAdminAdjustment
);

module.exports = router;