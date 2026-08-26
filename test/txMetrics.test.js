"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const client = require("prom-client");

const {
  createTxMetrics,
  setTxMetrics,
  getTxMetrics,
  INERT,
} = require("../src/services/txMetrics");

/**
 * Chaque test construit son PROPRE registre : `prom-client` refuse deux
 * métriques du même nom sur un registre partagé, et un registre global rendrait
 * l'ordre des fichiers de test significatif.
 */
function makeMetrics() {
  const register = new client.Registry();
  return { register, tx: createTxMetrics({ client, register }) };
}

async function readMetric(register, name) {
  const all = await register.getMetricsAsJSON();
  return all.find((m) => m.name === name);
}

/* -------------------------------------------------------------------------- */
/* L'enveloppe ne doit JAMAIS changer le comportement                         */
/* -------------------------------------------------------------------------- */

test("la valeur de retour de l'adapter est rendue telle quelle", async () => {
  const { tx } = makeMetrics();

  const original = {
    provider: "wave",
    payout: async () => ({ ok: true, providerReference: "REF-1", extra: 42 }),
  };

  const wrapped = tx.instrumentAdapter(original, { rail: "mobilemoney", provider: "wave" });
  const result = await wrapped.payout({ amount: 1000 });

  assert.deepEqual(result, { ok: true, providerReference: "REF-1", extra: 42 });
});

test("les arguments sont transmis intacts", async () => {
  const { tx } = makeMetrics();
  let seen = null;

  const wrapped = tx.instrumentAdapter(
    { provider: "orange", payout: async (...args) => { seen = args; return { ok: true }; } },
    { rail: "mobilemoney" }
  );

  await wrapped.payout({ amount: 500 }, "second");

  assert.deepEqual(seen, [{ amount: 500 }, "second"]);
});

test("une exception est RELANCÉE telle quelle, après comptage", async () => {
  /**
   * Une métrique qui avale une erreur de prestataire transformerait un échec de
   * virement en succès silencieux. C'est le pire défaut possible ici.
   */
  const { tx, register } = makeMetrics();

  const boom = Object.assign(new Error("rail non configuré"), {
    code: "PROVIDER_NOT_CONFIGURED",
  });

  const wrapped = tx.instrumentAdapter(
    { provider: "mtn", payout: async () => { throw boom; } },
    { rail: "mobilemoney" }
  );

  await assert.rejects(() => wrapped.payout({}), (err) => {
    assert.equal(err, boom, "la MÊME instance d'erreur doit remonter");
    assert.equal(err.code, "PROVIDER_NOT_CONFIGURED");
    return true;
  });

  const counter = await readMetric(register, "provider_requests_total");
  assert.equal(counter.values[0].labels.outcome, "error");
});

test("les méthodes non enveloppées restent accessibles", async () => {
  /**
   * L'enveloppe délègue par prototype : `parseWebhook`, `mapStatus` et tout ce
   * qu'on ajoutera plus tard doivent survivre sans qu'on pense à les recopier.
   */
  const { tx } = makeMetrics();

  const original = {
    provider: "stripe",
    payout: async () => ({ ok: true }),
    parseWebhook: () => "analysé",
    mapStatus: (s) => `statut:${s}`,
  };

  const wrapped = tx.instrumentAdapter(original, { rail: "card" });

  assert.equal(wrapped.parseWebhook(), "analysé");
  assert.equal(wrapped.mapStatus("PAID"), "statut:PAID");
  assert.equal(wrapped.provider, "stripe");
});

test("un adapter sans `collect` n'est pas cassé par l'enveloppe", async () => {
  const { tx } = makeMetrics();
  const wrapped = tx.instrumentAdapter({ provider: "x", payout: async () => ({ ok: true }) }, {});

  assert.equal(typeof wrapped.payout, "function");
  assert.equal(wrapped.collect, undefined);
});

test("une entrée non-objet est rendue inchangée", () => {
  const { tx } = makeMetrics();
  assert.equal(tx.instrumentAdapter(null, {}), null);
  assert.equal(tx.instrumentAdapter(undefined, {}), undefined);
});

/* -------------------------------------------------------------------------- */
/* Ce qui est mesuré                                                          */
/* -------------------------------------------------------------------------- */

test("un refus prestataire est compté « failed », PAS « success »", async () => {
  /**
   * Un adapter ne lève pas sur refus : il rend `{ ok: false }`. Compter cela
   * comme un succès masquerait exactement ce qu'on cherche — un prestataire qui
   * refuse tout sans jamais tomber.
   */
  const { tx, register } = makeMetrics();

  const wrapped = tx.instrumentAdapter(
    { provider: "moov", payout: async () => ({ ok: false, errorCode: "INSUFFICIENT" }) },
    { rail: "mobilemoney" }
  );

  const res = await wrapped.payout({});
  assert.equal(res.ok, false, "la réponse reste intacte");

  const counter = await readMetric(register, "provider_requests_total");
  assert.equal(counter.values[0].labels.outcome, "failed");
});

test("« failed » (refus métier) et « error » (panne) sont distincts", async () => {
  // Les mélanger ferait chercher au mauvais endroit pendant un incident.
  const { tx, register } = makeMetrics();

  const a = tx.instrumentAdapter({ provider: "wave", payout: async () => ({ ok: false }) }, { rail: "mobilemoney" });
  const b = tx.instrumentAdapter({ provider: "wave", collect: async () => { throw new Error("timeout"); } }, { rail: "mobilemoney" });

  await a.payout({});
  await assert.rejects(() => b.collect({}));

  const counter = await readMetric(register, "provider_requests_total");
  const outcomes = counter.values.map((v) => v.labels.outcome).sort();

  assert.deepEqual(outcomes, ["error", "failed"]);
});

test("les étiquettes portent prestataire, rail et opération", async () => {
  const { tx, register } = makeMetrics();

  const wrapped = tx.instrumentAdapter(
    { provider: "visa_direct", payout: async () => ({ ok: true }), collect: async () => ({ ok: true }) },
    { rail: "card" }
  );

  await wrapped.payout({});
  await wrapped.collect({});

  const counter = await readMetric(register, "provider_requests_total");
  const ops = counter.values.map((v) => v.labels.operation).sort();

  assert.deepEqual(ops, ["collect", "payout"]);
  assert.equal(counter.values[0].labels.provider, "visa_direct");
  assert.equal(counter.values[0].labels.rail, "card");
});

test("la durée mesurée suit l'horloge injectée", async () => {
  const { tx, register } = makeMetrics();

  let t = 1_000_000;
  const now = () => t;

  const wrapped = tx.instrumentAdapter(
    { provider: "orange", payout: async () => { t += 2500; return { ok: true }; } },
    { rail: "mobilemoney" },
    now
  );

  await wrapped.payout({});

  const hist = await readMetric(register, "provider_request_duration_seconds");
  const sum = hist.values.find((v) => v.metricName?.endsWith("_sum"));

  assert.equal(sum.value, 2.5, "2500 ms doivent être observés comme 2,5 s");
});

test("la durée est mesurée même quand l'appel échoue", async () => {
  /**
   * C'est le cas le plus utile : un prestataire qui expire est lent AVANT
   * d'échouer. Ne mesurer que les succès cacherait la dégradation.
   */
  const { tx, register } = makeMetrics();

  let t = 0;
  const wrapped = tx.instrumentAdapter(
    { provider: "mtn", payout: async () => { t += 15000; throw new Error("timeout"); } },
    { rail: "mobilemoney" },
    () => t
  );

  await assert.rejects(() => wrapped.payout({}));

  const hist = await readMetric(register, "provider_request_duration_seconds");
  const sum = hist.values.find((v) => v.metricName?.endsWith("_sum"));

  assert.equal(sum.value, 15);
});

test("l'état simulé des rails est publié", async () => {
  const { tx, register } = makeMetrics();

  tx.setRailModes({
    rails: [
      { provider: "wave", rail: "mobilemoney", mock: false },
      { provider: "mtn", rail: "mobilemoney", mock: true },
    ],
  });

  const gauge = await readMetric(register, "provider_rails_mocked");
  const byProvider = Object.fromEntries(
    gauge.values.map((v) => [v.labels.provider, v.value])
  );

  assert.deepEqual(byProvider, { wave: 0, mtn: 1 });
});

test("les issues de transaction sont comptées par flux et statut", async () => {
  const { tx, register } = makeMetrics();

  tx.observeTransaction({ flow: "PAYNOVAL_INTERNAL_TRANSFER", rail: "internal", status: "confirmed" });
  tx.observeTransaction({ flow: "PAYNOVAL_INTERNAL_TRANSFER", rail: "internal", status: "confirmed" });
  tx.observeTransaction({ flow: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT", rail: "mobilemoney", status: "failed" });

  const counter = await readMetric(register, "transactions_total");
  const total = counter.values.reduce((n, v) => n + v.value, 0);

  assert.equal(total, 3);
  assert.equal(counter.values.length, 2, "deux séries distinctes");
});

test("observeTransaction ne lève jamais, même sur entrée absurde", () => {
  const { tx } = makeMetrics();

  assert.doesNotThrow(() => tx.observeTransaction());
  assert.doesNotThrow(() => tx.observeTransaction({ flow: null, status: undefined }));
});

/* -------------------------------------------------------------------------- */
/* Registre de processus                                                      */
/* -------------------------------------------------------------------------- */

test("sans instance posée, l'instrumentation est l'IDENTITÉ", () => {
  /**
   * Un module de mesure ne doit jamais être une condition de démarrage : si
   * rien n'est posé, les appels prestataires doivent fonctionner exactement
   * comme avant.
   */
  setTxMetrics(null);

  const adapter = { provider: "wave", payout: async () => ({ ok: true }) };

  assert.equal(getTxMetrics(), INERT);
  assert.equal(getTxMetrics().instrumentAdapter(adapter), adapter, "le MÊME objet");
  assert.doesNotThrow(() => getTxMetrics().observeTransaction({ flow: "x" }));
  assert.doesNotThrow(() => getTxMetrics().setRailModes({ rails: [] }));
});

test("le sélecteur d'adapters instrumente sans rien changer au contrat", async () => {
  /**
   * Test de bout en bout du point d'instrumentation unique : c'est
   * `getProviderAdapter` qui doit envelopper, et l'adapter rendu doit rester
   * utilisable à l'identique.
   */
  const { tx, register } = makeMetrics();
  setTxMetrics(tx);

  try {
    const { getProviderAdapter } = require("../src/providers/providerSelector");
    const adapter = getProviderAdapter({ rail: "card", provider: "visa-direct" });

    // L'alias "visa-direct" doit être étiqueté sous le nom CANONIQUE.
    assert.equal(adapter.provider, "visa_direct");
    assert.equal(typeof adapter.payout, "function");
    assert.equal(typeof adapter.parseWebhook, "function");

    // Rail non configuré, hors production ⇒ mode simulé, réponse `ok`.
    const res = await adapter.payout({ amount: 100, currency: "XOF" });
    assert.equal(res.ok, true);

    const counter = await readMetric(register, "provider_requests_total");
    assert.equal(counter.values[0].labels.provider, "visa_direct");
    assert.equal(counter.values[0].labels.rail, "card");
  } finally {
    setTxMetrics(null);
  }
});
