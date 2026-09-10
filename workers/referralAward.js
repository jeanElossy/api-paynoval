#!/usr/bin/env node
"use strict";

/**
 * ============================================================================
 * SERVICE DE PARRAINAGE — POINT D'ENTRÉE
 * ============================================================================
 *
 * La branche `Referral` du schéma cible, sur le bus partagé.
 *
 * ── ⚠️ L'ANCIEN WORKER DOIT CONTINUER DE TOURNER ────────────────────────────
 *
 * `referralOutboxWorker` (démarré par `server.js`) draine le RELIQUAT de
 * l'ancienne file `outboxes`. Cesser de PRODUIRE dans une file n'autorise pas
 * à cesser de la CONSOMMER : chaque entrée en attente est un bonus dû à
 * quelqu'un, et l'arrêter les perdrait toutes en silence.
 *
 * Il sera retiré quand la file sera vide ET le sera restée — c'est le motif
 * « strangler » appliqué à une file de messages : on coupe la production, on
 * laisse la consommation finir, puis on démonte.
 *
 * ── Ce que le principal reçoit ──────────────────────────────────────────────
 *
 * `{ refereeId, triggerTxId, correlationId }`. Aucun montant : le principal
 * réévalue le filleul à partir de ses propres données. Le bus ne porte jamais
 * d'ordre de paiement.
 *
 * ── Lancement ───────────────────────────────────────────────────────────────
 *
 *     npm run worker:referral
 */

require("dotenv").config();

const {
  demarrerConsommateur,
} = require("../src/services/events/workerRuntime");

const referral = require("../src/services/referral/referralConsumer");

demarrerConsommateur({
  etiquette: "referral",
  titre: "🎁 Service de parrainage",
  construire: referral.build,
  annoncer: referral.annoncer,
}).catch((err) => {
  console.error("❌ Parrainage — démarrage impossible :", err?.message || err);
  process.exit(1);
});
