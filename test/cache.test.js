"use strict";

/**
 * ── Déplacé depuis l'API Gateway le 2026-09-10 ──────────────────────────────
 *
 * Le module de cache suit `fxRulesService`, son unique consommateur, parti avec
 * le domaine de la tarification. Son test le suit aussi : un test laissé
 * derrière protège du code MORT — il continue de passer en donnant l'impression
 * de couvrir le cache, pendant que le cache réellement utilisé n'est couvert
 * par rien.
 */

/**
 * Tests du cache de référentiel. Aucun Redis : le client est factice.
 *
 * Ce que ces tests défendent réellement : la décision d'ouvrir un cache dans
 * un système financier. Elle n'est tenable QUE si trois propriétés tiennent —
 * jamais de donnée financière, jamais d'exception, jamais de ralentissement
 * quand Redis tombe. Chacune a ses tests ci-dessous.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { politique, construireCle } = require("../src/services/cache/cacheKeys");
const { createCache, ECHECS_AVANT_OUVERTURE } = require("../src/services/cache/cacheService");

/* -------------------------------------------------------------------------- */
/* Politique — l'allowlist                                                    */
/* -------------------------------------------------------------------------- */

test("politique : une ressource déclarée est cachable avec SON ttl", () => {
  const p = politique("fx-rate");
  assert.equal(p.cachable, true);
  assert.ok(p.ttl > 0, "un TTL est obligatoire, il n'y a pas de cache éternel");
});

test("politique : LE DÉFAUT EST LE REFUS pour toute ressource inconnue", () => {
  // La propriété qui compte : la ressource inventée demain n'est pas cachée
  // par accident. Une blocklist aurait l'effet inverse.
  for (const inconnue of ["", "  ", "quelque-chose", "Balance", "solde", "nouveau-truc"]) {
    assert.equal(politique(inconnue).cachable, false, `« ${inconnue} » ne doit pas être cachable`);
  }
});

test("politique : les ressources financières sont refusées AVEC une raison", () => {
  for (const interdite of ["balance", "wallet", "ledger", "transaction", "risk-score", "idempotency"]) {
    const p = politique(interdite);
    assert.equal(p.cachable, false);
    assert.match(p.raison, /INTERDIT/);
  }
});

test("politique : aucune ressource financière n'a pu se glisser dans l'allowlist", () => {
  // Garde structurelle : si quelqu'un ajoute `balance` à RESSOURCES_CACHABLES,
  // ce test tombe. C'est le seul endroit où l'invariant §13 est vérifiable
  // automatiquement.
  const { RESSOURCES_CACHABLES } = require("../src/services/cache/cacheKeys");
  const interdits = /balance|wallet|ledger|transaction|solde|risk|idempot/i;
  for (const nom of Object.keys(RESSOURCES_CACHABLES)) {
    assert.ok(!interdits.test(nom), `« ${nom} » ressemble à une donnée financière`);
  }
});

/* -------------------------------------------------------------------------- */
/* Clés                                                                       */
/* -------------------------------------------------------------------------- */

test("clé : format paynoval:{env}:{service}:{resource}:{id}", () => {
  assert.equal(
    construireCle({ env: "prod", service: "tx-core", ressource: "country", id: "CI" }),
    "paynoval:prod:tx-core:country:CI"
  );
});

test("clé : un identifiant porteur de « : » est refusé", () => {
  // Sans ce refus, un id contrôlé par l'utilisateur pourrait forger une clé
  // appartenant à une autre ressource — y compris une ressource interdite.
  assert.throws(
    () => construireCle({ env: "prod", service: "tx-core", ressource: "country", id: "CI:balance:1" }),
    /séparateur réservé/
  );
});

test("clé : un segment vide est refusé", () => {
  assert.throws(() => construireCle({ env: "", service: "tx-core", ressource: "country", id: "CI" }), /vide/);
});

/* -------------------------------------------------------------------------- */
/* Client factice                                                             */
/* -------------------------------------------------------------------------- */

function clientFactice({ leve = false } = {}) {
  const donnees = new Map();
  const appels = { get: 0, set: 0, del: 0 };

  return {
    donnees,
    appels,
    async get(k) {
      appels.get += 1;
      if (leve) throw new Error("ECONNREFUSED");
      return donnees.has(k) ? donnees.get(k) : null;
    },
    async set(k, v, mode, ttl) {
      appels.set += 1;
      if (leve) throw new Error("ECONNREFUSED");
      assert.equal(mode, "EX", "toute écriture DOIT porter une expiration");
      assert.ok(ttl > 0, "le TTL doit être strictement positif");
      donnees.set(k, v);
      return "OK";
    },
    async del(...k) {
      appels.del += 1;
      if (leve) throw new Error("ECONNREFUSED");
      k.forEach((x) => donnees.delete(x));
      return k.length;
    },
    async scan() {
      if (leve) throw new Error("ECONNREFUSED");
      return ["0", [...donnees.keys()]];
    },
  };
}

const base = { env: "test", service: "tx-core" };

/* -------------------------------------------------------------------------- */
/* Lecture / écriture                                                         */
/* -------------------------------------------------------------------------- */

test("getOrSet : premier appel produit, second sert le cache", async () => {
  const client = clientFactice();
  const cache = createCache({ client, ...base });

  let productions = 0;
  const produire = async () => { productions += 1; return { taux: 655.957 }; };

  assert.deepEqual(await cache.getOrSet("fx-rate", "EUR-XOF", produire), { taux: 655.957 });
  assert.deepEqual(await cache.getOrSet("fx-rate", "EUR-XOF", produire), { taux: 655.957 });
  assert.equal(productions, 1, "le second appel ne doit pas reproduire");
  assert.equal(cache.stats().hits, 1);
});

test("écriture : une ressource financière est REFUSÉE même par appel direct", async () => {
  const client = clientFactice();
  const cache = createCache({ client, ...base });

  assert.equal(await cache.ecrire("balance", "user-1", { montant: 100000 }), false);
  assert.equal(client.appels.set, 0, "aucune écriture ne doit atteindre Redis");
  assert.equal(cache.stats().refus, 1);
});

test("getOrSet sur ressource interdite : produit quand même, sans cacher", async () => {
  // Propriété importante : le garde-fou ne casse pas l'appelant. Il refuse de
  // cacher, la valeur est rendue, la requête aboutit.
  const client = clientFactice();
  const cache = createCache({ client, ...base });

  const valeur = await cache.getOrSet("balance", "u1", async () => ({ montant: 42 }));
  assert.deepEqual(valeur, { montant: 42 });
  assert.equal(client.appels.set, 0);
});

test("invalidation : l'entrée disparaît et le producteur est rappelé", async () => {
  const client = clientFactice();
  const cache = createCache({ client, ...base });

  let n = 0;
  const produire = async () => { n += 1; return n; };

  assert.equal(await cache.getOrSet("country", "CI", produire), 1);
  await cache.invalider("country", "CI");
  assert.equal(await cache.getOrSet("country", "CI", produire), 2);
});

/* -------------------------------------------------------------------------- */
/* Panne Redis                                                                */
/* -------------------------------------------------------------------------- */

test("Redis en panne : la valeur est SERVIE malgré tout", async () => {
  const client = clientFactice({ leve: true });
  const cache = createCache({ client, ...base });

  assert.deepEqual(await cache.getOrSet("country", "CI", async () => ({ nom: "Côte d'Ivoire" })), {
    nom: "Côte d'Ivoire",
  });
});

test("Redis en panne : le cache se CONTOURNE après quelques échecs", async () => {
  // Sans ce disjoncteur, chaque requête paierait un délai d'expiration : le
  // cache rendrait le service PLUS LENT que s'il n'existait pas.
  const client = clientFactice({ leve: true });
  const cache = createCache({ client, ...base, cooldownMs: 60_000 });

  for (let i = 0; i < ECHECS_AVANT_OUVERTURE; i += 1) {
    await cache.getOrSet("country", `X${i}`, async () => i);
  }
  assert.equal(cache.stats().contourne, true);

  const avant = client.appels.get;
  await cache.getOrSet("country", "APRES", async () => 1);
  assert.equal(client.appels.get, avant, "plus aucun appel ne doit partir vers Redis");
});

test("le disjoncteur se referme après le délai", async () => {
  const client = clientFactice({ leve: true });
  let t = 1000;
  const cache = createCache({ client, ...base, cooldownMs: 5000, now: () => t });

  for (let i = 0; i < ECHECS_AVANT_OUVERTURE; i += 1) await cache.lire("country", `X${i}`);
  assert.equal(cache.stats().contourne, true);

  t += 5001;
  assert.equal(cache.stats().contourne, false);
});

test("valeur illisible : traitée comme une absence, PAS comme une panne", async () => {
  // Une valeur écrite par une version antérieure ne doit pas ouvrir le
  // disjoncteur et priver tout le service de cache.
  const client = clientFactice();
  const cache = createCache({ client, ...base });
  client.donnees.set("paynoval:test:tx-core:country:CI", "{ceci n'est pas du json");

  assert.equal(await cache.lire("country", "CI"), undefined);
  assert.equal(cache.stats().contourne, false, "le disjoncteur ne doit PAS s'ouvrir");
});

test("sans client Redis : tout fonctionne, rien n'est caché", async () => {
  const cache = createCache({ client: null, ...base });
  assert.equal(await cache.getOrSet("country", "CI", async () => "ok"), "ok");
  assert.equal(await cache.ecrire("country", "CI", "x"), false);
});

test("le cache NE LÈVE JAMAIS, quelles que soient les entrées", async () => {
  const cache = createCache({ client: clientFactice({ leve: true }), ...base });
  for (const [r, id] of [[null, null], ["", ""], ["balance", "x"], ["country", null], [undefined, undefined]]) {
    await cache.lire(r, id);
    await cache.ecrire(r, id, { a: 1 });
    await cache.invalider(r, id);
  }
  assert.ok(true, "aucune exception n'a traversé");
});

test("une exception du PRODUCTEUR remonte — c'est une vraie erreur métier", async () => {
  const cache = createCache({ client: clientFactice(), ...base });
  await assert.rejects(
    () => cache.getOrSet("country", "CI", async () => { throw new Error("base injoignable"); }),
    /base injoignable/
  );
});
