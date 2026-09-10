#!/usr/bin/env node
"use strict";

/**
 * ============================================================================
 * SERVICE DE NOTIFICATION — POINT D'ENTRÉE
 * ============================================================================
 *
 * La branche `Notification` du schéma cible, sur le bus partagé.
 *
 * ── Ce qu'il referme ────────────────────────────────────────────────────────
 *
 * Tx-Core écrivait DIRECTEMENT dans `notifications` et `outboxes`, deux
 * collections du backend principal. Ce consommateur appelle une API interne à
 * la place : le backend redevient le seul écrivain de ses collections, avec ses
 * règles de priorité et ses index.
 *
 * ── Ce dont il a besoin ─────────────────────────────────────────────────────
 *
 * `PRINCIPAL_URL` et `INTERNAL_TOKEN` (ou `PRINCIPAL_INTERNAL_TOKEN`). Sans
 * elles, il ne livre rien et le DIT — les événements restent dans
 * `domain_events` et repartent une fois la configuration corrigée. Rien n'est
 * perdu.
 *
 * ── Lancement ───────────────────────────────────────────────────────────────
 *
 *     npm run worker:notifications
 */

require("dotenv").config();

const {
  demarrerConsommateur,
} = require("../src/services/events/workerRuntime");

const notifications = require("../src/services/notifications/notificationConsumer");

demarrerConsommateur({
  etiquette: "notifications",
  titre: "🔔 Service de notification",
  construire: notifications.build,
  annoncer: notifications.annoncer,
}).catch((err) => {
  console.error("❌ Notifications — démarrage impossible :", err?.message || err);
  process.exit(1);
});
