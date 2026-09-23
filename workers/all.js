#!/usr/bin/env node
"use strict";

/**
 * ============================================================================
 * TOUS LES CONSOMMATEURS DANS UN SEUL PROCESSUS
 * ============================================================================
 *
 * ── À quoi ça sert, et à quoi ça ne sert PAS ────────────────────────────────
 *
 * Quatre services séparés, c'est quatre déploiements, quatre jeux de variables
 * et quatre coûts d'hébergement. En développement — et sur une petite
 * installation — un seul processus suffit.
 *
 * ⚠️ CE N'EST PAS UN RETOUR EN ARRIÈRE SUR LA SÉPARATION. Ce qui isole les
 * consommateurs les uns des autres, ce n'est pas le processus, c'est le GROUPE
 * de consommateurs Redis : chacun a son propre décalage, ses propres
 * acquittements et ses propres messages en attente. Un consommateur qui
 * s'effondre ne prend pas les décalages des autres avec lui.
 *
 * Ce que le processus séparé apporte en plus — et qu'on perd ici — c'est
 * l'isolement des PANNES DE PROCESSUS : une fuite mémoire dans la surveillance
 * emporterait aussi les notifications. C'est un compromis acceptable en
 * développement, pas en production.
 *
 * ── Ce qui reste vrai dans les deux cas ─────────────────────────────────────
 *
 * ⚠️ MIS À JOUR LE 2026-09-23 : par défaut, les consommateurs tournent AUSSI
 * dans le processus du serveur (`services/events/inlineConsumers.js`), parce
 * que l'hébergement réel n'a pas de service worker. Ce script reste le moyen de
 * les isoler dans un service dédié ; poser alors `EVENT_CONSUMERS_INLINE=false`
 * sur le serveur. Faire tourner les deux ensemble ne crée pas de doublon : les
 * groupes Redis répartissent les messages.
 *
 * ── Lancement ───────────────────────────────────────────────────────────────
 *
 *     npm run workers:all          # développement, un processus
 *     npm run worker:risk          # production, un service par branche
 *     npm run worker:settlement
 *     npm run worker:referral
 *     npm run worker:notifications
 */

require("dotenv").config();

const Redis = require("ioredis");

const logger = require("../src/utils/logger");
const { connectTransactionsDB, getTxConn } = require("../src/config/db");
const { setClient } = require("../src/services/redisClientAccessor");
const stream = require("../src/services/events/stream");

/**
 * La liste vient de `inlineConsumers.js`, la même que celle du mode « dans le
 * processus web » : deux listes finiraient par diverger, et une branche ne
 * tournerait alors que selon le mode de déploiement.
 */
const BRANCHES = require("../src/services/events/inlineConsumers").BRANCHES.map(
  (b) => [b.titre, b.charger()]
);

const poignees = [];
let redis = null;

async function arreter(signal) {
  logger.info(`🛑 Consommateurs du bus — arrêt (${signal})`);

  for (const p of poignees) {
    try {
      p?.stop?.();
    } catch {}
  }

  try {
    await redis?.quit?.();
  } catch {}

  /** Délai : les tours en cours doivent pouvoir acquitter ce qu'ils ont traité. */
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGTERM", () => arreter("SIGTERM"));
process.on("SIGINT", () => arreter("SIGINT"));

process.on("unhandledRejection", (err) => {
  logger.error("[workers] rejet non traité", {
    message: err?.message || String(err),
  });
});

(async () => {
  logger.info("▶️  Consommateurs du bus — démarrage groupé");

  await connectTransactionsDB();

  if (!getTxConn()) {
    logger.error("❌ Connexion aux transactions indisponible — arrêt.");
    process.exit(1);
  }

  const url = process.env.REDIS_URL || "";

  if (url) {
    /** ⚠️ UN SEUL client pour le processus, quel que soit le nombre de groupes. */
    redis = new Redis(url, { maxRetriesPerRequest: null, enableOfflineQueue: true });

    redis.on("error", (err) =>
      logger.error("[workers][redis] erreur", { message: err?.message })
    );

    setClient(redis);
  } else {
    logger.warn(
      "⚠️ REDIS_URL absente — les consommateurs démarrent SANS TRANSPORT et " +
        "n'examinent rien. Les événements restent dans `domain_events` et " +
        "repartiront au retour de Redis ; rien n'est perdu."
    );
  }

  logger.info(`📨 Flux « ${stream.FLUX} » — ${BRANCHES.length} groupes.`);

  for (const [titre, branche] of BRANCHES) {
    try {
      branche.annoncer?.(logger);

      const consommateur = branche.build({ logger });
      poignees.push(await consommateur.start());

      logger.info(`   ✅ ${titre} — groupe « ${consommateur.groupe} »`);
    } catch (err) {
      /**
       * ⚠️ UNE BRANCHE QUI NE DÉMARRE PAS N'EMPÊCHE PAS LES AUTRES.
       *
       * Mais elle le DIT, avec sa conséquence : sans cette ligne, on croirait
       * les quatre en écoute alors que l'une d'elles est absente — et la
       * surveillance de conformité manquante ne se remarque pas.
       */
      logger.error(`   ❌ ${titre} NON DÉMARRÉ — cette branche n'écoute rien`, {
        message: err?.message || String(err),
      });
    }
  }

  logger.info(`✅ ${poignees.length}/${BRANCHES.length} consommateurs en écoute`);
})().catch((err) => {
  logger.error("❌ Consommateurs du bus — démarrage impossible", {
    message: err?.message || String(err),
  });

  process.exit(1);
});
