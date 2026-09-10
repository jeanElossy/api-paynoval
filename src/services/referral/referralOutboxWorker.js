"use strict";

/**
 * ============================================================================
 * WORKER DE LIVRAISON DES ÉVÉNEMENTS DE PARRAINAGE
 * ============================================================================
 *
 * Consomme la file écrite par `referralEventOutbox` et notifie le backend
 * principal, qui décidera de l'éligibilité et déclenchera le versement.
 *
 * CE QUE CE WORKER NE FAIT PAS, ET NE DOIT JAMAIS FAIRE
 * -----------------------------------------------------
 * Il n'évalue aucune condition, ne calcule aucun montant, ne déplace aucun
 * argent. Il transporte un signal : « cet utilisateur vient de faire une
 * transaction qualifiante ». Toute intelligence ajoutée ici créerait un second
 * moteur de décision, à côté de celui du principal — et deux moteurs de
 * décision finissent toujours par diverger.
 *
 * SÉMANTIQUE DE LIVRAISON
 * -----------------------
 * Au moins une fois. Le principal peut donc recevoir le même événement
 * plusieurs fois, et c'est prévu : sa chaîne est idempotente de bout en bout
 * (machine à états sur la récompense, puis registre de versements côté
 * Tx-Core). Un doublon de signal ne produit pas un doublon d'argent.
 */

let logger = console;
try {
  logger = require("../../logger");
} catch {}

const {
  SERVICE,
  EVENT_ACTIVITY_CONFIRMED,
  buildWorkerId,
  claimBatch,
  reapExpiredLocks,
  settleSuccess,
  settleFailure,
} = require("./referralEventOutbox");

const { WORKERS, declareWorker } = require("../workerMetrics");

/**
 * ⚠️ LA LIVRAISON A ÉTÉ EXTRAITE — 2026-09-10.
 *
 * Elle vit dans `referralDelivery.js` parce que DEUX transports l'appellent
 * pendant la migration vers le bus : ce worker, qui draine le reliquat de
 * l'outbox, et `referralConsumer.js`, qui lit le flux. La recopier aurait
 * produit deux politiques de délai et deux traitements du 4xx.
 */
const {
  deliverItem,
  getPrincipalBaseUrl,
  getPrincipalInternalToken,
  getRequestTimeoutMs,
  buildUrl,
} = require("./referralDelivery");

/**
 * Traite un lot d'événements en attente.
 *
 * @returns {Promise<{claimed:number, delivered:number, retried:number, failed:number}>}
 */
async function processPendingReferralEvents({ limit = 50, workerId } = {}) {
  const wid = workerId || buildWorkerId();

  const items = await claimBatch({ workerId: wid, limit });

  let delivered = 0;
  let retried = 0;
  let failed = 0;

  for (const item of items) {
    if (item.event !== EVENT_ACTIVITY_CONFIRMED) {
      // Événement inconnu : on le sort de la file plutôt que de le rejouer
      // indéfiniment, et on le dit.
      logger.warn?.("[REFERRAL][WORKER] evenement inconnu ecarte", {
        outboxId: String(item._id),
        event: item.event,
      });

      await settleSuccess(item._id);
      continue;
    }

    try {
      await deliverItem(item);
      await settleSuccess(item._id);
      delivered += 1;
    } catch (err) {
      if (err?.permanent) {
        /* Échec définitif : on épuise les tentatives d'un coup. */
        await settleFailure(
          { ...item, attempts: Number(item.maxAttempts || 0) },
          err
        );
        failed += 1;
        continue;
      }

      const outcome = await settleFailure(item, err);
      if (outcome === "failed") failed += 1;
      else retried += 1;
    }
  }

  return { claimed: items.length, delivered, retried, failed };
}

/**
 * Démarre le worker périodique. Même forme que
 * `startTransactionAutoCancelWorker`, pour ne pas introduire un second modèle
 * de worker dans le dépôt.
 */
function startReferralOutboxWorker({
  intervalMs = Number(process.env.REFERRAL_OUTBOX_INTERVAL_MS || 5000),
  reapIntervalMs = Number(process.env.REFERRAL_OUTBOX_REAP_INTERVAL_MS || 60_000),
  batchSize = Number(process.env.REFERRAL_OUTBOX_BATCH_SIZE || 50),
  workerId,
  /**
   * Travail d'un tour. Injectable pour que le test de câblage exerce le VRAI
   * `startReferralOutboxWorker` sans ouvrir de connexion Mongo (règle B.5).
   */
  runOnce = processPendingReferralEvents,
} = {}) {
  if (String(process.env.REFERRAL_OUTBOX_WORKER_ENABLED || "true") === "false") {
    logger.warn?.("[REFERRAL][WORKER] desactive par configuration");

    // Déclaré même éteint : une série absente n'alerte pas. Voir
    // `services/workerMetrics.js`.
    declareWorker(WORKERS.REFERRAL_OUTBOX, { enabled: false, logger });
    declareWorker(WORKERS.REFERRAL_LOCK_REAPER, { enabled: false, logger });

    return { workerId: workerId || "", async tick() {}, stop() {} };
  }

  const metrics = declareWorker(WORKERS.REFERRAL_OUTBOX, { logger });

  /**
   * ⚠️ SECONDE BOUCLE, SECONDE DÉCLARATION.
   *
   * `reapTick` est un `setInterval` distinct de `tick`. Son arrêt a sa propre
   * conséquence : les verrous expirés ne sont plus libérés, et les événements
   * de parrainage restent verrouillés **indéfiniment**. La boucle principale,
   * elle, continuerait de tourner et d'afficher un âge sain — une série verte à
   * côté d'une file qui ne s'écoule plus.
   *
   * Ce qui se déclare n'est pas « un worker », c'est **chaque boucle dont
   * l'arrêt a une conséquence**.
   */
  const reaperMetrics = declareWorker(WORKERS.REFERRAL_LOCK_REAPER, { logger });

  const wid = workerId || buildWorkerId();

  logger.info?.("[REFERRAL][WORKER] demarre", {
    workerId: wid,
    intervalMs,
    batchSize,
    service: SERVICE,
  });

  /**
   * Verrou de ré-entrance. Sans lui, un tour lent verrait le tour suivant
   * démarrer par-dessus, et deux passes concurrentes se disputeraient les mêmes
   * items — exactement le défaut qui avait été corrigé sur la file de
   * notifications du backend principal.
   */
  let running = false;

  /**
   * ⚠️ Un tour SAUTÉ par le verrou de ré-entrance n'est pas compté comme un
   * passage : ce n'en est pas un. L'âge continue donc de monter tant que le
   * tour en cours n'est pas fini — exactement ce qu'on veut voir si un tour
   * reste bloqué (`worker_running` vaut alors 1 et le dit).
   */
  const tick = async () => {
    if (running) return;
    running = true;

    try {
      const result = await metrics.record(() =>
        runOnce({
          limit: batchSize,
          workerId: wid,
        })
      );

      if (result?.claimed) {
        logger.info?.("[REFERRAL][WORKER] lot traite", result);
      }
    } catch (err) {
      logger.error?.("[REFERRAL][WORKER] tour echoue", {
        workerId: wid,
        err: err?.message || err,
      });
    } finally {
      running = false;
    }
  };

  const reapTick = async () => {
    try {
      /**
       * `record` est posé À L'INTÉRIEUR du try/catch, pas autour. Autour, il ne
       * verrait jamais un échec : ce tour absorbe déjà ses erreurs, et l'appel
       * extérieur rendrait toujours un succès.
       */
      await reaperMetrics.record(() => reapExpiredLocks());
    } catch (err) {
      logger.error?.("[REFERRAL][WORKER] ramassage des verrous echoue", {
        err: err?.message || err,
      });
    }
  };

  tick();

  const timer = setInterval(tick, Math.max(1000, Number(intervalMs)));
  const reaper = setInterval(
    reapTick,
    Math.max(10_000, Number(reapIntervalMs))
  );

  if (typeof timer.unref === "function") timer.unref();
  if (typeof reaper.unref === "function") reaper.unref();

  return {
    workerId: wid,

    /** Un tour, à la demande. Exposé pour le test de câblage. */
    tick,

    stop() {
      clearInterval(timer);
      clearInterval(reaper);
      logger.info?.("[REFERRAL][WORKER] arrete", { workerId: wid });
    },
  };
}

module.exports = {
  processPendingReferralEvents,
  startReferralOutboxWorker,
  deliverItem,
};
