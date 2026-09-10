#!/usr/bin/env node
"use strict";

/**
 * ============================================================================
 * SERVICE DE SURVEILLANCE DU RISQUE — POINT D'ENTRÉE
 * ============================================================================
 *
 * Le service `Risk/AML` du schéma cible, dans son PROPRE PROCESSUS. Il partage
 * encore le dépôt de Tx-Core ; il ne partage plus son cycle de vie.
 *
 * ── Pourquoi processus d'abord, dépôt ensuite ───────────────────────────────
 *
 * L'ordre inverse est la faute classique : extraire un dépôt oblige à inventer
 * un contrat réseau AVANT de savoir ce qu'il doit porter. Séparer le processus
 * donne tout de suite la propriété qui compte en exploitation — la surveillance
 * se redéploie, plante ou sature SANS TOUCHER AU MOTEUR D'ARGENT — et le
 * contrat qu'on extraira sera celui qu'on aura mesuré
 * (`services/events/contract.js`), pas celui qu'on aura deviné.
 *
 * ── Ce qu'il ne fait pas ────────────────────────────────────────────────────
 *
 * · Il n'écoute aucun port. Ce n'est pas une API, c'est un consommateur.
 * · Il ne bloque et n'annule rien. Il ouvre des dossiers que le back-office
 *   instruit. La décision qui BLOQUE est en ligne, dans `middleware/aml.js`,
 *   parce qu'elle doit intervenir avant que l'argent parte.
 *
 * ── Lancement ───────────────────────────────────────────────────────────────
 *
 *     npm run worker:risk
 *
 * Sur Render : service « Background Worker », même dépôt, même image, commande
 * `node workers/riskMonitor.js`. Variables : `MONGO_URI_*` et `REDIS_URL`.
 */

require("dotenv").config();

const {
  demarrerConsommateur,
} = require("../src/services/events/workerRuntime");

const monitoring = require("../src/services/risk/monitoringConsumer");

demarrerConsommateur({
  etiquette: "risk",
  titre: "🛡️  Service de surveillance du risque",
  construire: monitoring.build,
  annoncer: monitoring.annoncer,
}).catch((err) => {
  console.error("❌ Surveillance du risque — démarrage impossible :", err?.message || err);
  process.exit(1);
});
