"use strict";

const mongoose = require("mongoose");

/**
 * ============================================================================
 * HISTORIQUE DES RÉCONCILIATIONS
 * ============================================================================
 *
 * POURQUOI GARDER UNE TRACE, PLUTÔT QUE DE SE CONTENTER DE JOURNALISER
 * -------------------------------------------------------------------
 * `transactionReconciliationService` produisait un rapport, le journalisait, et
 * l'oubliait. Le seul déclencheur était un script lancé à la main. Résultat :
 * personne ne pouvait répondre à « quand la dernière réconciliation a-t-elle
 * tourné, et qu'a-t-elle trouvé ? » — la question exacte que pose un auditeur,
 * et celle qu'on se pose à 3 h du matin pendant un incident.
 *
 * Un journal applicatif répond mal à cela : il tourne, il est volumineux, il
 * n'est pas requêtable par agrégat. Une collection l'est.
 *
 * CE QUE CE DOCUMENT PERMET, ET QUI N'EXISTAIT PAS
 * -----------------------------------------------
 *   • savoir si la réconciliation TOURNE (une exécution qui n'a pas lieu est
 *     invisible dans les journaux — il n'y a rien à voir) ;
 *   • suivre l'évolution du nombre d'écarts dans le temps ;
 *   • alimenter une métrique Prometheus sans relancer le balayage ;
 *   • conserver la preuve d'un contrôle périodique.
 *
 * ⚠️ CE DOCUMENT NE CORRIGE RIEN ET NE DÉCIDE RIEN.
 * La règle du service de réconciliation reste entière : il lit, il compare, il
 * signale, jamais une écriture financière. Ce modèle n'enregistre que le
 * COMPTE-RENDU d'une lecture.
 *
 * POURQUOI UN ÉCHANTILLON D'ANOMALIES ET NON TOUTES
 * -------------------------------------------------
 * Un balayage dégradé peut produire des milliers d'écarts. Les stocker tous
 * ferait des documents énormes, jusqu'à heurter la limite de 16 Mo de MongoDB —
 * et l'écriture du rapport échouerait précisément le jour où il est le plus
 * utile. On garde donc le COMPTE exact et un ÉCHANTILLON borné : le compte sert
 * à alerter, l'échantillon à commencer le diagnostic, et le balayage complet
 * reste rejouable à la demande via `npm run reconcile:transactions`.
 */

/** Au-delà, on ne stocke plus les anomalies elles-mêmes — voir l'en-tête. */
const MAX_STORED_ANOMALIES = 100;

/**
 * Rétention. Assez long pour couvrir un contrôle trimestriel, assez court pour
 * que la collection ne grossisse pas indéfiniment : une exécution par jour tient
 * en quelques centaines de documents.
 */
const RETENTION_DAYS = 180;

const reconciliationRunSchema = new mongoose.Schema(
  {
    /** Nom de la tâche — plusieurs réconciliations coexisteront (parrainage…). */
    job: {
      type: String,
      required: true,
      trim: true,
      default: "transaction-reconciliation",
      index: true,
    },

    /**
     * `running` existe pour que l'ABSENCE de fin soit visible. Un processus tué
     * en cours laisse un document `running` : c'est le seul moyen de distinguer
     * « n'a jamais démarré » de « démarré puis mort ».
     */
    status: {
      type: String,
      enum: ["running", "completed", "failed"],
      default: "running",
      required: true,
      index: true,
    },

    /** `hostname:pid:aléa` — quelle instance a exécuté. */
    workerId: { type: String, default: "", trim: true },

    /**
     * ⚠️ PAS de `index: true` ICI — l'index de ce champ est le TTL déclaré plus
     * bas, et MongoDB n'accepte qu'UN index par clé. Les deux déclarations
     * entraient en collision : la première posée gagnait, la seconde échouait
     * sur « An equivalent index already exists with different options ».
     *
     * En pratique c'est le TTL qui perdait — donc les exécutions de
     * réconciliation n'expiraient jamais. Un index TTL sert AUSSI les
     * requêtes de plage sur son champ : rien n'est perdu à n'avoir que lui.
     */
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },

    /** Fenêtre analysée, pour que le rapport soit interprétable seul. */
    window: {
      sinceHours: { type: Number, default: null },
      since: { type: Date, default: null },
    },

    checked: {
      wallets: { type: Number, default: 0 },
      transactions: { type: Number, default: 0 },
      ledgerEntries: { type: Number, default: 0 },
      reservations: { type: Number, default: 0 },

      /**
       * ═══ AXE PRESTATAIRE ═══════════════════════════════════════════════
       *
       * Les quatre compteurs ci-dessus mesurent la cohérence INTERNE : nos
       * données entre elles. Ils peuvent tous être verts pendant que l'argent
       * est perdu — il suffit que nous soyons cohéremment en désaccord avec le
       * prestataire.
       *
       * Ces deux-là mesurent le second axe : ce que le prestataire nous a dit
       * (`providerEvents`) et ce qu'il ne nous a jamais dit
       * (`awaitingSettlement`). Un compteur à zéro n'y est PAS rassurant, c'est
       * le sens de `registry` juste en dessous.
       */
      providerEvents: { type: Number, default: 0 },
      awaitingSettlement: { type: Number, default: 0 },
    },

    /**
     * ⚠️ SANS CE BLOC, UN RAPPORT VERT EST AMBIGU.
     *
     * Le contrôle des silences prestataire (`SETTLEMENT_TIMEOUT`) ne peut rien
     * conclure tant que le registre des rappels est vide : avant son premier
     * enregistrement, « aucun rappel reçu » et « on n'enregistrait pas encore »
     * sont indistinguables. Le contrôle se saute alors — et il faut que le
     * rapport le DISE, sinon « 0 anomalie » se lit comme « tout va bien » alors
     * que la question n'a pas été posée.
     *
     * `floorAt` est la date à partir de laquelle on peut affirmer qu'on
     * enregistrait, c'est-à-dire celle du plus ancien rappel connu.
     */
    registry: {
      floorAt: { type: Date, default: null },
      reason: { type: String, default: null },
      settlementTimeoutSkipped: { type: Boolean, default: false },
    },

    healthy: { type: Boolean, default: null, index: true },

    /** Compte EXACT, indépendant de l'échantillon stocké. */
    anomalyCount: { type: Number, default: 0, index: true },

    /** `{ WALLET_IMBALANCE: 3, STUCK_RESERVATION: 12 }` — de quoi alerter par type. */
    anomaliesByType: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    /** Échantillon borné à MAX_STORED_ANOMALIES. */
    anomalies: {
      type: [mongoose.Schema.Types.Mixed],
      default: () => [],
    },

    /** Vrai si des anomalies ont été omises de l'échantillon. */
    anomaliesTruncated: { type: Boolean, default: false },

    error: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: "reconciliation_runs",
    versionKey: false,
  }
);

/** Dernière exécution d'une tâche donnée — la requête la plus fréquente. */
reconciliationRunSchema.index({ job: 1, startedAt: -1 });

reconciliationRunSchema.index(
  { startedAt: 1 },
  {
    expireAfterSeconds: RETENTION_DAYS * 24 * 3600,
    name: "reconciliation_runs_ttl",
  }
);

module.exports = (conn = mongoose) =>
  conn.models.ReconciliationRun ||
  conn.model("ReconciliationRun", reconciliationRunSchema);

module.exports.MAX_STORED_ANOMALIES = MAX_STORED_ANOMALIES;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
