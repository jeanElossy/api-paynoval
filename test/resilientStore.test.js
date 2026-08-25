"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createResilientStore } = require("../src/services/resilientStore");

/**
 * Aucune attente réelle, aucun Redis. L'horloge est injectée : on vérifie la
 * période de repos et la reprise en faisant avancer un nombre.
 */

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function okStore(label) {
  const calls = [];
  return {
    calls,
    init() {},
    async increment(k) { calls.push(["increment", k]); return { totalHits: 1, resetTime: undefined, label }; },
    async decrement(k) { calls.push(["decrement", k]); },
    async resetKey(k) { calls.push(["resetKey", k]); },
    async resetAll() { calls.push(["resetAll"]); },
  };
}

function brokenStore() {
  const s = okStore("broken");
  s.increment = async () => { throw new Error("ECONNREFUSED"); };
  s.decrement = async () => { throw new Error("ECONNREFUSED"); };
  return s;
}

test("nominal : tout passe par le magasin principal", async () => {
  const primary = okStore("redis");
  const fallback = okStore("memory");
  const store = createResilientStore({ primary, fallback });

  const res = await store.increment("k");

  assert.equal(res.label, "redis");
  assert.equal(fallback.calls.length, 0);
});

test("panne : on bascule en mémoire, on ne lève JAMAIS", async () => {
  // Relancer produirait un 500 sur le chemin de la transaction : une panne de
  // cache deviendrait une panne de paiement.
  const fallback = okStore("memory");
  const store = createResilientStore({ primary: brokenStore(), fallback });

  const res = await store.increment("k");

  assert.equal(res.label, "memory");
  assert.deepEqual(fallback.calls, [["increment", "k"]]);
});

test("pendant la période de repos, on n'interroge plus Redis du tout", async () => {
  // Sinon chaque requête paierait le délai d'expiration de la connexion : la
  // panne se transformerait en latence sur tout le trafic.
  const primary = brokenStore();
  let attempts = 0;
  primary.increment = async () => { attempts += 1; throw new Error("down"); };

  const fallback = okStore("memory");
  const clock = makeClock();
  const store = createResilientStore({
    primary, fallback, cooldownMs: 10_000, now: clock.now,
  });

  await store.increment("a");
  assert.equal(attempts, 1);

  for (let i = 0; i < 20; i += 1) {
    clock.advance(100);
    await store.increment("a");
  }

  // 20 requêtes de plus, aucune n'a retouché Redis.
  assert.equal(attempts, 1);
  assert.equal(store.__state().degraded, true);
});

test("après la période de repos, une seule requête sert de sonde", async () => {
  const primary = okStore("redis");
  let fail = true;
  const realIncrement = primary.increment;
  primary.increment = async (k) => {
    if (fail) throw new Error("down");
    return realIncrement(k);
  };

  const clock = makeClock();
  const store = createResilientStore({
    primary, fallback: okStore("memory"), cooldownMs: 10_000, now: clock.now,
  });

  await store.increment("a");
  assert.equal(store.__state().degraded, true);

  clock.advance(10_001);
  fail = false;

  const res = await store.increment("a");

  assert.equal(res.label, "redis");
  assert.equal(store.__state().degraded, false);
});

test("si le repli échoue aussi, la requête passe quand même", async () => {
  // Aucune panne du compteur ne doit refuser une transaction.
  const fallback = okStore("memory");
  fallback.increment = async () => { throw new Error("impossible"); };

  const store = createResilientStore({
    primary: brokenStore(),
    fallback,
    logger: { warn() {}, error() {} },
  });

  const res = await store.increment("k");

  assert.equal(res.totalHits, 1);
  assert.equal(res.resetTime, undefined);
});

test("la journalisation est étranglée : une panne ne noie pas les journaux", async () => {
  const warnings = [];
  const clock = makeClock();

  const store = createResilientStore({
    primary: brokenStore(),
    fallback: okStore("memory"),
    logger: { warn: (m) => warnings.push(m) },
    cooldownMs: 1,
    logEveryMs: 30_000,
    now: clock.now,
  });

  for (let i = 0; i < 50; i += 1) {
    clock.advance(10);
    await store.increment("k");
  }

  assert.equal(warnings.length, 1);

  clock.advance(30_001);
  await store.increment("k");
  assert.equal(warnings.length, 2);
});

test("le message dit explicitement que les requêtes ne sont pas bloquées", async () => {
  const warnings = [];
  const store = createResilientStore({
    primary: brokenStore(),
    fallback: okStore("memory"),
    logger: { warn: (m) => warnings.push(m) },
  });

  await store.increment("k");

  assert.match(warnings[0], /ne sont PAS bloquées/);
});

test("init et shutdown atteignent les deux magasins sans jamais lever", () => {
  const primary = okStore("redis");
  const fallback = okStore("memory");

  primary.init = () => { throw new Error("init cassé"); };

  const store = createResilientStore({ primary, fallback });

  assert.doesNotThrow(() => store.init({ windowMs: 1000 }));
  assert.doesNotThrow(() => store.shutdown());
});

test("une dépendance manquante est signalée à la construction", () => {
  assert.throws(() => createResilientStore({ fallback: okStore() }), /primary/);
  assert.throws(() => createResilientStore({ primary: okStore() }), /fallback/);
});

test("localKeys est faux — les compteurs ne sont pas locaux au processus", () => {
  // express-rate-limit s'en sert pour avertir sur une configuration douteuse.
  const store = createResilientStore({ primary: okStore(), fallback: okStore() });
  assert.equal(store.localKeys, false);
});
