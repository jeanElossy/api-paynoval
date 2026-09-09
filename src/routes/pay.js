// src/routes/pay.js
"use strict";

/**
 * CHEMIN RETIRÉ — `POST /api/v1/pay`
 * ============================================================================
 *
 * Cette route déplaçait de l'argent SANS PASSER PAR LE GRAND LIVRE.
 *
 * Ce qu'elle faisait (jusqu'au 2026-09-03) : elle appelait `debitUser` puis
 * `creditUserByEmail` de `src/services/transactions.js`, qui écrivent
 * directement sur `TxWalletBalance`. Aucune écriture de `LedgerEntry`, aucun
 * `idempotency()` monté, aucun `assertTransition`, aucun devis — devise codée
 * en dur `'F CFA'`, `exchangeRate: 1`, et `Math.random()` pour la référence.
 * Elle violait simultanément les invariants 2 (le grand livre fait foi),
 * 3 (idempotence), 4 (auditabilité) et 12 (Tx Core, moteur unique).
 *
 * ── Pourquoi elle n'avait encore rien cassé ───────────────────────────────
 *
 * Uniquement parce qu'elle était cassée en TROIS endroits indépendants et
 * sortait en 500 avant la première écriture :
 *   1. `findBalanceByUserId(user._id)` appelée sans devise → « Devise invalide ».
 *   2. `debitUser(id, amount, 'Paiement marchand', …)` — la signature est
 *      `(userId, currency, amount, reason, opts)` : le montant passait comme
 *      devise → « Montant invalide ».
 *   3. `require('../models/Transaction')` rend une FABRIQUE `(conn) => model`,
 *      pas un modèle : `Transaction.create` était `undefined`.
 *
 * Autrement dit, elle ressemblait à un bug d'une ligne. Sa correction « évidente »
 * aurait créé, en trois lignes, un transfert de portefeuille à portefeuille
 * invisible du grand livre, de la machine à états et de l'idempotence.
 *
 * ── Ce qui la rendait atteignable ─────────────────────────────────────────
 *
 * La passerelle poste les paiements sur `${SERVICE_PAYNOVAL_URL}/pay`
 * (`api-gateway/controllers/paymentController.js:26`), et `SERVICE_PAYNOVAL_URL`
 * DÉSIGNE Tx Core (`docs/load/bench/env.sh:91,93` : même valeur que
 * `TRANSACTIONS_SERVICE_URL`). Seul le préfixe `/api/v1` séparait le paiement
 * public des cagnottes de ce chemin sans grand livre. Un préfixe n'est pas une
 * barrière.
 *
 * ── Traitement retenu ─────────────────────────────────────────────────────
 *
 * On ne supprime pas (règle : corriger, pas retirer), on échoue en FERMETURE —
 * même traitement que le webhook hérité de `transactionsRoutes.js:1377-1387`.
 * Un appel est REFUSÉ et JOURNALISÉ : quelqu'un qui vise un chemin d'argent
 * retiré doit être visible, pas silencieux.
 *
 * Le chemin légitime est `POST /api/v1/transactions/initiate`, qui passe par
 * la machine à états, l'idempotence, le devis et `ledgerService`.
 */

const express = require("express");
const logger = require("../utils/logger");

const router = express.Router();

router.all("/", (req, res) => {
  logger.error(
    "[PAY] appel sur un chemin d'argent RETIRÉ — refusé. " +
      "Ce chemin déplaçait des fonds sans écriture au grand livre. " +
      "Utiliser POST /api/v1/transactions/initiate.",
    {
      method: req.method,
      userId: req.user?._id ? String(req.user._id) : null,
      requestId: req.id || req.headers["x-request-id"] || null,
    }
  );

  return res.status(410).json({
    success: false,
    code: "PAY_ROUTE_REMOVED",
    error:
      "Ce chemin de paiement a été retiré : il déplaçait des fonds sans " +
      "écriture au grand livre. Utiliser POST /api/v1/transactions/initiate.",
  });
});

module.exports = router;
