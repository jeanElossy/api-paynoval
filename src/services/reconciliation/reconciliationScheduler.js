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
const { WORKERS, declareWorker } = require("../workerMetrics");
const { reconcileTransactions } = require("./transactionReconciliationService");
const {
  reconcileAgainstProviders,
} = require("./providerReconciliationService");
const {
  reconcileWalletsAgainstLedger,
} = require("./walletLedgerReconciliationService");

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
 * ═══ POURQUOI UN SEUL RAPPORT POUR TROIS AXES ══════════════════════════════
 *
 * La réconciliation a désormais TROIS axes : la cohérence INTERNE (nos données
 * entre elles), la confrontation au PRESTATAIRE (ce qu'il nous a dit contre
 * ce que nous avons fait), et depuis le 2026-09-03 le rapprochement
 * PORTEFEUILLE ↔ GRAND LIVRE — le seul qui vérifie l'invariant 2 de bout en
 * bout, et le seul qui soit PARTIEL par construction (balayage tournant). Ils sont complémentaires, pas redondants — le
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
/**
 * Le troisième axe est actif par défaut. On le coupe séparément des deux
 * autres, parce qu'il balaie les portefeuilles sans fenêtre temporelle : si un
 * jour ce balayage coûte trop cher, il faut pouvoir l'arrêter sans perdre les
 * deux autres.
 */
function axeWalletLedgerActif() {
  return (
    String(process.env.RECONCILE_WALLET_LEDGER ?? "true").toLowerCase() !== "false"
  );
}

function mergeReports(internal, provider, walletLedger = null) {
  const anomalies = [
    ...(Array.isArray(internal?.anomalies) ? internal.anomalies : []),
    ...(Array.isArray(provider?.anomalies) ? provider.anomalies : []),
    ...(Array.isArray(walletLedger?.anomalies) ? walletLedger.anomalies : []),
  ];

  return {
    healthy: anomalies.length === 0,
    window: internal?.window ?? provider?.window ?? null,
    checked: {
      /**
       * Les deux axes comptent des portefeuilles et des écritures : on ADDITIONNE
       * plutôt que d'en écraser un. Prendre le maximum masquerait le travail de
       * l'autre, et « 4 portefeuilles vérifiés » quand deux passes en ont vu
       * quatre chacune est une mesure fausse.
       */
      wallets: (internal?.checked?.wallets || 0) + (walletLedger?.checked?.wallets || 0),
      transactions: internal?.checked?.transactions || 0,
      ledgerEntries:
        (internal?.checked?.ledgerEntries || 0) + (walletLedger?.checked?.ledgerEntries || 0),
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
/**
 * L'état de rotation à persister pour le tour suivant.
 *
 * `sweepsSinceRotation` se remet à zéro quand la rotation s'achève : c'est ce
 * compteur qui permet de voir, dans les journaux, qu'un balayage tourne bien en
 * rond au lieu de piétiner. Un axe désactivé rend `null` — on ne fabrique pas
 * un état pour un contrôle qui n'a pas tourné.
 */
function construireEtatBalayage(walletLedger, reprise) {
  if (!walletLedger || !reprise) return null;

  const c = walletLedger.cursor || {};
  const complete = c.rotationCompleted === true;

  return {
    lastSeen: complete ? null : c.lastSeen || null,
    rotationCompleted: complete,
    population: walletLedger.population?.matching ?? null,
    sweepsSinceRotation: complete ? 0 : Number(reprise.sweepsSinceRotation || 0) + 1,
    lastRotationAt: complete ? new Date() : reprise.lastRotationAt || null,
  };
}

function buildRunDocument(report, { workerId, startedAt, durationMs, walletLedgerSweep = null }) {
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
    walletLedgerSweep,
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
/* Le point de reprise du balayage portefeuille ↔ grand livre                  */
/* -------------------------------------------------------------------------- */

/**
 * Où le dernier tour s'est arrêté.
 *
 * ⚠️ En cas d'illisibilité on rend un état NEUF (repartir du début) — et c'est
 * le seul repli tolérable ici, parce qu'il ne masque rien : un balayage qui
 * repart du début couvre quand même sa tranche, et la rotation reprendra. Ce
 * qui serait inacceptable, c'est de PRÉTENDRE reprendre sans le faire ; d'où le
 * `logger.warn` et le compteur remis à zéro, qui rendent le redémarrage
 * visible dans le rapport suivant.
 */
async function dernierPointDeReprise() {
  const NEUF = { lastSeen: null, sweepsSinceRotation: 0, lastRotationAt: null };

  try {
    const precedent = await runModel()
      .findOne({ job: JOB_NAME, status: "completed" })
      .sort({ startedAt: -1 })
      .select("walletLedgerSweep")
      .lean();

    const sweep = precedent?.walletLedgerSweep;
    if (!sweep) return NEUF;

    /* Une rotation qui vient de s'achever repart du début, par construction. */
    if (sweep.rotationCompleted) {
      return {
        lastSeen: null,
        sweepsSinceRotation: 0,
        lastRotationAt: sweep.lastRotationAt || null,
      };
    }

    return {
      lastSeen: sweep.lastSeen || null,
      sweepsSinceRotation: Number(sweep.sweepsSinceRotation || 0),
      lastRotationAt: sweep.lastRotationAt || null,
    };
  } catch (err) {
    logger.warn?.(
      "[RECONCILE][WALLET-LEDGER] point de reprise illisible — le balayage " +
        "REPART DU DÉBUT. La rotation en cours est perdue, la couverture " +
        "complète est décalée d'autant.",
      { message: err?.message }
    );
    return NEUF;
  }
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

        /**
         * TROISIÈME AXE — portefeuille ↔ grand livre. Planifié le 2026-09-03.
         *
         * `walletLedgerReconciliation` existait depuis le 2026-09-01 mais
         * n'avait que deux appelants : un script manuel et un test. Un contrôle
         * qui ne tourne pas ne couvre rien.
         *
         * Il pose la question que les deux autres axes ne posent PAS : *le solde
         * est-il bien le cumul de ses écritures ?* C'est la vérification la plus
         * directe de l'invariant 2 — le grand livre fait foi, le solde n'est
         * qu'une projection. Sans elle, un doublon parfait en mode dégradé
         * laisse la balance de vérification ÉQUILIBRÉE et passe inaperçu.
         *
         * Il ne prend pas de fenêtre temporelle : un solde faux le reste, et
         * l'écart ne vieillit pas hors de portée.
         *
         * Comme les deux autres : en séquence, et il n'écrit RIEN.
         */
        /**
         * ⚠️ Il reprend où le tour précédent s'est arrêté.
         *
         * Sans `after`, la pagination par clé repartait de `null` à chaque
         * exécution : le balayage rebalayait indéfiniment les `limit` plus
         * petits `_id` et le reste n'était JAMAIS vérifié — 5 000 sur 20 000
         * portefeuilles, toujours les mêmes, sur le seul contrôle qui vérifie
         * l'invariant 2 de bout en bout.
         *
         * `keepResults: false` : un balayage de fond n'a pas à garder en
         * mémoire des milliers de verdicts « OK » que personne ne lira. Seuls
         * les écarts sont conservés.
         */
        const reprise = axeWalletLedgerActif() ? await dernierPointDeReprise() : null;

        const walletLedger = axeWalletLedgerActif()
          ? await reconcileWalletsAgainstLedger({
              limit,
              after: reprise.lastSeen,
              keepResults: false,
            })
          : null;

        const report = mergeReports(internal, provider, walletLedger);
        const durationMs = Date.now() - t0;

        const doc = buildRunDocument(report, {
          workerId: WORKER_ID,
          startedAt,
          durationMs,
          walletLedgerSweep: construireEtatBalayage(walletLedger, reprise),
        });

        await runModel().create(doc);

        /**
         * Le niveau de journal suit le résultat, pas la réussite technique : un
         * balayage qui aboutit ET trouve des écarts n'est pas un succès.
         */
        if (doc.healthy) {
          /**
           * La couverture du balayage tournant figure ici, sinon « aucun écart »
           * se lit comme « toute la population va bien » alors qu'une tranche
           * seulement a été regardée (règle B.6).
           */
          logger.info?.("[RECONCILE] aucun écart", {
            durationMs,
            checked: doc.checked,
            walletLedgerSweep: doc.walletLedgerSweep
              ? {
                  population: doc.walletLedgerSweep.population,
                  rotationCompleted: doc.walletLedgerSweep.rotationCompleted,
                  sweepsSinceRotation: doc.walletLedgerSweep.sweepsSinceRotation,
                }
              : "axe désactivé",
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
  /**
   * Travail d'un tour. Injectable pour que le test de câblage exerce le VRAI
   * `startReconciliationWorker` sans ouvrir de connexion Mongo (règle B.5).
   */
  runOnce = runReconciliationOnce,
} = {}) {
  if (!enabled) {
    logger.info?.(
      "[RECONCILE] worker désactivé (RECONCILIATION_WORKER=false) — " +
        "la réconciliation reste disponible via `npm run reconcile:transactions`."
    );

    // Déclaré même éteint : une série absente n'alerte pas. Voir
    // `services/workerMetrics.js`.
    declareWorker(WORKERS.RECONCILIATION, { enabled: false, logger });

    return null;
  }

  /**
   * ⚠️ CETTE MESURE N'EST PAS CELLE DE `reconciliation_last_run_age_seconds`.
   *
   * Celle-là (exposée par le backend principal, qui lit `reconciliation_runs`)
   * dit quand la réconciliation a réellement BALAYÉ, quelle que soit
   * l'instance. Celle-ci dit que la BOUCLE DE CETTE INSTANCE est vivante.
   *
   * Conséquence assumée : un tour qui n'obtient pas le verrou (une autre
   * instance balaie déjà) compte quand même comme un passage. C'est voulu —
   * sinon, sur une flotte de trois instances, deux afficheraient un âge qui
   * monte indéfiniment alors qu'elles fonctionnent parfaitement.
   */
  const metrics = declareWorker(WORKERS.RECONCILIATION, { logger });

  // Plancher à 1 minute : une valeur trop basse transformerait un contrôle en
  // charge permanente sur la base.
  const period = Math.max(60_000, Number(intervalMs) || 24 * 3600 * 1000);

  const tick = async () => {
    try {
      await metrics.record(() => runOnce());
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
    /** Un tour, à la demande. Exposé pour le test de câblage. */
    tick,

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
  construireEtatBalayage,
};
