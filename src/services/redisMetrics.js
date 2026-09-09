"use strict";

/**
 * ============================================================================
 * MÉTRIQUES REDIS — LATENCE, MÉMOIRE, TAUX DE SUCCÈS DU CACHE (§37)
 * ============================================================================
 *
 * ⚠️ FICHIER RÉPLIQUÉ À L'IDENTIQUE DANS LES TROIS SERVICES
 * (`api-paynoval`, `paynoval-backend`, `api-gateway`). Dépôts séparés, pas de
 * paquet commun — comme `metrics.js` et `redisStoreSafety.js`. Toute correction
 * ici doit être reportée dans les deux autres.
 *
 * ═══ CE QU'ON NE SAVAIT PAS ══════════════════════════════════════════════
 *
 * Redis porte la limitation de débit des trois services (et, sur la passerelle,
 * le cache des règles de change). On savait dire « Redis est configuré » ; on ne
 * savait dire ni combien de temps il met à répondre, ni s'il approche de sa
 * limite de mémoire, ni si le cache sert à quelque chose. Trois questions dont
 * la réponse change ce qu'on fait pendant un incident.
 *
 * ═══ INVARIANT 8 : AUCUNE REQUÊTE HTTP NE CRÉE DE CONNEXION REDIS ════════
 *
 * Ce module ne construit JAMAIS de client. Il reçoit `getClient()` et se sert du
 * client déjà ouvert par le service. Une scrutation `/metrics` toutes les
 * quinze secondes qui ouvrirait sa propre connexion serait, à l'échelle d'une
 * flotte, une fuite de connexions permanente.
 *
 * ═══ RÈGLE B.4 : RIEN DE SENSIBLE NE SORT ════════════════════════════════
 *
 * `INFO` rend du tout-venant : `run_id`, `config_file`, `executable`,
 * `master_host`, la liste des bases, la version exacte du serveur. Rien de tout
 * cela n'a sa place sur une page de métriques — même protégée. On ne lit donc
 * que les CHAMPS NOMMÉS de `REDIS_INFO_FIELDS`, en liste blanche : ce qui n'y
 * est pas n'est jamais exposé, même si Redis l'ajoute dans une version future.
 *
 * L'URL Redis (qui porte le mot de passe) n'est ni lue ni journalisée ici.
 *
 * ═══ POURQUOI DES COMPTEURS BRUTS, ET PAS UN POURCENTAGE ═════════════════
 *
 * `keyspace_hits` / `keyspace_misses` sont des compteurs CUMULÉS depuis le
 * démarrage du serveur Redis. En faire un pourcentage ici donnerait la moyenne
 * de toute la vie du processus : une valeur qui ne bouge plus au bout de
 * quelques heures et qui masque exactement ce qu'on cherche — la dégradation
 * des dix dernières minutes. On expose donc les deux compteurs bruts, et le
 * taux se calcule à la requête, sur une fenêtre :
 *
 *     rate(redis_keyspace_hits[5m])
 *   / (rate(redis_keyspace_hits[5m]) + rate(redis_keyspace_misses[5m]))
 *
 * ═══ POURQUOI CES SÉRIES CUMULÉES SONT DES JAUGES, SANS SUFFIXE `_total` ══
 *
 * Ce sont les compteurs d'un AUTRE processus (le serveur Redis), lus en valeur
 * absolue. `prom-client` ne sait pas fixer la valeur d'un `Counter` — seulement
 * l'incrémenter — donc les publier en compteur supposerait de recalculer un
 * delta à chaque scrutation, et de deviner ce qu'est un redémarrage de Redis.
 * Une jauge qui recopie la valeur du serveur est plus honnête, et `rate()`
 * fonctionne dessus : Prometheus détecte une remise à zéro sur la BAISSE de la
 * valeur, pas sur le type déclaré. Le suffixe `_total` est en revanche réservé
 * aux compteurs par convention : on ne le met pas sur une jauge.
 *
 * ═══ CARDINALITÉ ═════════════════════════════════════════════════════════
 *
 * Aucune étiquette. Un service, un client Redis, une série par mesure. Voir
 * l'en-tête de `metrics.js` : une étiquette à valeur libre est ce qui fait
 * tomber Prometheus.
 */

/** Une sonde par scrutation, partagée par toutes les jauges. */
const DEFAULT_CACHE_MS = 5000;

/**
 * ⚠️ SANS DÉLAI D'EXPIRATION, UNE SCRUTATION PEUT SE SUSPENDRE.
 *
 * Pendant la connexion initiale, la file d'attente hors ligne d'ioredis est
 * OUVERTE (voir `redisStoreSafety.js`) : un `PING` n'échoue pas, il ATTEND. La
 * requête `/metrics` resterait alors ouverte jusqu'au délai de connexion. Une
 * page de métriques qui se bloque quand la dépendance qu'elle mesure est en
 * panne ne sert précisément à rien.
 */
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Champs d'`INFO` exposés — LISTE BLANCHE. Ne rien ajouter ici sans se demander
 * si le champ peut porter une information d'infrastructure (hôte, chemin,
 * identifiant de processus, topologie de réplication).
 */
const REDIS_INFO_FIELDS = Object.freeze([
  // INFO memory
  "used_memory",
  "used_memory_rss",
  "maxmemory",
  "mem_fragmentation_ratio",
  // INFO stats
  "evicted_keys",
  "expired_keys",
  "keyspace_hits",
  "keyspace_misses",
]);

/**
 * Analyse une réponse `INFO`. Fonction **pure** — c'est la pièce testable.
 *
 * Format Redis : des lignes `clé:valeur` séparées par `\r\n`, des sections
 * introduites par `# Nom`. Une valeur peut contenir un `:`
 * (`db0:keys=1,expires=0`) : on découpe sur le PREMIER seulement.
 */
function parseRedisInfo(raw) {
  const out = Object.create(null);

  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const sep = trimmed.indexOf(":");
    if (sep <= 0) continue;

    out[trimmed.slice(0, sep)] = trimmed.slice(sep + 1);
  }

  return out;
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;

  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Réduit une réponse `INFO` aux seuls champs de la liste blanche, en nombres.
 *
 * Fonction **pure**. C'est le point d'application de la règle B.4 : tout ce qui
 * sort des métriques Redis passe par ici.
 */
function pickInfoFields(parsed) {
  const out = Object.create(null);

  for (const field of REDIS_INFO_FIELDS) {
    const n = toNumber(parsed?.[field]);
    if (n !== undefined) out[field] = n;
  }

  return out;
}

/**
 * Course entre une promesse et un délai.
 *
 * ⚠️ LE MINUTEUR N'EST PAS `unref()`. C'était la première écriture, par réflexe
 * (« ne pas retenir la boucle d'événements »), et c'est faux ici : un minuteur
 * déréférencé ne se déclenche pas si plus rien d'autre ne tient la boucle —
 * c'est-à-dire exactement dans le cas qu'il doit couvrir, une sonde suspendue
 * sur un processus par ailleurs inactif. Le garde-temps ne servirait alors à
 * rien. Le défaut a été attrapé par le test, pas en production.
 *
 * Le coût de le laisser référencé est borné : `timeoutMs` (1,5 s), et le
 * minuteur est TOUJOURS annulé dès que la promesse aboutit.
 */
function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timer = null;

  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} : délai dépassé (${ms} ms)`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Mesure Redis en une passe : RTT du `PING`, puis `INFO memory` et `INFO stats`.
 *
 * Ne lève jamais — une dépendance en panne rend `up: 0`, ce qui est exactement
 * l'information qu'on veut voir sur la page.
 *
 * @param {object} client   Client ioredis DÉJÀ OUVERT (jamais construit ici).
 * @returns {Promise<{up:number, pingSeconds:(number|undefined), fields:object, error:(string|undefined)}>}
 */
async function probeRedis(client, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!client || typeof client.ping !== "function") {
    return { up: 0, pingSeconds: undefined, fields: {}, error: "client absent" };
  }

  const started = process.hrtime.bigint();

  try {
    await withTimeout(Promise.resolve(client.ping()), timeoutMs, "PING Redis");
  } catch (err) {
    return {
      up: 0,
      pingSeconds: undefined,
      fields: {},
      error: err?.message || String(err),
    };
  }

  const pingSeconds = Number(process.hrtime.bigint() - started) / 1e9;

  let fields = {};

  /**
   * L'`INFO` est SECONDAIRE : s'il échoue alors que le `PING` a répondu, Redis
   * est bien vivant. On garde `up: 1` et on se passe des champs, plutôt que de
   * déclarer une panne qui n'existe pas.
   */
  try {
    const sections = await withTimeout(
      Promise.all([
        Promise.resolve(client.info("memory")),
        Promise.resolve(client.info("stats")),
      ]),
      timeoutMs,
      "INFO Redis"
    );

    fields = pickInfoFields(parseRedisInfo(sections.join("\n")));
  } catch {
    // Volontairement silencieux : `redis_up` vaut 1, les jauges de mémoire
    // gardent leur dernière valeur connue. Le journal de démarrage a déjà dit
    // ce qui est exposé ; répéter à chaque scrutation noierait les journaux.
  }

  return { up: 1, pingSeconds, fields, error: undefined };
}

/** Champs du cache applicatif exposés — liste blanche, comme pour `INFO`. */
const APP_CACHE_GAUGES = Object.freeze([
  ["app_cache_hits", "hits", "Lectures servies par le cache applicatif (cumulé depuis le démarrage du processus)"],
  ["app_cache_misses", "misses", "Lectures non servies par le cache applicatif (cumulé)"],
  ["app_cache_errors", "erreurs", "Erreurs Redis rencontrées par le cache applicatif (cumulé)"],
  ["app_cache_rejected", "refus", "Opérations refusées par le cache applicatif — clé invalide, valeur trop grosse (cumulé)"],
  ["app_cache_bypassed", "contournements", "Lectures contournées disjoncteur ouvert (cumulé)"],
]);

/**
 * Enregistre les jauges Redis sur le registre de métriques du service.
 *
 * @param {object}   metrics                l'objet rendu par `createMetrics()`
 * @param {object}   deps
 * @param {Function} deps.getClient         rend le client Redis DÉJÀ ouvert, ou `null`
 * @param {object}   [deps.logger]
 * @param {Function} [deps.appCacheStats]   rend les compteurs d'un cache applicatif
 * @param {number}   [deps.cacheMs]         mutualisation de la sonde entre jauges
 * @param {number}   [deps.timeoutMs]
 * @param {Function} [deps.probe]           injection de test
 * @param {Function} [deps.now]             injection de test
 * @returns {{registered: boolean, reason?: string, probeOnce?: Function}}
 */
function registerRedisMetrics(
  metrics,
  {
    getClient,
    logger = console,
    appCacheStats = null,
    cacheMs = DEFAULT_CACHE_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    probe = probeRedis,
    now = () => Date.now(),
  } = {}
) {
  if (!metrics?.registerAsyncGauge) {
    throw new Error("registerRedisMetrics : `metrics` invalide");
  }

  const client = typeof getClient === "function" ? getClient() : null;

  /**
   * ⚠️ RÈGLE B.6 : LES JOURNAUX DE DÉMARRAGE DISENT LA VÉRITÉ.
   *
   * Sans client, on n'enregistre RIEN — une série absente se remarque, une
   * série figée à zéro se lit comme « Redis va bien ». Et on dit la
   * conséquence : ce qui ne sera pas mesuré.
   */
  if (!client) {
    logger?.warn?.(
      "[metrics] métriques Redis NON exposées : aucun client Redis ouvert dans " +
        "ce processus. Conséquence : latence, mémoire, évictions et taux de " +
        "succès du cache resteront invisibles sur /metrics, et une saturation " +
        "mémoire de Redis ne se verra qu'au moment où elle causera un incident."
    );

    return { registered: false, reason: "aucun client Redis" };
  }

  let cache = { at: 0, value: null };

  /**
   * ⚠️ SONDE UNIQUE PAR SCRUTATION — ET IL FAUT LES DEUX MÉCANISMES.
   *
   * `prom-client` appelle les `collect()` de toutes les jauges EN PARALLÈLE. Un
   * simple cache horodaté ne suffit donc pas : les dix jauges partent
   * ensemble, trouvent le cache vide, et lancent dix sondes — dix PING et vingt
   * INFO envoyés au serveur qu'on prétend surveiller, à chaque scrutation.
   *
   * `inflight` mutualise la sonde EN COURS ; `cache` mutualise entre deux
   * scrutations rapprochées. Le premier défaut a été attrapé par le test
   * « une seule sonde Redis par scrutation », pas en production.
   */
  let inflight = null;

  function current() {
    const t = now();

    if (cache.value && t - cache.at < cacheMs) return Promise.resolve(cache.value);
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const value = await probe(getClient(), { timeoutMs });
        cache = { at: now(), value };
        return value;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  metrics.registerAsyncGauge({
    name: "redis_up",
    help: "1 si le PING Redis a répondu à la dernière scrutation, 0 sinon",
    collect: async (gauge) => {
      gauge.set((await current()).up);
    },
  });

  metrics.registerAsyncGauge({
    name: "redis_ping_duration_seconds",
    help:
      "Aller-retour d'un PING Redis, mesuré au moment de la scrutation. " +
      "Non renseigné tant qu'aucun PING n'a abouti.",
    collect: async (gauge) => {
      const p = await current();
      if (p.pingSeconds !== undefined) gauge.set(p.pingSeconds);
    },
  });

  /**
   * `[nom de métrique, champ INFO, aide]`. Une jauge par champ nommé — jamais de
   * jauge générique étiquetée par le nom du champ : ce serait rouvrir la porte
   * de la cardinalité que `metrics.js` ferme.
   */
  const INFO_GAUGES = [
    ["redis_memory_used_bytes", "used_memory", "Mémoire utilisée par le serveur Redis (used_memory)"],
    ["redis_memory_rss_bytes", "used_memory_rss", "Mémoire résidente du serveur Redis (used_memory_rss)"],
    [
      "redis_memory_max_bytes",
      "maxmemory",
      "Plafond mémoire configuré du serveur Redis (maxmemory). 0 = aucun plafond, donc aucune éviction : c'est l'hôte qui tuera le processus.",
    ],
    ["redis_memory_fragmentation_ratio", "mem_fragmentation_ratio", "Rapport mémoire résidente / mémoire utilisée"],
    [
      "redis_evicted_keys",
      "evicted_keys",
      "Clés évincées par manque de mémoire, cumulé côté serveur Redis. Toute valeur qui monte signifie que Redis JETTE des données.",
    ],
    ["redis_expired_keys", "expired_keys", "Clés expirées par TTL, cumulé côté serveur Redis"],
    [
      "redis_keyspace_hits",
      "keyspace_hits",
      "Lectures trouvées, cumulé côté serveur Redis. Compteur brut : le taux se calcule avec rate(), pas ici.",
    ],
    [
      "redis_keyspace_misses",
      "keyspace_misses",
      "Lectures non trouvées, cumulé côté serveur Redis. Compteur brut : le taux se calcule avec rate(), pas ici.",
    ],
  ];

  for (const [name, field, help] of INFO_GAUGES) {
    metrics.registerAsyncGauge({
      name,
      help,
      collect: async (gauge) => {
        const value = (await current()).fields[field];
        // Champ absent (version de Redis, section indisponible) : on ne pose
        // pas un zéro qui se lirait comme une mesure.
        if (value !== undefined) gauge.set(value);
      },
    });
  }

  let appCacheRegistered = false;

  /**
   * Le cache applicatif est une AUTRE mesure que `keyspace_hits`.
   *
   * `keyspace_hits` compte les lectures vues par le serveur Redis, tous usages
   * confondus. Les compteurs du cache applicatif comptent ce que CE service a
   * demandé et n'a pas eu à recalculer. Un cache applicatif à 5 % de succès
   * pendant que le serveur affiche 99 % est un cas parfaitement possible — et
   * c'est le premier chiffre qui dit qu'un cache ne sert à rien.
   */
  if (typeof appCacheStats === "function") {
    for (const [name, field, help] of APP_CACHE_GAUGES) {
      metrics.registerAsyncGauge({
        name,
        help,
        collect: (gauge) => {
          const value = toNumber(appCacheStats()?.[field]);
          if (value !== undefined) gauge.set(value);
        },
      });
    }

    metrics.registerAsyncGauge({
      name: "app_cache_enabled",
      help: "1 si le cache applicatif sert les lectures, 0 s'il est contourné (disjoncteur ouvert ou cache désactivé)",
      collect: (gauge) => {
        gauge.set(appCacheStats()?.contourne ? 0 : 1);
      },
    });

    appCacheRegistered = true;
  }

  logger?.info?.(
    `[metrics] métriques Redis exposées sur /metrics (latence, mémoire, ` +
      `évictions, hits/misses serveur${appCacheRegistered ? " + cache applicatif" : ""}).`
  );

  return { registered: true, probeOnce: current, appCache: appCacheRegistered };
}

module.exports = {
  registerRedisMetrics,
  probeRedis,
  parseRedisInfo,
  pickInfoFields,
  withTimeout,
  REDIS_INFO_FIELDS,
  APP_CACHE_GAUGES,
  DEFAULT_CACHE_MS,
  DEFAULT_TIMEOUT_MS,
};
