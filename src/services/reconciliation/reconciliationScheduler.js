"use strict";

/**
 * ============================================================================
 * RÉCONCILIATION PLANIFIÉE
 * ============================================================================
 *
 * CE QUE CE MODULE CHANGE
 * -----------------------
 * `transactionReconciliationService` existait, était bien conçu, et n'était
 * déclenché que par `npm run reconcile:transactions` — une commande lancée à la
 * main. Une réconciliation que personne ne lance ne réconcilie rien : c'est un
 * contrôle qui figure dans la documentation et pas dans la réalité.
 *
 * Ce module lui donne une horloge, un verrou, et une trace.
 *
 * ⚠️ LA RÈGLE ABSOLUE EST PRÉSERVÉE : ON NE CORRIGE RIEN.
 * Le service sous-jacent lit, compare et signale. Ce planificateur n'ajoute
 * aucune écriture financière — il écrit uniquement un compte-rendu dans
 * `reconciliation_runs`. Une réconciliation qui répare serait une seconde source
 * de mouvements d'argent, déclenchée par un travail de fond que personne ne
 * regarde : exactement ce que l'en-tête du service interdit.
 *
 * POURQUOI UN VERROU DE TÂCHE, ET PAS UN VERROU PAR DOCUMENT
 * ----------------------------------------------------------
 * Le worker d'auto-annulation verrouille CHAQUE transaction (`autoCancelLockAt`)
 * parce qu'il les traite une par une et qu'un partage du travail entre instances
 * est souhaitable. Ici c'est l'inverse : le balayage est global et agrège un
 * rapport. Deux instances qui le lancent en même temps produiraient deux
 * rapports concurrents, deux fois la charge de lecture, et un historique
 * illisible. Il faut donc UN gagnant par fenêtre — d'où `withCronLock`, le motif
 * déjà éprouvé sur les sept tâches du backend principal.
 *
 * LE TTL DU VERROU EST UN ENGAGEMENT
 * ----------------------------------
 * Il doit rester nettement au-dessus de la durée observée du balayage, sinon une
 * autre instance reprendrait le verrou pendant qu'on travaille encore. 30 min
 * par défaut pour un balayage qui doit prendre quelques secondes à quelques
 * minutes : la marge est volontairement large, un verrou trop court étant pire
 * qu'inutile.
 */

const { getTxConn } = require("../../config/db");
const { withCronLock, WORKER_ID } = require("../cronLock");
const { reconcileTransactions } = require("./transactionReconciliationService");
const {
  reconcileAgainstProviders,
} = require("./providerReconciliationService");

let logger = console;
try {
  logger = require("../../logger");
} catch {}

const JOB_NAME = "transaction-reconciliation";

/** Résolution paresseuse — `getTxConn()` lève avant la connexion. */
let _ReconciliationRun = null;
function runModel() {
  if (!_ReconciliationRun) {
    _ReconciliationRun = require("../../models/ReconciliationRun")(getTxConn());
  }
  return _ReconciliationRun;
}

const { MAX_STORED_ANOMALIES } = require("../../models/ReconciliationRun");

/* -------------------------------------------------------------------------- */
/* Fonctions pures — testables sans base                                      */
/* -------------------------------------------------------------------------- */

/**
 * Compte les anomalies par type.
 *
 * C'est ce comptage, et non la liste, qui sert à alerter : « 400
 * STUCK_RESERVATION » appelle une réaction différente de « 1 WALLET_IMBALANCE »,
 * alors que les deux valent « des écarts existent ».
 */
function summarizeAnomalies(anomalies = []) {
  const byType = {};

  for (const a of anomalies) {
    const type = String(a?.type || "UNKNOWN");
    byType[type] = (byType[type] || 0) + 1;
  }

  return byType;
}

/**
 * ═══ POURQUOI UN SEUL RAPPORT POUR DEUX AXES ═══════════════════════════════
 *
 * La réconciliation a désormais deux axes : la cohérence INTERNE (nos données
 * entre elles) et la confrontation au PRESTATAIRE (ce qu'il nous a dit contre
 * ce que nous avons fait). Ils sont complémentaires, pas redondants — le
 * premier peut être entièrement vert pendant que l'argent est perdu, s'il se
 * trouve que nous sommes cohéremment en désaccord avec le rail.
 *
 * En faire DEUX tâches planifiées aurait signifié deux verrous, deux horloges,
 * deux historiques, et deux choses à ne pas oublier de surveiller. Or ce qu'un
 * opérateur veut lire, c'est « l'état des flux sur les dernières 48 h » — une
 * seule réponse. Les types d'anomalies sont déjà disjoints, la fusion ne perd
 * donc aucune information.
 *
 * Pure : elle ne touche ni la base ni l'horloge.
 */
function mergeReports(internal, provider) {
  const anomalies = [
    ...(Array.isArray(internal?.anomalies) ? internal.anomalies : []),
    ...(Array.isArray(provider?.anomalies) ? provider.anomalies : []),
  ];

  return {
    healthy: anomalies.length === 0,
    window: internal?.window ?? provider?.window ?? null,
    checked: {
      wallets: internal?.checked?.wallets || 0,
      transactions: internal?.checked?.transactions || 0,
      ledgerEntries: internal?.checked?.ledgerEntries || 0,
      reservations: internal?.checked?.reservations || 0,
      providerEvents: provider?.checked?.providerEvents || 0,
      awaitingSettlement: provider?.checked?.awaitingSettlement || 0,
    },
    registry: provider?.registry ?? null,
    anomalies,
  };
}

/**
 * Prépare le document à écrire depuis un rapport de réconciliation.
 *
 * Pure : elle ne touche ni la base, ni l'horloge (la durée lui est donnée).
 */
function buildRunDocument(report, { workerId, startedAt, durationMs }) {
  const anomalies = Array.isArray(report?.anomalies) ? report.anomalies : [];

  return {
    job: JOB_NAME,
    status: "completed",
    workerId,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + durationMs),
    durationMs,
    window: {
      sinceHours: report?.window?.sinceHours ?? null,
      since: report?.window?.since ?? null,
    },
    checked: {
      wallets: report?.checked?.wallets || 0,
      transactions: report?.checked?.transactions || 0,
      ledgerEntries: report?.checked?.ledgerEntries || 0,
      reservations: report?.checked?.reservations || 0,
      providerEvents: report?.checked?.providerEvents || 0,
      awaitingSettlement: report?.checked?.awaitingSettlement || 0,
    },
    registry: {
      floorAt: report?.registry?.floorAt ?? null,
      reason: report?.registry?.reason ?? null,
      settlementTimeoutSkipped: report?.registry?.settlementTimeoutSkipped === true,
    },
    healthy: anomalies.length === 0,
    anomalyCount: anomalies.length,
    anomaliesByType: summarizeAnomalies(anomalies),
    // Le COMPTE est exact ; l'échantillon est borné. Voir l'en-tête du modèle.
    anomalies: anomalies.slice(0, MAX_STORED_ANOMALIES),
    anomaliesTruncated: anomalies.length > MAX_STORED_ANOMALIES,
    error: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Exécution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Un tour de réconciliation, sous verrou.
 *
 * @returns {Promise<{ ran: boolean, report?: object, error?: Error }>}
 *          `ran: false` = une autre instance s'en charge. Ce n'est PAS un échec.
 */
async function runReconciliationOnce({
  sinceHours = Number(process.env.RECONCILIATION_WINDOW_HOURS || 48),
  limit = Number(process.env.RECONCILIATION_LIMIT || 5000),
  ttlMs = Number(process.env.RECONCILIATION_LOCK_TTL_MS || 30 * 60 * 1000),
} = {}) {
  return withCronLock(
    JOB_NAME,
    async () => {
      const startedAt = new Date();
      const t0 = Date.now();

      try {
        /**
         * ⚠️ EN SÉQUENCE, PAS EN PARALLÈLE.
         *
         * Les deux passes balaient les mêmes collections et chacune lance déjà
         * ses propres contrôles en parallèle. Les superposer doublerait le
         * nombre de curseurs ouverts simultanément sur la base qui porte
         * l'argent, pour gagner quelques secondes sur un travail de fond qui
         * tourne une fois par jour. Le mauvais échange.
         */
        const internal = await reconcileTransactions({ sinceHours, limit });
        const provider = await reconcileAgainstProviders({ sinceHours, limit });

        const report = mergeReports(internal, provider);
        const durationMs = Date.now() - t0;

        const doc = buildRunDocument(report, {
          workerId: WORKER_ID,
          startedAt,
          durationMs,
        });

        await runModel().create(doc);

        /**
         * Le niveau de journal suit le résultat, pas la réussite technique : un
         * balayage qui aboutit ET trouve des écarts n'est pas un succès.
         */
        if (doc.healthy) {
          logger.info?.("[RECONCILE] aucun écart", {
            durationMs,
            checked: doc.checked,
          });
        } else {
          logger.warn?.("[RECONCILE] ÉCARTS DÉTECTÉS", {
            durationMs,
            count: doc.anomalyCount,
            byType: doc.anomaliesByType,
          });
        }

        return report;
      } catch (err) {
        /**
         * On enregistre l'ÉCHEC aussi. Sans cela, une réconciliation qui plante
         * chaque nuit serait indiscernable d'une réconciliation qui ne tourne
         * pas : dans les deux cas, aucun document `completed` n'apparaît.
         */
        await runModel()
          .create({
            job: JOB_NAME,
            status: "failed",
            workerId: WORKER_ID,
            startedAt,
            finishedAt: new Date(),
            durationMs: Date.now() - t0,
            error: String(err?.message || err).slice(0, 1000),
          })
          .catch(() => {});

        throw err;
      }
    },
    { ttlMs }
  );
}

/**
 * Dernière exécution connue — sert aux métriques et à la sonde.
 *
 * Ne lève jamais : une supervision qui tombe parce que la base est lente est
 * pire qu'une supervision qui dit « je ne sais pas ».
 */
async function getLastRun() {
  try {
    return await runModel()
      .findOne({ job: JOB_NAME })
      .sort({ startedAt: -1 })
      .lean();
  } catch (err) {
    logger.warn?.("[RECONCILE] lecture de la dernière exécution impossible", {
      message: err?.message || err,
    });
    return null;
  }
}

/**
 * Démarre la boucle.
 *
 * ⚠️ PAS DE PREMIER TOUR AU DÉMARRAGE, contrairement au worker d'auto-annulation.
 * Un balayage complet pendant le démarrage entre en concurrence avec la montée
 * en charge de l'instance, et un redéploiement enchaînerait autant de balayages
 * que d'instances redémarrées. Le premier tour attend donc un intervalle —
 * la réconciliation est un contrôle périodique, pas une urgence.
 *
 * @returns {{ stop: Function }|null} `null` si le worker est désactivé.
 */
function startReconciliationWorker({
  intervalMs = Number(process.env.RECONCILIATION_INTERVAL_MS || 24 * 3600 * 1000),
  enabled = String(process.env.RECONCILIATION_WORKER ?? "true").toLowerCase() !== "false",
} = {}) {
  if (!enabled) {
    logger.info?.(
      "[RECONCILE] worker désactivé (RECONCILIATION_WORKER=false) — " +
        "la réconciliation reste disponible via `npm run reconcile:transactions`."
    );
    return null;
  }

  // Plancher à 1 minute : une valeur trop basse transformerait un contrôle en
  // charge permanente sur la base.
  const period = Math.max(60_000, Number(intervalMs) || 24 * 3600 * 1000);

  const tick = async () => {
    try {
      await runReconciliationOnce();
    } catch (err) {
      logger.error?.("[RECONCILE] tour échoué", {
        message: err?.message || err,
      });
    }
  };

  const timer = setInterval(tick, period);

  // `unref` : ce minuteur ne doit pas empêcher le processus de s'arrêter.
  if (typeof timer.unref === "function") timer.unref();

  logger.info?.(
    `[RECONCILE] worker actif — un balayage toutes les ${Math.round(
      period / 60000
    )} min, un seul exécutant par fenêtre.`
  );

  return {
    stop() {
      clearInterval(timer);
      logger.info?.("[RECONCILE] worker arrêté");
    },
  };
}

module.exports = {
  JOB_NAME,
  startReconciliationWorker,
  runReconciliationOnce,
  getLastRun,
  // exportés pour les tests, et pour `scripts/reconcileTransactions.js`
  summarizeAnomalies,
  buildRunDocument,
  mergeReports,
};
