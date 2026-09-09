"use strict";

/**
 * ============================================================================
 * OBSERVABILITÉ DES TRAVAILLEURS DE FOND (§A5.4)
 * ============================================================================
 *
 * ═══ CE QUE PERSONNE NE POUVAIT VOIR ═════════════════════════════════════
 *
 * Ce service fait tourner CINQ boucles de fond — annulation automatique des
 * transactions, réconciliation, file de parrainage, rejeu de règlement, et le
 * ramasseur de verrous de parrainage (`referral-lock-reaper`), qui est un second
 * `setInterval` du même fichier que la file. Voir le commentaire de `WORKERS`
 * ci-dessous : c'est en écrivant « les quatre workers » qu'on a failli l'oublier.
 * Relevé sur le service réel le 2026-08-28 :
 *
 *   • `/metrics` : 40 familles exposées (HTTP, pool Mongo, Redis, métriques
 *     Node). **Aucune** ne mentionne un worker, un cron, une file ;
 *   • `/readyz` : `services/readiness.js` ne contrôle que `["main", "tx"]` ;
 *   • journaux : des lignes périodiques que personne ne surveille.
 *
 * Si un worker meurt — exception non rattrapée, minuterie qui cesse d'être
 * replanifiée —, `/readyz` reste vert, `/metrics` ne dit rien, et le seul signal
 * est l'**absence** de lignes de journal. On ne surveille pas une absence : on
 * la découvre des semaines plus tard, quand quelqu'un remarque que des
 * transactions expirées n'ont jamais été annulées.
 *
 * ═══ POURQUOI UN ÂGE, ET SURTOUT PAS UN COMPTEUR ═════════════════════════
 *
 * C'est LE point de conception de ce fichier, et il n'est pas négociable.
 *
 * Un compteur d'exécutions ne distingue pas « le worker ne tourne plus » de
 * « le worker tourne et n'a rien eu à faire » : dans les deux cas le compteur
 * reste immobile. Le worker de réconciliation passe une fois par jour, celui de
 * rejeu toutes les quinze minutes et ne trouve presque jamais rien — un
 * compteur figé y est le comportement NORMAL.
 *
 * Seul un **âge** détecte une absence, parce qu'il monte tout seul quand rien
 * ne se passe :
 *
 *     worker_last_run_age_seconds{worker="tx-auto-cancel"} > 1800
 *
 * L'âge alerte. Les autres séries (exécutions, échecs, durée) expliquent ce que
 * l'alerte a réveillé. C'est le même raisonnement que
 * `reconciliation_last_run_age_seconds` côté backend principal, généralisé aux
 * quatre workers.
 *
 * ═══ CE QUE VAUT L'ÂGE QUAND IL N'Y A PAS EU DE PASSAGE ══════════════════
 *
 * Trois situations, trois valeurs, jamais confondues :
 *
 *   1. worker démarré, aucun passage encore terminé → âge compté depuis le
 *      DÉMARRAGE DU WORKER. C'est le cas le plus important : un worker qui
 *      démarre puis ne tourne jamais (minuterie jamais replanifiée) doit
 *      alerter, et il alerterait pas si on renvoyait 0 ou -1. Il reste
 *      distinguable d'un worker qui tourne grâce à `worker_runs` = 0 et
 *      `worker_last_run_timestamp_seconds` = 0 ;
 *   2. worker désactivé par configuration (`SETTLEMENT_REPLAY_WORKER≠true`,
 *      `RECONCILIATION_WORKER=false`) → **-1**. Un âge qui monte produirait une
 *      alerte permanente sur quelque chose de volontairement éteint ;
 *   3. worker jamais déclaré dans ce processus — il n'a pas démarré du tout,
 *      par exemple parce que `startAutoCancelWorker()` a levé et que server.js
 *      a rattrapé → **-1** sur l'âge, mais `worker_enabled` vaut **-1** lui
 *      aussi, et c'est CETTE série qui porte l'alerte de ce cas.
 *
 * Zéro n'est jamais utilisé pour dire « je ne sais pas » : zéro se lit
 * « passage à l'instant », c'est-à-dire l'inverse exact de la réalité.
 *
 * ═══ UN PASSAGE EN ÉCHEC RESTE UN PASSAGE ════════════════════════════════
 *
 * Un tour qui lève met quand même à jour l'âge. L'âge répond à « est-ce que ça
 * tourne encore ? » ; « est-ce que ça marche ? » est répondu par
 * `worker_failures` et `worker_last_run_success`. Mélanger les deux ferait
 * qu'un worker qui échoue à chaque tour déclencherait l'alerte « worker mort »,
 * et on chercherait une minuterie perdue au lieu de lire l'erreur.
 *
 * ═══ CARDINALITÉ ═════════════════════════════════════════════════════════
 *
 * Une seule étiquette, `worker`, à valeurs **fermées** : `KNOWN_WORKERS`. Un nom
 * inconnu n'est jamais publié — il est refusé avec un avertissement, et le
 * worker continue de tourner sans métrique. Voir l'en-tête de `metrics.js` :
 * une étiquette à valeur libre est ce qui fait tomber Prometheus.
 *
 * ═══ UNE MÉTRIQUE NE CASSE JAMAIS UN WORKER ══════════════════════════════
 *
 * Toute la comptabilité de ce module est enveloppée : une erreur de mesure est
 * avalée, l'exécution du worker continue. `record()` relaie en revanche
 * fidèlement l'erreur du travail lui-même — la masquer serait violer la règle
 * B.1 (« ne jamais masquer un problème »).
 *
 * ═══ POURQUOI DES JAUGES SANS SUFFIXE `_total` ═══════════════════════════
 *
 * `registerAsyncGauge` ne construit que des `Gauge`, et `prom-client` ne sait
 * pas FIXER la valeur d'un `Counter` — seulement l'incrémenter. Publier
 * `worker_runs` en compteur supposerait de tenir un delta par scrutation. Une
 * jauge qui recopie le compteur du processus est plus simple et `rate()`
 * fonctionne dessus (Prometheus détecte une remise à zéro sur la BAISSE de la
 * valeur, pas sur le type déclaré). Le suffixe `_total` étant réservé aux
 * compteurs par convention, on ne le met pas. Même choix que `redisMetrics.js`.
 */

/**
 * Catalogue FERMÉ des travailleurs de fond de ce service.
 *
 * Ces noms sont des valeurs d'étiquette : ils sont posés par le code, jamais
 * dérivés d'une donnée. Ajouter un worker se fait ici, et nulle part ailleurs.
 */
const WORKERS = Object.freeze({
  /** `services/transactionAutoCancelService.js` — annule les transactions expirées. */
  TX_AUTO_CANCEL: "tx-auto-cancel",
  /** `services/referral/referralOutboxWorker.js` — livre les événements de parrainage. */
  REFERRAL_OUTBOX: "referral-outbox",
  /** `services/reconciliation/reconciliationScheduler.js` — lit, compare, signale. */
  RECONCILIATION: "reconciliation",
  /** `services/settlement/settlementReplay.js` — achève des règlements déjà acceptés. */
  SETTLEMENT_REPLAY: "settlement-replay",

  /**
   * `services/referral/referralOutboxWorker.js` — SECONDE minuterie du même
   * fichier, distincte de `REFERRAL_OUTBOX`.
   *
   * ⚠️ Elle a failli passer à travers. Le premier passage d'instrumentation a
   * couvert « les quatre workers », et celui-ci n'en est pas un : c'est un
   * second `setInterval` posé dans un worker déjà instrumenté. Vu de loin, le
   * parrainage paraissait couvert.
   *
   * Or il porte sa propre panne : `reapExpiredLocks` libère les verrous
   * expirés. S'il s'arrête, les événements de parrainage restent verrouillés
   * **indéfiniment** — la boucle principale, elle, continue de tourner et
   * affiche un âge parfaitement sain. On aurait donc une série verte à côté
   * d'une file qui ne s'écoule plus.
   *
   * La leçon : ce qui doit être déclaré n'est pas « un worker », c'est **chaque
   * boucle dont l'arrêt a une conséquence**.
   */
  REFERRAL_LOCK_REAPER: "referral-lock-reaper",
});

const KNOWN_WORKERS = Object.freeze(Object.values(WORKERS));

/** Valeur hors domaine : « pas de mesure », jamais « mesure à zéro ». */
const UNKNOWN = -1;

/** États de `worker_enabled`. */
const STATE = Object.freeze({
  NEVER_DECLARED: -1,
  DISABLED: 0,
  ENABLED: 1,
});

/**
 * ============================================================================
 * REGISTRE DE PROCESSUS
 * ============================================================================
 *
 * Les jauges s'enregistrent dans `server.js`, au chargement ; les workers se
 * déclarent dans `bootstrap()`, donc APRÈS. Un registre de processus découple
 * les deux, exactement comme pour les pools Mongo : les jauges parcourent le
 * registre AU MOMENT de la scrutation, et un worker démarré plus tard apparaît
 * de lui-même.
 */
const registry = new Map();

function nowMs() {
  return Date.now();
}

/** Poignée inerte, rendue quand le nom est refusé. Le worker continue. */
const INERT = Object.freeze({
  name: null,
  enabled: false,
  async record(fn) {
    return fn();
  },
  begin() {
    return { success() {}, failure() {} };
  },
  snapshot() {
    return null;
  },
});

/**
 * Déclare un worker au démarrage — **y compris lorsqu'il est désactivé**.
 *
 * ⚠️ La déclaration est ce qui rend l'absence visible. Sans elle, un worker qui
 * ne démarre pas n'a simplement aucune série, et une série absente ne déclenche
 * aucune alerte. C'est la panne exacte que cette tâche vise.
 *
 * @param {string}   name             une valeur de `WORKERS`, jamais autre chose
 * @param {object}   [opts]
 * @param {boolean}  [opts.enabled]   `false` = éteint par configuration
 * @param {object}   [opts.logger]
 * @param {Function} [opts.now]       injection de test
 * @returns {{name: (string|null), enabled: boolean, record: Function, begin: Function, snapshot: Function}}
 */
function declareWorker(name, { enabled = true, logger = console, now = nowMs } = {}) {
  if (!KNOWN_WORKERS.includes(name)) {
    /**
     * Refusé, pas publié : une étiquette à valeur libre ferait une série par
     * valeur. On ne lève pas — `TX_AUTO_CANCEL_REQUIRED` fait échouer le
     * démarrage si le worker d'auto-annulation lève, et une faute de frappe
     * dans un nom de métrique n'a pas à empêcher un service financier de
     * démarrer. B.6 : on dit la conséquence.
     */
    logger?.warn?.(
      `[metrics] worker « ${name} » NON instrumenté : nom absent du catalogue ` +
        `fermé (${KNOWN_WORKERS.join(", ")}). Conséquence : son âge de dernier ` +
        "passage n'apparaîtra pas sur /metrics, et son arrêt restera invisible."
    );

    return INERT;
  }

  const existing = registry.get(name);

  const entry = existing || {
    name,
    runs: 0,
    failures: 0,
    lastRunAt: 0,
    lastDurationMs: UNKNOWN,
    lastSuccess: UNKNOWN,
    running: 0,
  };

  entry.enabled = enabled === true;
  /**
   * Point de départ de l'âge tant qu'aucun passage n'a eu lieu. Remis à jour à
   * chaque déclaration : un worker relancé après un arrêt repart de son
   * redémarrage, ce qui est la lecture attendue.
   */
  entry.declaredAt = now();

  registry.set(name, entry);

  return makeHandle(entry, { now });
}

function makeHandle(entry, { now = nowMs } = {}) {
  /** Ferme un passage. Ne lève jamais : c'est de la comptabilité. */
  function close(startedAt, ok) {
    try {
      entry.running = Math.max(0, entry.running - 1);
      entry.runs += 1;
      if (!ok) entry.failures += 1;

      const ended = now();

      // Un passage en échec MET À JOUR l'âge : il a bien eu lieu.
      entry.lastRunAt = ended;
      entry.lastDurationMs = Math.max(0, ended - startedAt);
      entry.lastSuccess = ok ? 1 : 0;
    } catch {
      // Une métrique ne doit jamais faire échouer un worker.
    }
  }

  /**
   * Ouvre un passage. Rendu séparément de `record` pour les workers dont le
   * tour ne tient pas dans une seule fonction.
   */
  function begin() {
    const startedAt = now();

    try {
      entry.running += 1;
    } catch {}

    let closed = false;

    return {
      success() {
        if (closed) return;
        closed = true;
        close(startedAt, true);
      },
      failure() {
        if (closed) return;
        closed = true;
        close(startedAt, false);
      },
    };
  }

  return {
    name: entry.name,
    get enabled() {
      return entry.enabled;
    },

    /**
     * Enveloppe un tour de worker.
     *
     * ⚠️ L'erreur du travail est **relayée telle quelle**, après avoir été
     * comptée. L'avaler ici transformerait cette instrumentation en dispositif
     * de masquage — l'exact contraire de ce qu'elle sert (règle B.1).
     */
    async record(fn) {
      const passe = begin();

      try {
        const value = await fn();
        passe.success();
        return value;
      } catch (err) {
        passe.failure();
        throw err;
      }
    },

    begin,
    snapshot: () => describe(entry, now()),
  };
}

/**
 * Traduit une entrée du registre en valeurs de jauges.
 *
 * Fonction **pure** : `now` est un paramètre. C'est ce qui permet de vérifier
 * le calcul de vétusté sans attendre.
 */
function describe(entry, now = nowMs()) {
  if (!entry) {
    return {
      state: STATE.NEVER_DECLARED,
      ageSeconds: UNKNOWN,
      lastRunTimestamp: 0,
      lastDurationSeconds: UNKNOWN,
      lastSuccess: UNKNOWN,
      runs: 0,
      failures: 0,
      running: 0,
    };
  }

  if (!entry.enabled) {
    // Éteint volontairement : un âge qui monte serait une alerte permanente
    // sur une décision assumée. Les compteurs restent visibles.
    return {
      state: STATE.DISABLED,
      ageSeconds: UNKNOWN,
      lastRunTimestamp: entry.lastRunAt ? entry.lastRunAt / 1000 : 0,
      lastDurationSeconds:
        entry.lastDurationMs >= 0 ? entry.lastDurationMs / 1000 : UNKNOWN,
      lastSuccess: entry.lastSuccess,
      runs: entry.runs,
      failures: entry.failures,
      running: entry.running > 0 ? 1 : 0,
    };
  }

  /**
   * Aucun passage terminé : l'âge court depuis le DÉMARRAGE du worker. C'est
   * ce qui fait alerter un worker qui démarre et ne tourne jamais.
   */
  const reference = entry.lastRunAt || entry.declaredAt || now;

  return {
    state: STATE.ENABLED,
    ageSeconds: Math.max(0, (now - reference) / 1000),
    lastRunTimestamp: entry.lastRunAt ? entry.lastRunAt / 1000 : 0,
    lastDurationSeconds:
      entry.lastDurationMs >= 0 ? entry.lastDurationMs / 1000 : UNKNOWN,
    lastSuccess: entry.lastSuccess,
    runs: entry.runs,
    failures: entry.failures,
    running: entry.running > 0 ? 1 : 0,
  };
}

/**
 * État de TOUS les workers du catalogue — y compris ceux qui ne se sont jamais
 * déclarés, qui sortent en `state: -1`.
 *
 * ⚠️ C'est volontaire : publier la série d'un worker absent est la seule façon
 * de rendre son absence alertable. Le catalogue est fermé, donc le nombre de
 * séries est constant et connu (4).
 */
function snapshotAll(now = nowMs()) {
  return KNOWN_WORKERS.map((name) => ({
    worker: name,
    ...describe(registry.get(name), now),
  }));
}

/** Remise à zéro — réservée aux tests. */
function resetWorkerRegistry() {
  registry.clear();
}

/**
 * Enregistre les jauges de worker sur le registre de métriques du service.
 *
 * @param {object}   metrics           l'objet rendu par `createMetrics()`
 * @param {object}   [deps]
 * @param {Function} [deps.snapshots]  injection de test
 * @param {object}   [deps.logger]
 * @returns {{registered: boolean, workers: string[]}}
 */
function registerWorkerMetrics(metrics, { snapshots = snapshotAll, logger = console } = {}) {
  if (!metrics?.registerAsyncGauge) {
    /**
     * B.6 : si les métriques de worker ne peuvent pas s'enregistrer, on le dit
     * avec la conséquence — puis on lève, parce que l'appelant (`server.js`)
     * passe un objet qu'il vient de construire : s'il est invalide, c'est une
     * faute de câblage, pas une condition d'exploitation.
     */
    logger?.error?.(
      "[metrics] métriques de worker NON exposées : registre de métriques " +
        "invalide. Conséquence : l'arrêt d'un travailleur de fond (annulation " +
        "automatique, réconciliation, parrainage, rejeu) resterait invisible — " +
        "aucune alerte, seulement une absence de lignes de journal."
    );

    throw new Error("registerWorkerMetrics : `metrics` invalide");
  }

  function gauge(name, help, read) {
    metrics.registerAsyncGauge({
      name,
      help,
      labelNames: ["worker"],
      collect: (g) => {
        /**
         * `reset()` avant chaque série : sans lui, une série retirée du
         * catalogue garderait sa dernière valeur pour toujours. Même raison que
         * dans `mongoPoolMetrics.js` et `reconciliationMetrics.js`.
         */
        g.reset?.();

        for (const s of snapshots()) {
          g.set({ worker: s.worker }, read(s));
        }
      },
    });
  }

  gauge(
    "worker_last_run_age_seconds",
    "Secondes écoulées depuis la FIN du dernier passage du worker — depuis son " +
      "démarrage s'il n'a encore jamais tourné. -1 s'il est désactivé ou n'a " +
      "jamais démarré. C'EST la métrique à alerter : un compteur d'exécutions " +
      "ne distingue pas « ne tourne plus » de « rien à faire », un âge si.",
    (s) => s.ageSeconds
  );

  gauge(
    "worker_last_run_timestamp_seconds",
    "Horodatage Unix de la fin du dernier passage. 0 si le worker n'a jamais " +
      "tourné dans ce processus — à lire avec worker_last_run_age_seconds, qui " +
      "court alors depuis le démarrage du worker.",
    (s) => s.lastRunTimestamp
  );

  gauge(
    "worker_last_run_duration_seconds",
    "Durée du dernier passage terminé. -1 si aucun. Un allongement régulier " +
      "annonce un worker qui finira par ne plus tenir dans son intervalle.",
    (s) => s.lastDurationSeconds
  );

  gauge(
    "worker_runs",
    "Passages terminés depuis le démarrage du processus, succès ET échecs " +
      "confondus (cumulé). Explique l'alerte d'âge ; ne la remplace pas.",
    (s) => s.runs
  );

  gauge(
    "worker_failures",
    "Passages ayant levé une erreur depuis le démarrage du processus (cumulé). " +
      "Un worker qui échoue à chaque tour garde un âge frais : c'est ici qu'il " +
      "se voit, pas dans l'âge.",
    (s) => s.failures
  );

  gauge(
    "worker_last_run_success",
    "1 si le dernier passage s'est terminé, 0 s'il a levé, -1 si aucun passage",
    (s) => s.lastSuccess
  );

  gauge(
    "worker_enabled",
    "1 worker déclaré et actif, 0 déclaré mais éteint par configuration, " +
      "-1 JAMAIS DÉCLARÉ dans ce processus — ce dernier cas signifie que le " +
      "worker n'a pas démarré du tout, et il doit alerter.",
    (s) => s.state
  );

  gauge(
    "worker_running",
    "1 si un passage était en cours au moment de la scrutation. Distingue un " +
      "worker bloqué dans un tour d'un worker qui n'est plus planifié.",
    (s) => s.running
  );

  logger?.info?.(
    `[metrics] métriques de worker exposées sur /metrics pour ${KNOWN_WORKERS.length} ` +
      `workers (${KNOWN_WORKERS.join(", ")}) : âge du dernier passage, exécutions, ` +
      "échecs, durée. Un worker qui ne se déclare pas sort en worker_enabled=-1."
  );

  return { registered: true, workers: [...KNOWN_WORKERS] };
}

module.exports = {
  WORKERS,
  KNOWN_WORKERS,
  STATE,
  UNKNOWN,
  declareWorker,
  describe,
  snapshotAll,
  resetWorkerRegistry,
  registerWorkerMetrics,
};
