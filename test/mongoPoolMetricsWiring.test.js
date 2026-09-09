"use strict";

/**
 * ============================================================================
 * LE CÂBLAGE PERDAIT `connectionPoolCreated` — ET AUCUN TEST NE LE VOYAIT
 * ============================================================================
 *
 * ── Le défaut ────────────────────────────────────────────────────────────────
 * `attachPoolMetrics()` est appelé APRÈS la connexion (`config/db.js:295` et
 * `:312`) : avant elle, il n'y a pas de `MongoClient` auquel s'abonner. Or le
 * pilote émet `connectionPoolCreated` PENDANT la connexion. Au moment où
 * l'écouteur se pose, l'événement est déjà passé et ne reviendra jamais.
 *
 * Relevé sur le banc de charge le 2026-08-28, service réellement démarré :
 *
 *     mongodb_pool_max_size{pool="users+transactions"} 0
 *
 * alors que `maxPoolSize` valait 15. La jauge dont le rôle est de justifier le
 * dimensionnement du pool (§41, `BENCHMARKS.md` §8.4) affichait **zéro**.
 *
 * ── Pourquoi les tests existants ne pouvaient pas l'attraper ────────────────
 * Ils appellent `record(POOL_CREATED, …)` directement et vérifient que le
 * réducteur range bien la valeur. **Le réducteur était correct.** Un test qui
 * émet lui-même l'événement ne vérifie jamais qu'il arrive — il teste sa propre
 * mise en scène.
 *
 * Ce test-ci ne l'émet donc PAS. Il reproduit la situation réelle : un client
 * déjà connecté, dont le pool est déjà créé, auquel on s'abonne trop tard.
 *
 * ── Comment il tombe ────────────────────────────────────────────────────────
 * Retirer l'amorçage depuis `emitter.options` dans `attach()` : `maxPoolSize`
 * retombe à 0 et l'assertion échoue en le disant.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createPoolTracker, POOL_EVENTS } = require("../src/services/mongoPoolMetrics");

/**
 * Un `MongoClient` tel qu'il se présente à `attachPoolMetrics` : déjà connecté,
 * donc `connectionPoolCreated` déjà émis, et portant ses options EFFECTIVES.
 */
function clientDejaConnecte(options) {
  const client = new EventEmitter();
  client.options = options;
  return client;
}

test("maxPoolSize est connu même quand connectionPoolCreated est déjà passé", () => {
  const tracker = createPoolTracker({ name: "transactions" });

  tracker.attach(clientDejaConnecte({ maxPoolSize: 15, minPoolSize: 0 }));

  const vu = tracker.snapshot();

  assert.equal(
    vu.maxPoolSize,
    15,
    "`maxPoolSize` vaut " +
      vu.maxPoolSize +
      " : l'abonnement a lieu APRÈS la connexion, donc `connectionPoolCreated` " +
      "est déjà passé. Sans amorçage depuis les options effectives du client, " +
      "la jauge qui justifie le dimensionnement du pool affiche zéro."
  );
});

test("l'amorçage lit `s.options` quand le pilote n'expose pas `options`", () => {
  const tracker = createPoolTracker({ name: "users" });
  const client = new EventEmitter();
  client.s = { options: { maxPoolSize: 42, minPoolSize: 2 } };

  tracker.attach(client);

  assert.equal(tracker.snapshot().maxPoolSize, 42);
  assert.equal(tracker.snapshot().minPoolSize, 2);
});

/**
 * L'amorçage est un RATTRAPAGE, pas une source concurrente : si le pilote émet
 * bien l'événement, c'est lui qui fait foi. Sans ce contrôle, un changement de
 * version du pilote qui décalerait `options` passerait inaperçu.
 */
test("l'événement du pilote reste la source, l'amorçage ne l'écrase pas", () => {
  const tracker = createPoolTracker({ name: "tx" });
  const client = clientDejaConnecte({ maxPoolSize: 15, minPoolSize: 0 });

  tracker.attach(client);
  client.emit(POOL_EVENTS.POOL_CREATED, { options: { maxPoolSize: 30, minPoolSize: 5 } });

  assert.equal(
    tracker.snapshot().maxPoolSize,
    30,
    "l'événement du pilote doit primer sur la valeur amorcée : c'est lui qui " +
      "porte la valeur réellement appliquée si elle change."
  );
});

/**
 * ⚠️ La valeur ne doit JAMAIS venir de `process.env`. Une variable mal
 * orthographiée ou une option écrasée en chemin ferait mentir la jauge
 * exactement au moment où on s'en sert pour diagnostiquer.
 */
test("la valeur ne vient jamais de process.env", () => {
  const avant = process.env.MONGO_MAX_POOL_SIZE;
  process.env.MONGO_MAX_POOL_SIZE = "999";

  try {
    const tracker = createPoolTracker({ name: "env" });
    tracker.attach(clientDejaConnecte({ maxPoolSize: 15, minPoolSize: 0 }));

    assert.equal(
      tracker.snapshot().maxPoolSize,
      15,
      "la jauge a lu `process.env` au lieu des options du pilote : elle mentira " +
        "précisément dans le cas qu'elle est censée diagnostiquer."
    );
  } finally {
    if (avant === undefined) delete process.env.MONGO_MAX_POOL_SIZE;
    else process.env.MONGO_MAX_POOL_SIZE = avant;
  }
});
