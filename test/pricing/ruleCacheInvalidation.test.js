"use strict";

/**
 * ============================================================================
 * UNE PUBLICATION TARIFAIRE DOIT ATTEINDRE TOUTES LES INSTANCES
 * ============================================================================
 *
 * `invalidateRuleCache()` ne vidait que la mémoire du processus qui publiait.
 * Avec deux instances, l'autre continuait de servir l'ancien barème jusqu'à
 * l'expiration de son TTL : deux clients identiques, deux prix différents,
 * selon l'instance qui répondait.
 *
 * ── Ce que ces tests figent ─────────────────────────────────────────────────
 *
 *   1. publier diffuse un signal sur le canal d'invalidation ;
 *   2. recevoir ce signal vide le cache local ;
 *   3. une instance ne REDIFFUSE pas ce qu'elle vient de recevoir — sans quoi
 *      deux instances se renverraient le signal sans fin ;
 *   4. sans Redis, l'invalidation locale fonctionne quand même (repli TTL).
 *
 * ⚠️ Le canal ne transporte QUE le signal « relis la base », jamais un prix :
 * un prix qui voyagerait par Redis ferait de Redis une source de vérité
 * financière (invariant A1). Le test le vérifie.
 *
 * Tests **purs** : aucun Redis réel, aucune base.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getActiveRules,
  invalidateRuleCache,
  initRuleCacheInvalidation,
  cacheStats,
  CANAL_INVALIDATION,
  __resetInvalidation,
} = require("../../src/services/pricing/ruleCache");

function fauxRedis() {
  const publie = [];
  const abonnements = [];
  let surMessage = null;

  return {
    publie,
    abonnements,

    publish(canal, charge) {
      publie.push({ canal, charge });
      return Promise.resolve(1);
    },

    subscribe(canal) {
      abonnements.push(canal);
    },

    on(evenement, handler) {
      if (evenement === "message") surMessage = handler;
    },

    /** Simule la réception d'un signal émis par une AUTRE instance. */
    recevoir(canal, charge) {
      if (surMessage) surMessage(canal, charge);
    },
  };
}

/** Charge le cache avec un jeu de règles connu, sans toucher la base. */
async function remplirLeCache(regles = [{ _id: "r-1" }]) {
  return getActiveRules({ loader: async () => regles, ttlMs: 60000 });
}

test.beforeEach(() => {
  __resetInvalidation();
});

test("publier un barème diffuse le signal d'invalidation", async () => {
  const redis = fauxRedis();
  initRuleCacheInvalidation({ publisher: redis, subscriber: redis });

  await remplirLeCache();
  assert.equal(cacheStats().size, 1);

  invalidateRuleCache();

  assert.equal(redis.publie.length, 1);
  assert.equal(redis.publie[0].canal, CANAL_INVALIDATION);
  assert.equal(cacheStats().size, 0, "le cache local doit être vidé aussi");
});

test("le signal ne transporte AUCUNE donnée tarifaire", async () => {
  const redis = fauxRedis();
  initRuleCacheInvalidation({ publisher: redis, subscriber: redis });

  await remplirLeCache([{ _id: "r-1", fee: { mode: "PERCENT", percent: 42 } }]);
  invalidateRuleCache();

  const charge = String(redis.publie[0].charge);

  assert.ok(
    /^\d+$/.test(charge),
    "la charge doit être un simple horodatage : un prix qui voyagerait par " +
      "Redis en ferait une source de vérité financière (invariant A1)"
  );
});

test("recevoir le signal d'une autre instance vide le cache local", async () => {
  const redis = fauxRedis();
  const regime = initRuleCacheInvalidation({ publisher: redis, subscriber: redis });

  assert.equal(regime.abonnement, true);
  assert.deepEqual(redis.abonnements, [CANAL_INVALIDATION]);

  await remplirLeCache();
  assert.equal(cacheStats().size, 1);

  redis.recevoir(CANAL_INVALIDATION, String(Date.now()));

  assert.equal(cacheStats().size, 0);
});

test("une instance ne rediffuse pas le signal qu'elle vient de recevoir", async () => {
  const redis = fauxRedis();
  initRuleCacheInvalidation({ publisher: redis, subscriber: redis });

  await remplirLeCache();
  redis.recevoir(CANAL_INVALIDATION, String(Date.now()));

  assert.equal(
    redis.publie.length,
    0,
    "rediffuser ce qu'on reçoit ferait tourner le signal sans fin entre instances"
  );
});

test("un message sur un AUTRE canal est ignoré", async () => {
  const redis = fauxRedis();
  initRuleCacheInvalidation({ publisher: redis, subscriber: redis });

  await remplirLeCache();
  redis.recevoir("un:autre:canal", "peu importe");

  assert.equal(cacheStats().size, 1);
});

test("sans Redis, l'invalidation locale fonctionne et rien ne lève", async () => {
  const regime = initRuleCacheInvalidation({});

  assert.equal(regime.diffusion, false);
  assert.equal(regime.abonnement, false);

  await remplirLeCache();
  assert.equal(cacheStats().size, 1);

  invalidateRuleCache();
  assert.equal(cacheStats().size, 0);
});

test("un échec de diffusion ne fait pas échouer la publication tarifaire", async () => {
  const redisCasse = {
    publish() {
      throw new Error("Redis indisponible");
    },
  };

  initRuleCacheInvalidation({ publisher: redisCasse });

  await remplirLeCache();

  // Ne doit pas lever : le barème EST publié en base, le cache n'est qu'un cache.
  invalidateRuleCache();

  assert.equal(cacheStats().size, 0);
});
