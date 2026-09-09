"use strict";

/**
 * ============================================================================
 * MOTEUR DE REJEU DES RÈGLEMENTS — F.4
 * ============================================================================
 *
 * Toute la DÉCISION vit dans `settlementReplayRules.js`, qui est pur. Ici on ne
 * fait qu'appliquer : lire le registre, reprendre un événement, appeler le
 * moteur de règlement, clore.
 *
 * ⚠️ CE MODULE ÉCRIT — C'EST SA DIFFÉRENCE AVEC LA RÉCONCILIATION.
 *
 * `providerReconciliationService` a une règle absolue : il ne corrige rien. Ce
 * module, lui, déplace de l'argent. La frontière entre les deux est nette, et
 * elle tient en une phrase :
 *
 *   la réconciliation RÉPARE des écarts qu'elle DÉDUIT ;
 *   le rejeu TERMINE un travail que nous avions déjà ACCEPTÉ.
 *
 * Un événement du registre est un rappel authentifié pour lequel nous avons
 * répondu — ou dû répondre — au prestataire. Le régler n'est pas une initiative
 * du travail de fond : c'est l'achèvement d'un engagement pris. C'est ce que
 * font Stripe et Adyen, et c'est pourquoi ce module existe séparément plutôt
 * que dans la réconciliation, dont il violerait la règle fondatrice.
 *
 * ⚠️ LE WORKER EST DÉSACTIVÉ PAR DÉFAUT.
 * Un travail de fond qui déplace de l'argent ne s'allume pas tout seul au
 * premier déploiement. `SETTLEMENT_REPLAY_WORKER=true` l'active ; sans elle,
 * le rejeu reste disponible à la demande via `npm run replay:settlements`.
 */

const { getTxConn } = require("../../config/db");
const { withCronLock, WORKER_ID } = require("../cronLock");
const { WORKERS, declareWorker } = require("../workerMetrics");
const { LEASE_MS } = require("../webhooks/webhookIdempotency");
const {
  settleExternalTransaction,
} = require("../../controllers/externalSettlementController");

const {
  MAX_ATTEMPTS,
  REASONS,
  isReplayable,
} = require("./settlementReplayRules");

let logger = console;
try {
  logger = require("../../logger");
} catch {}

const JOB_NAME = "settlement-replay";

function eventModel() {
  const conn = getTxConn();
  if (!conn.models.ProviderWebhookEvent) {
    throw new Error("Modèle ProviderWebhookEvent non enregistré");
  }
  return conn.models.ProviderWebhookEvent;
}

/**
 * Reprend l'événement de façon ATOMIQUE, ou renonce.
 *
 * ⚠️ LE FILTRE REPREND LA CONDITION D'ÉLIGIBILITÉ. C'est la même discipline que
 * `claimEvent` : sans elle, deux instances constatant simultanément qu'un
 * événement est rejouable le reprendraient toutes deux. `findOneAndUpdate` est
 * atomique, donc une seule voit le document — l'autre reçoit `null` et passe.
 *
 * On repose aussi `startedAt` : le bail recommence, ce qui empêche un troisième
 * tour de le reprendre pendant qu'on travaille.
 */
async function takeForReplay(record, { now, leaseMs }) {
  const Model = eventModel();

  return Model.findOneAndUpdate(
    {
      _id: record._id,
      $or: [
        { status: "failed" },
        { status: "processing", startedAt: { $lte: new Date(now - leaseMs) } },
      ],
    },
    {
      $set: { status: "processing", startedAt: new Date(now), lastError: null },
      $inc: { attempts: 1 },
    },
    { new: true }
  ).lean();
}

async function markProcessed(id, statusCode, now) {
  await eventModel().updateOne(
    { _id: id },
    {
      $set: {
        status: "processed",
        responseStatus: statusCode,
        processedAt: new Date(now),
        lastError: null,
      },
    }
  );
}

async function markFailed(id, err) {
  await eventModel().updateOne(
    { _id: id },
    {
      $set: {
        status: "failed",
        // Tronqué : une réponse prestataire entière peut porter des données
        // personnelles.
        lastError: String(err?.message || err || "").slice(0, 300),
      },
    }
  );
}

/**
 * Un tour de rejeu.
 *
 * @returns {Promise<{scanned, replayed, succeeded, failed, skipped: object}>}
 */
async function replaySettlementsOnce({
  sinceHours = Number(process.env.SETTLEMENT_REPLAY_WINDOW_HOURS || 72),
  limit = Number(process.env.SETTLEMENT_REPLAY_LIMIT || 50),
  maxAttempts = Number(process.env.SETTLEMENT_REPLAY_MAX_ATTEMPTS || MAX_ATTEMPTS),
  leaseMs = LEASE_MS,
  now = Date.now(),
} = {}) {
  const Model = eventModel();
  const since = new Date(now - sinceHours * 3600 * 1000);

  const candidats = await Model.find({
    status: { $in: ["processing", "failed"] },
    createdAt: { $gte: since },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  const bilan = {
    scanned: candidats.length,
    replayed: 0,
    succeeded: 0,
    failed: 0,
    skipped: {},
  };

  for (const record of candidats) {
    const { eligible, reason } = isReplayable(record, { now, leaseMs, maxAttempts });

    if (!eligible) {
      bilan.skipped[reason] = (bilan.skipped[reason] || 0) + 1;
      continue;
    }

    const repris = await takeForReplay(record, { now, leaseMs });

    if (!repris) {
      // Une autre instance l'a pris entre-temps : elle s'en occupe.
      bilan.skipped[REASONS.LEASE_ACTIVE] = (bilan.skipped[REASONS.LEASE_ACTIVE] || 0) + 1;
      continue;
    }

    bilan.replayed += 1;

    logger.info?.("[REPLAY] rejeu d'un règlement", {
      eventRecordId: String(repris._id),
      provider: repris.provider,
      eventId: repris.eventId,
      attempts: repris.attempts,
      reference: repris.transactionReference,
    });

    try {
      /**
       * ⚠️ EXACTEMENT LE MÊME MOTEUR QUE LE RAPPEL DIRECT.
       *
       * Pas une variante « pour le rejeu ». Une seconde implémentation du
       * règlement serait une seconde façon de créditer un bénéficiaire, donc un
       * second risque de double crédit — et elle divergerait, comme divergent
       * toujours deux copies d'une même règle.
       */
      const result = await settleExternalTransaction(repris.payload);

      await markProcessed(repris._id, result.statusCode, Date.now());
      bilan.succeeded += 1;
    } catch (err) {
      await markFailed(repris._id, err).catch(() => {});
      bilan.failed += 1;

      logger.warn?.("[REPLAY] rejeu échoué", {
        eventRecordId: String(repris._id),
        eventId: repris.eventId,
        attempts: repris.attempts,
        error: err?.message || err,
      });
    }
  }

  return bilan;
}

/**
 * Un tour, sous verrou distribué.
 *
 * Le verrou n'est pas ici une optimisation : deux instances rejouant le même
 * lot lanceraient deux règlements en parallèle sur les mêmes transactions.
 * `takeForReplay` l'empêcherait de doubler l'argent, mais on aurait fabriqué la
 * course qu'on cherche à éviter.
 *
 * @returns {Promise<{ran: boolean, bilan?: object}>} `ran: false` = une autre
 *          instance s'en charge. Ce n'est PAS un échec.
 */
async function runReplayOnce(options = {}) {
  const ttlMs = Number(process.env.SETTLEMENT_REPLAY_LOCK_TTL_MS || 15 * 60 * 1000);

  return withCronLock(
    JOB_NAME,
    async () => {
      const t0 = Date.now();
      const bilan = await replaySettlementsOnce(options);
      const durationMs = Date.now() - t0;

      if (bilan.replayed) {
        logger.info?.("[REPLAY] tour terminé", { ...bilan, durationMs, workerId: WORKER_ID });
      }

      return bilan;
    },
    { ttlMs }
  );
}

/**
 * Démarre la boucle de rejeu.
 *
 * ⚠️ DÉSACTIVÉE PAR DÉFAUT — c'est délibéré et c'est le point le plus important
 * de ce fichier. Un travail de fond qui déplace de l'argent ne doit pas
 * s'allumer tout seul au premier déploiement : la décision de l'activer se
 * prend en connaissance de cause, après avoir regardé ce que la réconciliation
 * signale. Sans la variable, le rejeu reste entièrement disponible à la demande.
 *
 * @returns {{stop: Function}|null} `null` si le worker est désactivé.
 */
function startSettlementReplayWorker({
  intervalMs = Number(process.env.SETTLEMENT_REPLAY_INTERVAL_MS || 15 * 60 * 1000),
  enabled = String(process.env.SETTLEMENT_REPLAY_WORKER ?? "false").toLowerCase() === "true",
  /**
   * Travail d'un tour. Injectable pour que le test de câblage exerce le VRAI
   * `startSettlementReplayWorker` **sans déplacer d'argent** ni ouvrir de
   * connexion Mongo (règle B.5).
   */
  runOnce = runReplayOnce,
} = {}) {
  if (!enabled) {
    logger.info?.(
      "[REPLAY] worker désactivé (SETTLEMENT_REPLAY_WORKER≠true) — " +
        "le rejeu reste disponible via `npm run replay:settlements`."
    );

    /**
     * Déclaré même éteint — et c'est ici que ça compte le plus : ce worker est
     * éteint PAR DÉFAUT. Sans déclaration, `/metrics` serait muet à son sujet et
     * on ne pourrait pas distinguer « volontairement éteint » (`worker_enabled=0`)
     * de « censé tourner et jamais démarré » (`-1`).
     */
    declareWorker(WORKERS.SETTLEMENT_REPLAY, { enabled: false, logger });

    return null;
  }

  const metrics = declareWorker(WORKERS.SETTLEMENT_REPLAY, { logger });

  // Plancher à 1 minute : plus court transformerait un rattrapage en charge
  // permanente sur le chemin de l'argent.
  const period = Math.max(60_000, Number(intervalMs) || 15 * 60 * 1000);

  const tick = async () => {
    try {
      await metrics.record(() => runOnce());
    } catch (err) {
      logger.error?.("[REPLAY] tour échoué", { message: err?.message || err });
    }
  };

  const timer = setInterval(tick, period);
  if (typeof timer.unref === "function") timer.unref();

  logger.warn?.(
    `[REPLAY] worker ACTIF — un tour toutes les ${Math.round(period / 60000)} min. ` +
      "Ce worker DÉPLACE DE L'ARGENT : il termine des règlements déjà acceptés."
  );

  return {
    /** Un tour, à la demande. Exposé pour le test de câblage. */
    tick,

    stop() {
      clearInterval(timer);
      logger.info?.("[REPLAY] worker arrêté");
    },
  };
}

module.exports = {
  JOB_NAME,
  replaySettlementsOnce,
  runReplayOnce,
  startSettlementReplayWorker,
  takeForReplay,
};
