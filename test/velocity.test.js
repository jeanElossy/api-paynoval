"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WINDOWS,
  bucketOf,
  windowKeys,
  destinationKey,
  createVelocityTracker,
} = require("../src/services/risk/velocity");

/**
 * Ce module compte des ÉVÉNEMENTS pour alimenter un score. Il ne décide d'aucun
 * solde : Redis n'est pas une source de vérité financière (§13). Ses défauts
 * possibles sont donc d'un genre particulier — ils ne perdent pas d'argent, ils
 * rendent un contrôle antifraude AVEUGLE sans que rien ne le signale.
 */

/* ==========================================================================
 * DÉCOUPAGE — LA PARTIE OÙ UNE ERREUR PASSE INAPERÇUE
 * ======================================================================== */

test("un seau couvre exactement sa fenêtre", () => {
  /**
   * Les seaux sont alignés sur l'ÉPOQUE, pas sur l'instant observé : le seau
   * de 10 h court de 10 h 00 à 10 h 59, quelle que soit l'heure à laquelle on
   * regarde. C'est ce qui permet à deux instances de tomber sur le même seau
   * sans se coordonner — un découpage relatif à `now` donnerait à chacune ses
   * propres frontières, et le compteur serait éparpillé.
   */
  const w = 3600;
  const debut = 472_222 * w * 1000; // début exact d'un seau

  assert.equal(bucketOf(debut, w), 472_222);
  assert.equal(bucketOf(debut + (w - 1) * 1000, w), 472_222, "dernière seconde du seau");
  assert.equal(bucketOf(debut + w * 1000, w), 472_223, "première seconde du suivant");
});

test("la lecture couvre le seau COURANT et le PRÉCÉDENT", () => {
  /**
   * ══ LE POINT QUI ÉVITE UN ANGLE MORT ══
   *
   * Avec un seau fixe seul, une rafale à cheval sur une frontière est
   * sous-comptée : cinq virements à 10 h 59 et cinq à 11 h 01 comptent cinq
   * chacun, jamais dix. Un fraudeur qui vise le changement d'heure passe sous
   * tous les seuils.
   *
   * Sommer les deux seaux (motif « sliding window counter ») supprime cet
   * angle mort. L'approximation restante est MAJORANTE côté sécurité.
   */
  const t = 1_700_000_000_000;
  const [courant, precedent] = windowKeys("vel:c", "u1", 3600, t);

  assert.equal(courant, `vel:c:u1:${bucketOf(t, 3600)}`);
  assert.equal(precedent, `vel:c:u1:${bucketOf(t, 3600) - 1}`);
});

test("la clé de bénéficiaire ne dépend pas de la casse", () => {
  // Sinon il suffirait de varier la casse pour remettre le compteur à zéro.
  assert.equal(destinationKey("Ada@Paynoval.com"), destinationKey("ada@paynoval.com"));
  assert.equal(destinationKey("  ADA@X.COM  "), "ada@x.com");
});

test("aucun caractère saisi par l'utilisateur ne fabrique la clé", () => {
  // Une clé Redis ne doit pas dépendre de ce qu'un utilisateur a tapé : espaces,
  // deux-points et étoiles casseraient le découpage ou les motifs de recherche.
  const k = destinationKey("a b:c*d");

  assert.ok(!/[ :*]/.test(k));
  assert.equal(destinationKey(""), null);
  assert.equal(destinationKey(null), null);
});

/* ==========================================================================
 * COMPORTEMENT — ET SURTOUT, COMPORTEMENT EN PANNE
 * ======================================================================== */

function fakeRedis() {
  const store = new Map();
  const calls = { incr: 0, expire: 0, incrbyfloat: 0 };

  return {
    store,
    calls,
    status: "ready",
    pipeline() {
      const ops = [];
      const api = {
        incr(k) {
          ops.push(() => {
            calls.incr += 1;
            store.set(k, (Number(store.get(k)) || 0) + 1);
          });
          return api;
        },
        incrbyfloat(k, v) {
          ops.push(() => {
            calls.incrbyfloat += 1;
            store.set(k, (Number(store.get(k)) || 0) + Number(v));
          });
          return api;
        },
        expire() {
          ops.push(() => {
            calls.expire += 1;
          });
          return api;
        },
        async exec() {
          ops.forEach((fn) => fn());
          return [];
        },
      };
      return api;
    },
    async mget(keys) {
      return keys.map((k) => (store.has(k) ? String(store.get(k)) : null));
    },
  };
}

const FIXED = () => 1_700_000_000_000;

test("compte les virements et les retrouve", async () => {
  const redis = fakeRedis();
  const v = createVelocityTracker({ client: redis, now: FIXED });

  await v.record({ userId: "u1", amount: 100, destination: "ada@x.com" });
  await v.record({ userId: "u1", amount: 250, destination: "ada@x.com" });

  const lu = await v.read({ userId: "u1", destination: "ada@x.com" });

  assert.equal(lu.countLastHour, 2);
  assert.equal(lu.amountLast24h, 350);
  assert.equal(lu.sameDestinationLast10min, 2);
});

test("ne compte QUE le seau courant à l'écriture", () => {
  // Incrémenter les deux seaux doublerait chaque virement à la lecture.
  const redis = fakeRedis();
  const v = createVelocityTracker({ client: redis, now: FIXED });

  return v.record({ userId: "u1", amount: 10, destination: "ada@x.com" }).then(() => {
    // 2 `incr` (compte + destination), 1 `incrbyfloat` (montant).
    assert.equal(redis.calls.incr, 2);
    assert.equal(redis.calls.incrbyfloat, 1);
    assert.equal(redis.calls.expire, 3, "chaque clé doit expirer d'elle-même");
  });
});

test("sépare les bénéficiaires", async () => {
  const redis = fakeRedis();
  const v = createVelocityTracker({ client: redis, now: FIXED });

  await v.record({ userId: "u1", amount: 10, destination: "ada@x.com" });
  await v.record({ userId: "u1", amount: 10, destination: "bob@x.com" });

  const ada = await v.read({ userId: "u1", destination: "ada@x.com" });

  assert.equal(ada.countLastHour, 2, "le compte global additionne les deux");
  assert.equal(ada.sameDestinationLast10min, 1, "le compte par bénéficiaire, non");
});

test("sépare les comptes", async () => {
  const redis = fakeRedis();
  const v = createVelocityTracker({ client: redis, now: FIXED });

  await v.record({ userId: "u1", amount: 10 });
  await v.record({ userId: "u2", amount: 10 });

  assert.equal((await v.read({ userId: "u1" })).countLastHour, 1);
});

test("SANS Redis, on rend `null` — jamais zéro", async () => {
  /**
   * ══ LE TEST QUI COMPTE LE PLUS ══
   *
   * Rendre `{ countLastHour: 0 }` en l'absence de cache signifierait « ce
   * compte n'a rien fait », c'est-à-dire RÉCOMPENSER une panne : il suffirait
   * de la provoquer pour effacer toute vélocité.
   *
   * `null` veut dire « je ne sais pas », et `riskScore` le traduit en
   * `SIGNAL_UNAVAILABLE`.
   */
  const v = createVelocityTracker({ client: null });

  assert.equal(await v.read({ userId: "u1" }), null);
  assert.equal(v.usable(), false);
});

test("une panne de Redis ne LÈVE jamais", async () => {
  // Faire échouer un paiement parce que le cache n'a pas répondu serait un
  // défaut bien plus grave que de perdre un signal.
  const cassé = {
    status: "ready",
    pipeline() {
      throw new Error("connexion perdue");
    },
    async mget() {
      throw new Error("connexion perdue");
    },
  };
  const v = createVelocityTracker({ client: cassé, now: FIXED });

  assert.equal(await v.record({ userId: "u1", amount: 10 }), false);
  assert.equal(await v.read({ userId: "u1" }), null);
});

test("un client non connecté est traité comme absent", async () => {
  // `status` d'ioredis : « connecting », « reconnecting », « end »… Écrire dans
  // un client qui n'est pas prêt met en file d'attente sans jamais partir.
  const v = createVelocityTracker({ client: { status: "connecting" }, now: FIXED });

  assert.equal(v.usable(), false);
  assert.equal(await v.read({ userId: "u1" }), null);
});

test("sans identifiant de compte, on ne compte rien", async () => {
  const v = createVelocityTracker({ client: fakeRedis(), now: FIXED });

  assert.equal(await v.record({ userId: "", amount: 10 }), false);
  assert.equal(await v.read({ userId: null }), null);
});

test("les compteurs expirent d'eux-mêmes, sur deux fenêtres", () => {
  /**
   * Le TTL couvre DEUX fenêtres parce que la lecture regarde le seau précédent.
   * Un TTL d'une seule fenêtre le ferait disparaître au moment précis où on en
   * a besoin — la moitié des rafales redeviendraient invisibles.
   */
  assert.equal(WINDOWS.COUNT_LAST_HOUR, 3600);
  assert.equal(WINDOWS.SAME_DESTINATION, 600);
  assert.equal(WINDOWS.AMOUNT_LAST_24H, 86400);
});
