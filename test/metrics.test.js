"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const client = require("prom-client");
const {
  createMetrics,
  normalizeRoute,
  genericizePath,
  MAX_ROUTES,
} = require("../src/services/metrics");

/**
 * Porté depuis `paynoval-backend/tests/metrics.test.js` — `services/metrics.js`
 * est identique dans les trois dépôts (dépôts séparés, pas de paquet commun).
 *
 * ⚠️ Les TROIS copies doivent rester alignées, module ET test.
 *
 * Le sujet est la CARDINALITÉ. Une métrique mal étiquetée ne se voit pas en
 * développement : elle fait tomber Prometheus en production, plus sûrement que
 * l'incident qu'on cherchait à observer. Sur ce service, étiqueter par URL brute
 * produirait une série par identifiant de transaction.
 */

function make() {
  return createMetrics({
    client,
    registry: new client.Registry(),
    collectDefault: false,
  });
}

/* ────────────────────────── Normalisation des chemins ───────────────────── */

test("un ObjectId devient :id", () => {
  assert.equal(
    genericizePath("/api/v1/users/64f1a2b3c4d5e6f7a8b9c0d1"),
    "/api/v1/users/:id"
  );
});

test("un UUID devient :id", () => {
  assert.equal(
    genericizePath("/api/v1/tx/3f2504e0-4f89-11d3-9a0c-0305e82c3301"),
    "/api/v1/tx/:id"
  );
});

test("un identifiant numérique devient :id", () => {
  assert.equal(genericizePath("/api/v1/pages/42"), "/api/v1/pages/:id");
});

test("un jeton opaque devient :id", () => {
  // Clés d'idempotence, références de transaction : autant de séries distinctes
  // si on les laisse passer.
  assert.equal(
    genericizePath("/api/v1/reset/AbCdEf0123456789XyZwQ"),
    "/api/v1/reset/:id"
  );
});

test("les segments stables sont conservés — sinon la métrique ne dit plus rien", () => {
  assert.equal(genericizePath("/api/v1/auth/login"), "/api/v1/auth/login");
  assert.equal(
    genericizePath("/api/v1/transactions/initiate"),
    "/api/v1/transactions/initiate"
  );
});

test("la chaîne de requête est écartée", () => {
  assert.equal(genericizePath("/api/v1/rates?from=EUR&to=XOF"), "/api/v1/rates");
});

test("les cas dégénérés ne lèvent pas", () => {
  for (const bad of [null, undefined, "", "/", "///"]) {
    assert.doesNotThrow(() => genericizePath(bad));
  }
  assert.equal(genericizePath("/"), "/");
});

/* ──────────────────────────── Motif de route ────────────────────────────── */

test("le motif reconnu par Express l'emporte sur l'heuristique", () => {
  // C'est la vérité, pas une devinette.
  const req = {
    baseUrl: "/api/v1/transactions",
    route: { path: "/:transactionId/status" },
    path: "/64f1a2b3c4d5e6f7a8b9c0d1/status",
  };

  assert.equal(normalizeRoute(req), "/api/v1/transactions/:transactionId/status");
});

test("sans route reconnue (404), on retombe sur l'heuristique", () => {
  const req = { path: "/api/v1/unknown/64f1a2b3c4d5e6f7a8b9c0d1" };
  assert.equal(normalizeRoute(req), "/api/v1/unknown/:id");
});

test("une requête illisible ne fait pas échouer la mesure", () => {
  assert.doesNotThrow(() => normalizeRoute(null));
  assert.equal(normalizeRoute({}), "/");
});

/* ───────────────────────── Plafond de cardinalité ───────────────────────── */

test("au-delà du plafond, tout bascule sur « other »", async () => {
  /**
   * Filet de dernier recours : même si la normalisation échouait, le nombre de
   * séries reste borné. C'est ce qui empêche une erreur de normalisation de se
   * transformer en incident Prometheus.
   */
  const m = make();

  const makeRes = () => {
    const handlers = {};
    return {
      statusCode: 200,
      once: (evt, fn) => {
        handlers[evt] = fn;
      },
      emit: (evt) => handlers[evt]?.(),
    };
  };

  for (let i = 0; i < MAX_ROUTES + 50; i += 1) {
    const r = makeRes();
    m.httpMiddleware({ method: "GET", path: `/route-${i}` }, r, () => {});
    r.emit("finish");
  }

  assert.equal(m.__routeCount(), MAX_ROUTES);
  assert.match(await m.metrics(), /route="other"/);
});

/* ────────────────────────────── Intergiciel ─────────────────────────────── */

function runRequest(m, { path = "/api/v1/ping", event = "finish", status = 200 } = {}) {
  const handlers = {};
  const res = {
    statusCode: status,
    once: (evt, fn) => {
      handlers[evt] = fn;
    },
  };

  let nextCalled = false;
  m.httpMiddleware({ method: "GET", path }, res, () => {
    nextCalled = true;
  });

  handlers[event]?.();
  return { nextCalled, handlers };
}

test("il appelle toujours next — mesurer ne doit rien bloquer", () => {
  const m = make();
  assert.equal(runRequest(m).nextCalled, true);
});

test("une requête abandonnée par le client décrémente aussi le compteur en vol", async () => {
  /**
   * Sans écoute de `close`, `http_requests_in_flight` ne redescend jamais et
   * dérive vers l'infini : c'est la fuite classique de ce compteur.
   */
  const m = make();
  runRequest(m, { event: "close" });

  assert.match(await m.metrics(), /http_requests_in_flight 0/);
});

test("finish puis close ne comptent la requête qu'une fois", async () => {
  const m = make();
  const { handlers } = runRequest(m, { event: "finish" });

  handlers.close?.();

  const text = await m.metrics();
  assert.match(text, /http_requests_in_flight 0/);
  assert.match(text, /http_request_duration_seconds_count\{[^}]*\} 1/);
});

test("le code de statut est une étiquette", async () => {
  const m = make();
  runRequest(m, { status: 503 });

  assert.match(await m.metrics(), /status="503"/);
});

/* ───────────────────── Jauges à collecte différée ───────────────────────── */

test("la valeur est lue au moment de la scrutation, pas en continu", async () => {
  let reads = 0;
  const m = make();

  m.registerAsyncGauge({
    name: "test_depth",
    help: "test",
    collect: async (g) => {
      reads += 1;
      g.set(7);
    },
  });

  assert.equal(reads, 0, "aucune lecture avant scrutation");

  const text = await m.metrics();

  assert.equal(reads, 1);
  assert.match(text, /test_depth 7/);
});

test("une source indisponible ne casse pas toute la page de métriques", async () => {
  const m = make();

  m.registerAsyncGauge({
    name: "test_broken",
    help: "test",
    collect: async () => {
      throw new Error("mongo indisponible");
    },
  });

  // La page doit rester servie : une jauge en échec ne doit pas priver
  // l'exploitant de TOUTES les autres métriques pendant un incident.
  const text = await m.metrics();
  assert.match(text, /http_requests_in_flight/);
});
