"use strict";

/**
 * Le cumul AML lit le modèle `Transaction` de la base TRANSACTIONS — 2026-09-17.
 *
 * `models/Transaction.js` exporte une FABRIQUE `(conn) => model`. L'ancien
 * résolveur de `services/aml.js` cherchait `countDocuments` sur l'export
 * lui-même : il ne trouvait jamais rien et levait à CHAQUE appel. Mesuré en
 * production (Render, participation de cagnotte depuis l'app iOS) :
 * `503 AML_STATS_UNAVAILABLE` sur toute opération passant par le middleware AML.
 * Avant l'échec en fermeture du 2026-09-15, la même erreur retombait à 0 : le
 * plafond journalier n'était jamais vérifié.
 *
 * Aucune base ouverte : une connexion Mongoose non connectée suffit pour
 * enregistrer un modèle, et les requêtes passent par un modèle factice.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const mongoose = require("mongoose");

const DB_PATH = path.join(__dirname, "..", "src", "config", "db.js");

function withTxConn(conn, fn) {
  const real = require(DB_PATH);
  const saved = require.cache[DB_PATH];
  require.cache[DB_PATH] = { ...saved, exports: { ...real, getTxConn: () => conn } };
  const restore = () => { require.cache[DB_PATH] = saved; };
  let out;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (out && typeof out.then === "function") return out.finally(restore);
  restore();
  return out;
}

const aml = require("../src/services/aml");

function fakeModel({ dailyTotal = 0, aggregateError = null } = {}) {
  const calls = [];
  const query = (rows) => ({ select() { return this; }, lean: async () => rows });
  return {
    calls,
    countDocuments: async (q) => { calls.push(["countDocuments", q]); return 2; },
    aggregate: async (pipeline) => {
      calls.push(["aggregate", pipeline]);
      if (aggregateError) throw aggregateError;
      return [{ _id: null, total: dailyTotal }];
    },
    find: (q) => { calls.push(["find", q]); return query([]); },
  };
}

const USER = "64b000000000000000000001";
const noCagnotte = { aggregate: async () => [] };

test("le résolveur rend un vrai modèle Mongoose enregistré sur la connexion Transactions", () => {
  const conn = mongoose.createConnection();
  try {
    const Model = withTxConn(conn, () => aml.resolveTransactionModel());

    assert.equal(typeof Model.countDocuments, "function");
    assert.equal(typeof Model.aggregate, "function");
    assert.equal(Model.db, conn, "le modèle doit vivre sur la connexion Transactions, pas sur la connexion par défaut");
    assert.equal(conn.models.Transaction, Model);
  } finally {
    conn.close().catch(() => {});
  }
});

test("le cumul journalier se lit sur le modèle de la connexion Transactions", async () => {
  const Model = fakeModel({ dailyTotal: 15000 });
  const conn = { models: { Transaction: Model, CagnotteSettlement: noCagnotte } };

  const stats = await withTxConn(conn, () => aml.getUserTransactionsStats(USER, "paynoval", "XOF"));

  assert.equal(stats.dailyTotal, 15000);
  assert.equal(stats.lastHour, 2);
  assert.ok(Model.calls.some(([name]) => name === "aggregate"));
});

test("une agrégation en échec REMONTE — jamais un cumul à zéro", async () => {
  const boom = new Error("aggregate failed");
  const Model = fakeModel({ aggregateError: boom });

  await assert.rejects(
    aml.getUserTransactionsStats(USER, "paynoval", "XOF", { Model, CagnotteModel: noCagnotte }),
    (err) => err === boom
  );
});

test("les participations de cagnotte s'ajoutent au cumul", async () => {
  const Model = fakeModel({ dailyTotal: 1000 });
  const CagnotteModel = { aggregate: async () => [{ _id: null, total: 500, lastHour: 1 }] };

  const stats = await aml.getUserTransactionsStats(USER, "paynoval", "XOF", { Model, CagnotteModel });

  assert.equal(stats.dailyTotal, 1500);
  assert.equal(stats.cagnotteDailyTotal, 500);
  assert.equal(stats.lastHour, 3);
});
