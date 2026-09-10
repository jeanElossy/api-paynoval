#!/usr/bin/env node
"use strict";

/**
 * ============================================================================
 * SERVICE DE RÉCONCILIATION ÉVÉNEMENTIELLE — POINT D'ENTRÉE
 * ============================================================================
 *
 * La branche `Settlement` du schéma cible, dans son propre processus.
 *
 * ── Ce qu'il apporte ────────────────────────────────────────────────────────
 *
 * La réconciliation tournait uniquement sur MINUTERIE : un écart entre une
 * transaction et le grand livre attendait le prochain balayage, soit plusieurs
 * heures pendant lesquelles un solde s'affichait sans écritures pour le
 * justifier. Ici, la vérification suit la confirmation de quelques secondes.
 *
 * ── ⚠️ IL NE REMPLACE PAS LE BALAYAGE PÉRIODIQUE ────────────────────────────
 *
 * Celui-ci tourne toujours dans le processus serveur, et doit y rester. Un
 * contrôle déclenché par événement a exactement les angles morts du bus : il ne
 * voit ni ce que le bus n'a pas livré, ni les états qui changent sans événement
 * — rappels prestataires, rattrapages manuels, écritures orphelines dont
 * aucune transaction ne parle.
 *
 * L'événement donne la VITESSE, le balayage donne la COUVERTURE. Supprimer le
 * second en croyant le premier suffisant est la régression que ce commentaire
 * existe pour empêcher.
 *
 * ── Lancement ───────────────────────────────────────────────────────────────
 *
 *     npm run worker:settlement
 */

require("dotenv").config();

const {
  demarrerConsommateur,
} = require("../src/services/events/workerRuntime");

const settlement = require("../src/services/reconciliation/settlementConsumer");

demarrerConsommateur({
  etiquette: "settlement",
  titre: "📒 Service de réconciliation événementielle",
  construire: settlement.build,
  annoncer: settlement.annoncer,
}).catch((err) => {
  console.error("❌ Réconciliation — démarrage impossible :", err?.message || err);
  process.exit(1);
});
