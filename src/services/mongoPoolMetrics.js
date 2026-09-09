"use strict";

/**
 * ============================================================================
 * SATURATION DU POOL DE CONNEXIONS MONGODB (§41)
 * ============================================================================
 *
 * ⚠️ FICHIER RÉPLIQUÉ À L'IDENTIQUE DANS LES TROIS SERVICES
 * (`api-paynoval`, `paynoval-backend`, `api-gateway` s'il ouvre un jour une
 * connexion). Dépôts séparés, pas de paquet commun — même convention que
 * `metrics.js` et `redisStoreSafety.js`.
 *
 * ═══ LA QUESTION À LAQUELLE PERSONNE NE POUVAIT RÉPONDRE ═════════════════
 *
 * `MONGO_MAX_POOL_SIZE` vaut **15 par défaut** (`config/db.js`) sans qu'aucune
 * mesure ne le justifie. 15 est-il trop bas — auquel cas les requêtes attendent
 * une connexion et la latence observée n'a rien à voir avec Mongo — ou trop
 * haut ? Sans mesure, monter ou descendre ce chiffre est une superstition.
 *
 * La série qui tranche est `mongodb_pool_pending_checkouts` : le nombre de
 * demandes qui ATTENDENT une connexion libre. Elle vaut zéro tant que le pool
 * suffit. Dès qu'elle décolle, le pool est le goulot — et là seulement,
 * l'augmenter a un sens.
 *
 * ═══ POURQUOI LES ÉVÉNEMENTS, ET PAS UN SONDAGE ══════════════════════════
 *
 * On aurait pu interroger `serverStatus().connections` à chaque scrutation.
 * Trois raisons de ne pas le faire :
 *
 *   1. c'est une commande d'administration, exécutée sur le SERVEUR, à chaque
 *      scrutation et depuis chaque instance — un coût qui grandit avec la
 *      flotte, pour mesurer un état local ;
 *   2. elle rend l'état du serveur, pas celui de NOTRE pool : elle ne sait rien
 *      de nos demandes en attente, ce qui est justement la mesure utile ;
 *   3. entre deux sondages, un pic de saturation passe inaperçu.
 *
 * Le pilote MongoDB émet des événements CMAP (`connectionPoolCreated`,
 * `connectionCheckOutStarted`, `connectionCheckedOut`, `connectionCheckOutFailed`,
 * `connectionCheckedIn`, `connectionCreated`, `connectionClosed`) sur le
 * `MongoClient`, sans option à activer. C'est la source exacte, en temps réel et
 * gratuite.
 *
 * ═══ CE QUE MESURE L'ÉTIQUETTE `pool` ════════════════════════════════════
 *
 * Elle nomme le POOL, pas la base. Ce service ouvre deux connexions Mongoose
 * (users, transactions) qui, lorsque les deux URI ne diffèrent que par le nom de
 * la base, PARTAGENT le même `MongoClient` — condition de l'atomicité
 * inter-bases (voir `config/db.js`). Il n'y a alors qu'UN pool, et donc une
 * seule série, étiquetée `users+transactions` : les 15 connexions servent les
 * deux bases. Publier deux séries compterait deux fois le même pool.
 *
 * ═══ CARDINALITÉ ═════════════════════════════════════════════════════════
 *
 * Deux étiquettes seulement, toutes deux à valeurs fermées : `pool` (nommé par
 * le code, jamais par une donnée) et `reason` (liste blanche du pilote, tout le
 * reste replié sur `other`). Aucune adresse de serveur n'est exposée : elle
 * révélerait la topologie du cluster et ferait une série par nœud.
 */

/** Noms d'événements CMAP — identiques dans les pilotes 4.x, 5.x et 6.x. */
const POOL_EVENTS = Object.freeze({
  POOL_CREATED: "connectionPoolCreated",
  POOL_CLEARED: "connectionPoolCleared",
  POOL_CLOSED: "connectionPoolClosed",
  CREATED: "connectionCreated",
  CLOSED: "connectionClosed",
  CHECK_OUT_STARTED: "connectionCheckOutStarted",
  CHECKED_OUT: "connectionCheckedOut",
  CHECK_OUT_FAILED: "connectionCheckOutFailed",
  CHECKED_IN: "connectionCheckedIn",
});

/** Motifs de fermeture connus du pilote. Tout autre motif est replié. */
const CLOSE_REASONS = Object.freeze(["stale", "idle", "error", "poolClosed"]);

/** Motifs d'échec de sortie de pool connus du pilote. */
const CHECKOUT_FAIL_REASONS = Object.freeze(["timeout", "connectionError", "poolClosed"]);

function boundReason(reason, allowed) {
  const r = typeof reason === "string" ? reason : "";
  return allowed.includes(r) ? r : "other";
}

function clampPositive(n) {
  return n > 0 ? n : 0;
}

/**
 * Compteur d'événements de pool. **Pur** : aucune I/O, aucune dépendance au
 * pilote. On lui envoie des événements, il rend un état — donc il se teste avec
 * un faux émetteur, sans Mongo.
 *
 * @param {object} deps
 * @param {string} deps.name  nom du pool (valeur d'étiquette, fermée)
 */
function createPoolTracker({ name }) {
  if (!name) throw new Error("createPoolTracker : `name` manquant");

  const names = [name];

  const state = {
    maxPoolSize: 0,
    minPoolSize: 0,
    created: 0,
    closed: 0,
    closedByReason: Object.create(null),
    checkOutsStarted: 0,
    checkedOut: 0,
    checkOutFailures: 0,
    checkOutFailuresByReason: Object.create(null),
    checkedIn: 0,
    clears: 0,
    poolClosed: 0,
  };

  function bump(bucket, key) {
    bucket[key] = (bucket[key] || 0) + 1;
  }

  /**
   * Applique un événement. Séparé de `attach` pour être exercé directement dans
   * les tests, avec les charges utiles exactes du pilote.
   */
  function record(event, payload = {}) {
    switch (event) {
      case POOL_EVENTS.POOL_CREATED:
        /**
         * La taille maximale vient du PILOTE, pas de `process.env`. C'est la
         * valeur réellement appliquée : une variable d'environnement mal
         * orthographiée, une option écrasée en chemin, et la lecture de l'env
         * mentirait exactement au moment où on cherche à comprendre.
         */
        state.maxPoolSize = Number(payload?.options?.maxPoolSize) || 0;
        state.minPoolSize = Number(payload?.options?.minPoolSize) || 0;
        break;

      case POOL_EVENTS.CREATED:
        state.created += 1;
        break;

      case POOL_EVENTS.CLOSED:
        state.closed += 1;
        bump(state.closedByReason, boundReason(payload?.reason, CLOSE_REASONS));
        break;

      case POOL_EVENTS.CHECK_OUT_STARTED:
        state.checkOutsStarted += 1;
        break;

      case POOL_EVENTS.CHECKED_OUT:
        state.checkedOut += 1;
        break;

      case POOL_EVENTS.CHECK_OUT_FAILED:
        state.checkOutFailures += 1;
        bump(
          state.checkOutFailuresByReason,
          boundReason(payload?.reason, CHECKOUT_FAIL_REASONS)
        );
        break;

      case POOL_EVENTS.CHECKED_IN:
        state.checkedIn += 1;
        break;

      case POOL_EVENTS.POOL_CLEARED:
        state.clears += 1;
        break;

      case POOL_EVENTS.POOL_CLOSED:
        state.poolClosed += 1;
        break;

      default:
        break;
    }
  }

  /**
   * État courant du pool.
   *
   * ⚠️ Les valeurs instantanées sont BORNÉES À ZÉRO. Le pilote peut fermer une
   * connexion empruntée pendant une purge de pool : le décompte deviendrait
   * négatif, et une jauge négative ferait croire à un défaut de mesure alors que
   * l'information utile (le pool a été purgé) est portée par
   * `mongodb_pool_clears`.
   */
  function snapshot() {
    const size = clampPositive(state.created - state.closed);
    const checkedOut = clampPositive(state.checkedOut - state.checkedIn);

    return {
      name: names.join("+"),
      maxPoolSize: state.maxPoolSize,
      minPoolSize: state.minPoolSize,
      size,
      checkedOut,
      available: clampPositive(size - checkedOut),
      /**
       * LA mesure de saturation : des demandes de connexion commencées qui
       * n'ont ni abouti ni échoué — donc qui attendent.
       */
      pending: clampPositive(
        state.checkOutsStarted - state.checkedOut - state.checkOutFailures
      ),
      created: state.created,
      closed: state.closed,
      closedByReason: { ...state.closedByReason },
      checkOuts: state.checkedOut,
      checkOutFailures: state.checkOutFailures,
      checkOutFailuresByReason: { ...state.checkOutFailuresByReason },
      clears: state.clears,
    };
  }

  /**
   * S'abonne aux événements CMAP d'un `MongoClient`.
   *
   * @returns {Function} détachement (utile aux tests et à l'arrêt propre)
   */
  function attach(emitter) {
    if (!emitter || typeof emitter.on !== "function") return () => {};

    /**
     * ========================================================================
     * L'ÉVÉNEMENT `connectionPoolCreated` EST DÉJÀ PASSÉ QUAND ON S'ABONNE
     * ========================================================================
     *
     * `attachPoolMetrics()` est appelé APRÈS la connexion (`config/db.js`),
     * parce qu'avant elle il n'y a pas de `MongoClient` auquel s'abonner. Or le
     * pilote émet `connectionPoolCreated` PENDANT la connexion : au moment où
     * on pose l'écouteur, l'événement est déjà émis et ne reviendra pas.
     *
     * Conséquence constatée en production de banc le 2026-08-28 :
     *
     *     mongodb_pool_max_size{pool="users+transactions"} 0
     *
     * alors que `maxPoolSize` valait 15. **La jauge censée justifier le
     * dimensionnement du pool affichait zéro.**
     *
     * ⚠️ Les tests unitaires ne pouvaient pas l'attraper : ils appellent
     * `record(POOL_CREATED, …)` directement et vérifient le réducteur. Le
     * réducteur était correct. C'est le CÂBLAGE qui perdait l'événement — et
     * un test qui alimente lui-même l'événement ne teste jamais qu'il arrive.
     *
     * On amorce donc l'état depuis les options EFFECTIVES du client. Ce reste
     * la valeur du PILOTE — pas une relecture de `process.env`, qui mentirait
     * exactement dans le cas qu'on cherche à diagnostiquer (variable mal
     * orthographiée, option écrasée en chemin).
     */
    if (!state.maxPoolSize) {
      const options = emitter?.options || emitter?.s?.options;
      if (options) {
        state.maxPoolSize = Number(options.maxPoolSize) || 0;
        state.minPoolSize = Number(options.minPoolSize) || 0;
      }
    }

    const bound = [];

    for (const event of Object.values(POOL_EVENTS)) {
      const handler = (payload) => {
        try {
          record(event, payload);
        } catch {
          // Une métrique ne doit jamais faire échouer le pilote.
        }
      };

      emitter.on(event, handler);
      bound.push([event, handler]);
    }

    return () => {
      for (const [event, handler] of bound) {
        emitter.off?.(event, handler) ?? emitter.removeListener?.(event, handler);
      }
    };
  }

  return {
    get names() {
      return [...names];
    },
    addAlias(alias) {
      if (alias && !names.includes(alias)) names.push(alias);
      return names;
    },
    record,
    snapshot,
    attach,
  };
}

/**
 * ============================================================================
 * REGISTRE DE PROCESSUS
 * ============================================================================
 *
 * L'abonnement se fait dans `config/db.js`, au moment de la connexion ; les
 * jauges s'enregistrent dans `server.js`, au chargement — donc AVANT. Un registre
 * de processus découple les deux : les jauges parcourent les pools au moment de
 * la scrutation, et un pool connecté plus tard apparaît tout seul.
 */
const byName = new Map();
const byClient = new Map();

/**
 * Suit le pool d'un `MongoClient`.
 *
 * ⚠️ UN CLIENT DÉJÀ SUIVI N'EST JAMAIS RÉ-ABONNÉ : les deux connexions Mongoose
 * partagent souvent le même client (`useDb`), et un second abonnement compterait
 * chaque événement deux fois. Le second nom devient un alias, et le journal de
 * démarrage le dit — un pool partagé qu'on croit dédié conduit à mal lire la
 * saturation.
 *
 * @returns {{tracker: object, shared: boolean}|null}
 */
function trackPool(client, name, { logger = console } = {}) {
  if (!client || typeof client.on !== "function") {
    logger?.warn?.(
      `[metrics] pool Mongo « ${name} » NON instrumenté : aucun MongoClient ` +
        "exposé par la connexion. Conséquence : la saturation du pool (demandes " +
        "en attente, échecs de sortie) restera invisible sur /metrics."
    );

    return null;
  }

  const existing = byClient.get(client);

  if (existing) {
    // Déjà suivi sous ce nom : `connectTransactionsDB()` est idempotente et peut
    // être rappelée. On ne ré-abonne pas, et on ne rejournalise pas.
    if (existing.names.includes(name)) return { tracker: existing, shared: false };

    existing.addAlias(name);
    byName.set(existing.snapshot().name, existing);

    logger?.info?.(
      `[metrics] pool Mongo « ${name} » PARTAGÉ avec « ${existing.names
        .filter((n) => n !== name)
        .join(", ")} » — un seul MongoClient, donc une seule série ` +
        `(pool="${existing.snapshot().name}").`
    );

    return { tracker: existing, shared: true };
  }

  const tracker = createPoolTracker({ name });
  tracker.attach(client);

  byClient.set(client, tracker);
  byName.set(name, tracker);

  logger?.info?.(`[metrics] pool Mongo « ${name} » instrumenté (événements CMAP).`);

  return { tracker, shared: false };
}

/** Pools suivis, dédoublonnés (un tracker aliasé ne compte qu'une fois). */
function listTrackers() {
  return [...new Set(byClient.values())];
}

/** Remise à zéro — réservée aux tests. */
function resetPoolRegistry() {
  byName.clear();
  byClient.clear();
}

/**
 * Enregistre les jauges de pool sur le registre de métriques du service.
 *
 * @param {object}   metrics             l'objet rendu par `createMetrics()`
 * @param {object}   [deps]
 * @param {Function} [deps.trackers]     injection de test
 * @param {object}   [deps.logger]
 */
function registerMongoPoolMetrics(metrics, { trackers = listTrackers, logger = console } = {}) {
  if (!metrics?.registerAsyncGauge) {
    throw new Error("registerMongoPoolMetrics : `metrics` invalide");
  }

  function snapshots() {
    return trackers().map((t) => t.snapshot());
  }

  /**
   * `reset()` avant chaque série de `set` : un pool fermé (ou un motif d'échec
   * qui ne se reproduit plus) garderait sinon sa dernière valeur pour toujours,
   * et l'alerte resterait allumée après la fin de l'incident. Même raison que
   * dans `reconciliationMetrics.js`.
   */
  function simple(name, help, read) {
    metrics.registerAsyncGauge({
      name,
      help,
      labelNames: ["pool"],
      collect: (gauge) => {
        gauge.reset?.();

        for (const s of snapshots()) {
          gauge.set({ pool: s.name }, read(s));
        }
      },
    });
  }

  simple(
    "mongodb_pool_size",
    "Connexions ouvertes détenues par le pool (créées - fermées)",
    (s) => s.size
  );

  simple(
    "mongodb_pool_available",
    "Connexions ouvertes et disponibles immédiatement",
    (s) => s.available
  );

  simple(
    "mongodb_pool_checked_out",
    "Connexions actuellement empruntées par une opération",
    (s) => s.checkedOut
  );

  simple(
    "mongodb_pool_pending_checkouts",
    "Demandes de connexion EN ATTENTE d'une sortie de pool. C'est LA mesure de " +
      "saturation : au-dessus de zéro durablement, le pool est le goulot.",
    (s) => s.pending
  );

  simple(
    "mongodb_pool_max_size",
    "Taille maximale du pool telle qu'appliquée par le pilote (maxPoolSize)",
    (s) => s.maxPoolSize
  );

  simple(
    "mongodb_pool_min_size",
    "Taille minimale du pool (minPoolSize). À 0, une connexion inactive est " +
      "fermée puis recréée : c'est ce qui explique une forte rotation.",
    (s) => s.minPoolSize
  );

  simple(
    "mongodb_pool_connections_created",
    "Connexions ouvertes depuis le démarrage du processus, cumulé. À comparer à " +
      "mongodb_pool_size : un écart qui grandit vite est une rotation, pas une fuite.",
    (s) => s.created
  );

  simple(
    "mongodb_pool_checkouts",
    "Sorties de pool réussies depuis le démarrage du processus, cumulé",
    (s) => s.checkOuts
  );

  simple(
    "mongodb_pool_clears",
    "Purges du pool (perte du serveur, bascule de primaire), cumulé",
    (s) => s.clears
  );

  metrics.registerAsyncGauge({
    name: "mongodb_pool_connections_closed",
    help:
      "Connexions fermées depuis le démarrage, par motif (stale, idle, error, " +
      "poolClosed). `idle` majoritaire = rotation par inactivité, pas un incident.",
    labelNames: ["pool", "reason"],
    collect: (gauge) => {
      gauge.reset?.();

      for (const s of snapshots()) {
        for (const [reason, count] of Object.entries(s.closedByReason)) {
          gauge.set({ pool: s.name, reason }, count);
        }
      }
    },
  });

  metrics.registerAsyncGauge({
    name: "mongodb_pool_checkout_failures",
    help:
      "Échecs de sortie de pool depuis le démarrage, par motif. `timeout` = le " +
      "pool était plein et l'attente a expiré : la requête a échoué faute de connexion.",
    labelNames: ["pool", "reason"],
    collect: (gauge) => {
      gauge.reset?.();

      for (const s of snapshots()) {
        for (const [reason, count] of Object.entries(s.checkOutFailuresByReason)) {
          gauge.set({ pool: s.name, reason }, count);
        }
      }
    },
  });

  logger?.info?.(
    "[metrics] métriques de pool Mongo exposées sur /metrics (taille, " +
      "disponibles, en attente, échecs de sortie)."
  );

  return { registered: true };
}

module.exports = {
  createPoolTracker,
  registerMongoPoolMetrics,
  trackPool,
  listTrackers,
  resetPoolRegistry,
  POOL_EVENTS,
  CLOSE_REASONS,
  CHECKOUT_FAIL_REASONS,
};
