"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const client = require("prom-client");

const {
  registerRedisMetrics,
  probeRedis,
  parseRedisInfo,
  pickInfoFields,
} = require("../src/services/redisMetrics");

const { createMetrics } = require("../src/services/metrics");

/**
 * ⚠️ AUCUNE CONNEXION N'EST OUVERTE ICI. Le client Redis est un double, comme
 * dans `resilientStore.test.js` : c'est ce qui garde la suite à quelques
 * secondes et sans dépendance d'environnement.
 */

const INFO_MEMORY = [
  "# Memory",
  "used_memory:1048576",
  "used_memory_human:1.00M",
  "used_memory_rss:2097152",
  "maxmemory:8388608",
  "maxmemory_policy:allkeys-lru",
  "mem_fragmentation_ratio:1.75",
  "",
].join("\r\n");

const INFO_STATS = [
  "# Stats",
  "total_connections_received:42",
  "expired_keys:7",
  "evicted_keys:3",
  "keyspace_hits:900",
  "keyspace_misses:100",
  "",
].join("\r\n");

function fakeRedis({ ping = async () => "PONG", info = null } = {}) {
  const calls = { ping: 0, info: 0 };

  return {
    calls,
    ping: async () => {
      calls.ping += 1;
      return ping();
    },
    info: async (section) => {
      calls.info += 1;
      if (info) return info(section);
      return section === "memory" ? INFO_MEMORY : INFO_STATS;
    },
  };
}

function make() {
  return createMetrics({
    client,
    registry: new client.Registry(),
    collectDefault: false,
  });
}

function fakeLogger() {
  const lines = { warn: [], info: [] };
  return {
    lines,
    warn: (m) => lines.warn.push(String(m)),
    info: (m) => lines.info.push(String(m)),
  };
}

/* ───────────────────────────── Analyse d'INFO ───────────────────────────── */

test("parseRedisInfo ignore les sections et découpe sur le PREMIER deux-points", () => {
  const parsed = parseRedisInfo("# Keyspace\r\ndb0:keys=12,expires=3\r\nused_memory:42\r\n");

  assert.equal(parsed.used_memory, "42");
  assert.equal(parsed.db0, "keys=12,expires=3");
  assert.equal(parsed["# Keyspace"], undefined);
});

/**
 * RÈGLE B.4 — rien de sensible ne sort. `INFO` rend l'identifiant du processus,
 * le chemin du fichier de configuration et l'hôte du maître de réplication :
 * une page de métriques n'a pas à les publier, même protégée.
 *
 * Ce test tombe dès qu'on remplace la liste blanche par une copie intégrale.
 */
test("pickInfoFields n'expose QUE les champs de la liste blanche", () => {
  const parsed = parseRedisInfo(
    [
      "run_id:9f8c1b2a3d4e5f6071829",
      "config_file:/etc/redis/redis.conf",
      "master_host:10.0.7.21",
      "executable:/usr/bin/redis-server",
      "os:Linux 6.1.0 x86_64",
      "used_memory:1024",
    ].join("\r\n")
  );

  const picked = pickInfoFields(parsed);

  assert.deepEqual(Object.keys(picked), ["used_memory"]);
  assert.equal(picked.used_memory, 1024);

  for (const fuite of ["run_id", "config_file", "master_host", "executable", "os"]) {
    assert.equal(picked[fuite], undefined, `${fuite} ne doit jamais sortir`);
  }
});

test("pickInfoFields convertit en nombres et ignore les valeurs illisibles", () => {
  const picked = pickInfoFields({ used_memory: "2048", maxmemory: "n/a", keyspace_hits: "5" });

  assert.equal(picked.used_memory, 2048);
  assert.equal(picked.maxmemory, undefined);
  assert.equal(picked.keyspace_hits, 5);
});

/* ─────────────────────────────── La sonde ───────────────────────────────── */

test("probeRedis mesure le PING et lit les champs nommés", async () => {
  const r = await probeRedis(fakeRedis());

  assert.equal(r.up, 1);
  assert.ok(r.pingSeconds >= 0 && r.pingSeconds < 5);
  assert.equal(r.fields.used_memory, 1048576);
  assert.equal(r.fields.maxmemory, 8388608);
  assert.equal(r.fields.keyspace_hits, 900);
  assert.equal(r.fields.keyspace_misses, 100);
  assert.equal(r.fields.evicted_keys, 3);
});

test("probeRedis rend up=0 sans lever quand Redis est en panne", async () => {
  const r = await probeRedis(
    fakeRedis({
      ping: async () => {
        throw new Error("Connection is closed");
      },
    })
  );

  assert.equal(r.up, 0);
  assert.deepEqual(r.fields, {});
});

/**
 * Le PING qui n'aboutit JAMAIS est le cas dangereux : la file d'attente hors
 * ligne d'ioredis est ouverte pendant la connexion initiale, donc la commande
 * attend au lieu d'échouer. Sans garde-temps, la requête `/metrics` reste
 * suspendue — une page de métriques qui se bloque quand la dépendance qu'elle
 * mesure est en panne ne sert à rien.
 */
test("probeRedis abandonne au bout du délai au lieu de suspendre la scrutation", async () => {
  const r = await probeRedis(
    { ping: () => new Promise(() => {}), info: async () => "" },
    { timeoutMs: 20 }
  );

  assert.equal(r.up, 0);
  assert.match(r.error || "", /délai/i);
});

test("un INFO en échec ne fait pas passer Redis pour mort", async () => {
  const r = await probeRedis(
    fakeRedis({
      info: () => {
        throw new Error("NOPERM this user has no permissions to run 'info'");
      },
    })
  );

  assert.equal(r.up, 1);
  assert.deepEqual(r.fields, {});
});

/* ────────────────────────── Enregistrement des jauges ───────────────────── */

test("sans client Redis : rien n'est enregistré, et le démarrage le DIT avec sa conséquence", async () => {
  const metrics = make();
  const logger = fakeLogger();

  const res = registerRedisMetrics(metrics, { getClient: () => null, logger });

  assert.equal(res.registered, false);

  const sortie = await metrics.metrics();
  assert.ok(!sortie.includes("redis_up"), "aucune série ne doit être publiée");

  // Règle B.6 : un démarrage silencieux qui ment est la panne la plus chère.
  assert.equal(logger.lines.warn.length, 1);
  assert.match(logger.lines.warn[0], /Redis/);
  assert.match(logger.lines.warn[0], /Conséquence/i);
});

test("avec un client : latence, mémoire et compteurs bruts sont exposés", async () => {
  const metrics = make();
  const redis = fakeRedis();

  registerRedisMetrics(metrics, {
    getClient: () => redis,
    logger: fakeLogger(),
    cacheMs: 0,
  });

  const sortie = await metrics.metrics();

  assert.match(sortie, /^redis_up 1$/m);
  assert.match(sortie, /^redis_ping_duration_seconds /m);
  assert.match(sortie, /^redis_memory_used_bytes 1048576$/m);
  assert.match(sortie, /^redis_memory_max_bytes 8388608$/m);
  assert.match(sortie, /^redis_evicted_keys 3$/m);
});

/**
 * §37 demande un « taux de succès du cache ». Le piège est d'en faire un
 * pourcentage ici : `keyspace_hits` et `keyspace_misses` sont CUMULÉS depuis le
 * démarrage du serveur Redis, donc un ratio calculé au moment de la scrutation
 * est la moyenne de toute la vie du processus — une valeur qui ne bouge plus au
 * bout de quelques heures et qui masque précisément la dégradation qu'on
 * cherche.
 *
 * Ce test tombe si quelqu'un remplace les deux compteurs bruts par un ratio.
 */
test("les hits/misses sont exposés BRUTS, jamais en pourcentage figé", async () => {
  const metrics = make();

  registerRedisMetrics(metrics, {
    getClient: () => fakeRedis(),
    logger: fakeLogger(),
    cacheMs: 0,
  });

  const sortie = await metrics.metrics();

  assert.match(sortie, /^redis_keyspace_hits 900$/m);
  assert.match(sortie, /^redis_keyspace_misses 100$/m);

  assert.ok(
    !/hit_rate|hit_ratio|cache_ratio/i.test(sortie),
    "aucun ratio figé ne doit être publié : le taux se calcule avec rate()"
  );
});

/**
 * Dix jauges partagent une seule sonde. Sans mutualisation, chaque scrutation
 * enverrait dix PING et vingt INFO au serveur qu'elle prétend surveiller.
 */
test("une seule sonde Redis par scrutation, quel que soit le nombre de jauges", async () => {
  const metrics = make();
  const redis = fakeRedis();

  registerRedisMetrics(metrics, {
    getClient: () => redis,
    logger: fakeLogger(),
    cacheMs: 60_000,
  });

  await metrics.metrics();

  assert.equal(redis.calls.ping, 1);
  assert.equal(redis.calls.info, 2); // memory + stats
});

test("le cache applicatif est exposé séparément du cache serveur", async () => {
  const metrics = make();

  registerRedisMetrics(metrics, {
    getClient: () => fakeRedis(),
    logger: fakeLogger(),
    cacheMs: 0,
    appCacheStats: () => ({
      hits: 12,
      misses: 34,
      erreurs: 1,
      refus: 2,
      contournements: 5,
      contourne: true,
    }),
  });

  const sortie = await metrics.metrics();

  assert.match(sortie, /^app_cache_hits 12$/m);
  assert.match(sortie, /^app_cache_misses 34$/m);
  assert.match(sortie, /^app_cache_errors 1$/m);
  assert.match(sortie, /^app_cache_rejected 2$/m);
  assert.match(sortie, /^app_cache_bypassed 5$/m);
  // Disjoncteur ouvert : le cache ne sert rien.
  assert.match(sortie, /^app_cache_enabled 0$/m);
});

test("sans cache applicatif déclaré, aucune série app_cache_* n'apparaît", async () => {
  const metrics = make();

  registerRedisMetrics(metrics, { getClient: () => fakeRedis(), logger: fakeLogger() });

  const sortie = await metrics.metrics();
  assert.ok(!sortie.includes("app_cache_"));
});

/**
 * INVARIANT 8 — aucune requête HTTP ne crée de connexion Redis.
 *
 * Le module reçoit le client déjà ouvert ; il ne doit JAMAIS en construire un,
 * ni au chargement ni dans un `collect()`. Une scrutation toutes les quinze
 * secondes qui ouvrirait sa propre connexion serait, à l'échelle de la flotte,
 * une fuite permanente. Le test lit la source : c'est ce qui tombe si on
 * réintroduit un `new Redis(...)`.
 */
test("le module ne construit aucun client Redis", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/redisMetrics.js"),
    "utf8"
  );

  assert.ok(!/new\s+Redis\s*\(/.test(source));
  assert.ok(!/createClient\s*\(/.test(source));
  assert.ok(!/require\(["']ioredis["']\)/.test(source));
  assert.ok(!/require\(["']redis["']\)/.test(source));
});

test("le même client est réutilisé d'une scrutation à l'autre", async () => {
  const metrics = make();
  const redis = fakeRedis();
  let appels = 0;

  registerRedisMetrics(metrics, {
    getClient: () => {
      appels += 1;
      return redis;
    },
    logger: fakeLogger(),
    cacheMs: 0,
  });

  await metrics.metrics();
  await metrics.metrics();

  assert.equal(redis.calls.ping, 2);
  // Aucune construction : `getClient` rend toujours la même instance.
  assert.ok(appels >= 2);
});
