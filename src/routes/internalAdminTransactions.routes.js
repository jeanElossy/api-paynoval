// File: routes/internalAdminTransactions.routes.js

"use strict";

const express = require("express");
const createError = require("http-errors");

const {
  extractInternalToken,
  matchesAnyToken,
  expectedInternalTokens,
  NOMS_JETON_INTERNE,
} = require("../utils/internalTokens");

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

const {
  listComplianceCases,
} = require("../controllers/internalAdminCompliance.controller");

const { listAmlLogs } = require("../controllers/internalAdminAmlLogs.controller");

const router = express.Router();

/**
 * ⚠️ CE FICHIER A EU SA PROPRE RÉPONSE À « CE JETON EST-IL VALIDE ? ».
 *
 * Elle lisait `TX_CORE_INTERNAL_TOKEN → INTERNAL_API_TOKEN →
 * PAYNOVAL_INTERNAL_TOKEN`. Aucune des trois n'est posée : la seule variable
 * configurée, et celle que la passerelle envoie, est `INTERNAL_TOKEN`. Toutes
 * les routes de ce fichier — tableau de bord, trésorerie, transactions,
 * statistiques utilisateur, ajustements — rendaient donc **500** sur chaque
 * appel, avec un message accusant une variable d'environnement plutôt que la
 * divergence qui l'avait produit.
 *
 * La comparaison passe désormais par `utils/internalTokens`, seule
 * implémentation du dépôt. Ne pas en réintroduire une sixième ici.
 *
 * Les journaux de vérification ont disparu avec elle : ils imprimaient
 * `expectedTokenLength` et `receivedTokenLength` à chaque appel. La longueur
 * d'un secret n'est pas le secret, mais elle le rétrécit — et une trace par
 * requête sur une route admin n'apporte rien qu'un compteur d'échecs ne dise
 * mieux (règle B.4).
 */
function requireInternalToken(req, _res, next) {
  const attendus = expectedInternalTokens();

  if (!attendus.length) {
    return next(
      createError(
        500,
        "Aucun jeton interne configuré (" +
          NOMS_JETON_INTERNE.join(", ") +
          ") — les routes internes ne peuvent pas authentifier l'appelant."
      )
    );
  }

  /**
   * `Authorization: Bearer` reste accepté : le backend principal l'utilise sur
   * certains appels hérités. `extractInternalToken` ne lit que
   * `x-internal-token`, on complète donc ici plutôt que d'élargir l'utilitaire
   * pour tout le monde.
   */
  const presente =
    extractInternalToken(req) ||
    String(req.headers["x-paynoval-internal-token"] || "").trim() ||
    String(req.headers["authorization"] || "")
      .replace(/^Bearer\s+/i, "")
      .trim();

  if (!matchesAnyToken(presente, attendus)) {
    return next(createError(401, "Token interne invalide"));
  }

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

/* -------------------------------------------------------------------------- */
/* Conformité — back-office                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Ces deux routes remplacent des surfaces qui vivaient dans la passerelle :
 *
 *   · `controllers/adminCompliance.controller.js` — qui appelait ici une route
 *     inexistante, prenait un 404, et se repliait en silence sur un filtrage
 *     en mémoire des 500 dernières transactions ;
 *   · `routes/aml.js` — qui lisait un `AMLLog` de la base de la passerelle,
 *     lequel cesse d'être alimenté maintenant que l'AML vit ici.
 *
 * Elles sont dans Tx-Core parce que c'est lui qui écrit le journal. Une surface
 * de lecture séparée du service qui produit la donnée finit toujours par lire
 * autre chose que ce qui a été écrit.
 */
router.get(
  "/internal/admin/compliance/transactions",
  requireInternalToken,
  listComplianceCases
);

router.get("/internal/admin/aml/logs", requireInternalToken, listAmlLogs);

module.exports = router;
