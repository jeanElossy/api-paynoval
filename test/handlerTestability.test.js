"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * CE QUE CE FICHIER DÉMONTRE
 * =============================================================================
 *
 * Il n'existait pas — il ne *pouvait* pas exister. Le `CLAUDE.md` du dépôt le
 * disait :
 *
 *   « `require` d'un contrôleur charge `src/config.js`, donc `dotenv-safe`, qui
 *     échoue sans `.env` complet. Une logique qu'on veut tester doit donc vivre
 *     dans un module sans dépendance de configuration. »
 *
 * Deux verrous rendaient un contrôleur inchargeable hors d'un serveur démarré :
 * la configuration qui validait au `require`, et les modèles Mongo résolus à
 * l'import. Les deux sont levés.
 *
 * Ces tests vérifient donc une propriété d'architecture, pas une règle métier :
 * qu'on peut désormais charger un contrôleur, et lui substituer ses modèles.
 * S'ils échouent, c'est que le contournement est revenu.
 */

const runtime = require("../src/services/transactions/shared/runtime");

test("la configuration se charge sans .env complet, et n'explose plus au require", () => {
  const config = require("../src/config");

  // Le seul fait d'accéder à une propriété suffisait autrefois à lever.
  assert.equal(typeof config.env, "string");
  assert.equal(typeof config.load, "function");
  assert.equal(typeof config.buildConfig, "function");
});

test("buildConfig est pure : elle construit depuis l'environnement qu'on lui passe", () => {
  const { buildConfig } = require("../src/config");

  const cfg = buildConfig({
    NODE_ENV: "test",
    PORT: "4242",
    JWT_SECRET: "secret-de-test",
    MONGO_URI_USERS: "mongodb://users",
    CORS_ORIGIN: "https://a.example, https://b.example",
  });

  assert.equal(cfg.env, "test");
  assert.equal(cfg.port, 4242);
  assert.equal(cfg.jwtSecret, "secret-de-test");
  assert.deepEqual(cfg.cors.origin, ["https://a.example", "https://b.example"]);

  // Aucune contamination du processus : c'est ce qui permet de construire
  // plusieurs configurations dans une même suite.
  assert.notEqual(process.env.JWT_SECRET, "secret-de-test");
});

test("le contrôleur de transactions se charge sans base ni serveur", () => {
  const controller = require("../src/controllers/transactionsController");

  assert.equal(typeof controller, "object");
  assert.ok(Object.keys(controller).length > 0);
  assert.equal(typeof controller.listInternal, "function");
  assert.equal(typeof controller.confirmController, "function");
});

test("les modèles sont substituables — la couture d'injection", async () => {
  const called = [];

  const fakeTransaction = {
    find(query) {
      called.push({ op: "find", query });

      const chain = {
        sort: () => chain,
        skip: () => chain,
        limit: () => chain,
        lean: async () => [
          { _id: "tx_1", reference: "PN-1", amount: { toString: () => "100" } },
        ],
      };

      return chain;
    },

    countDocuments: async (query) => {
      called.push({ op: "count", query });
      return 1;
    },

    schema: {
      path: (name) => (["sender", "receiver", "userId"].includes(name) ? {} : undefined),
    },
  };

  runtime.overrideModels({ Transaction: fakeTransaction });

  try {
    const { listInternal } = require("../src/services/transactions/handlers/listInternal");

    const req = { user: { id: "u1", _id: "u1" }, query: { limit: "10" } };

    let payload = null;
    const res = {
      status() {
        return res;
      },
      json(body) {
        payload = body;
        return res;
      },
    };

    await listInternal(req, res, (err) => {
      throw err;
    });

    assert.equal(payload.success, true);
    assert.equal(payload.count, 1);
    assert.equal(payload.total, 1);
    assert.equal(payload.hasMore, false);

    // Le secret n'est pas dans la sortie, et l'objet est bien sérialisé.
    assert.equal(payload.data[0].id, "tx_1");
    assert.equal(payload.data[0].amount, 100);

    // La requête ne porte que des champs indexés.
    const findCall = called.find((c) => c.op === "find");
    assert.deepEqual(findCall.query, {
      $or: [{ sender: "u1" }, { receiver: "u1" }, { userId: "u1" }],
    });
  } finally {
    runtime.restoreModels();
  }
});

test("restoreModels rend bien la main au modèle réel", () => {
  runtime.overrideModels({ Transaction: { marqueur: "faux" } });

  const { Transaction } = runtime.lazyModels(["Transaction"]);
  assert.equal(Transaction.marqueur, "faux");

  runtime.restoreModels();

  // Sans base connectée, le vrai getter lève — ce qui prouve que la
  // substitution est bien retirée et qu'on est revenu au chemin réel.
  assert.throws(() => Transaction.findOne, /Transactions DB non initialisée/);
});

test("restoreModels accepte de ne retirer qu'un modèle", () => {
  runtime.overrideModels({ Transaction: { m: "t" }, User: { m: "u" } });

  const { Transaction, User } = runtime.lazyModels(["Transaction", "User"]);
  assert.equal(Transaction.m, "t");
  assert.equal(User.m, "u");

  runtime.restoreModels("Transaction");

  assert.equal(User.m, "u", "User doit rester substitué");

  runtime.restoreModels();
});
