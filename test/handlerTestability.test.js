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
const {
  createListInternal,
} = require("../src/services/transactions/handlers/listInternal");

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

/* -------------------------------------------------------------------------- */
/* Injection de dépendances — le motif de référence                           */
/* -------------------------------------------------------------------------- */

/**
 * Ces tests n'écrasent AUCUN état global.
 *
 * `createListInternal({ Transaction })` reçoit sa dépendance : il n'y a rien à
 * restaurer, rien qui puisse fuir dans le test suivant, et deux de ces tests
 * peuvent s'exécuter en parallèle. C'est la différence concrète avec la couture
 * `overrideModels`, testée plus bas — laquelle reste utile comme outil de
 * transition pour le code pas encore converti.
 */
function fakeTransactionModel({ docs = [], total = 0, calls = [] } = {}) {
  return {
    find(query, projection) {
      calls.push({ op: "find", query, projection });

      const chain = {
        sort: () => chain,
        skip: () => chain,
        limit: (n) => {
          calls.push({ op: "limit", n });
          return chain;
        },
        lean: async () => docs,
      };

      return chain;
    },

    countDocuments: async (query) => {
      calls.push({ op: "count", query });
      return total;
    },

    schema: {
      path: (name) =>
        ["sender", "receiver", "userId"].includes(name) ? {} : undefined,
    },
  };
}

function fakeRes() {
  const out = { statusCode: 200, body: null };

  const res = {
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(body) {
      out.body = body;
      return res;
    },
  };

  return { res, out };
}

test("le handler injecté rend une page, sans aucun état global", async () => {
  const calls = [];
  const Transaction = fakeTransactionModel({
    docs: [
      {
        _id: "tx_1",
        reference: "PN-1",
        amount: { toString: () => "100" },
        securityAnswerHash: "SECRET",
        verificationToken: "SECRET",
      },
    ],
    total: 1,
    calls,
  });

  const handler = createListInternal({ Transaction });
  const { res, out } = fakeRes();

  await handler({ user: { id: "u1" }, query: { limit: "10" } }, res, (e) => {
    throw e;
  });

  assert.equal(out.body.success, true);
  assert.equal(out.body.count, 1);
  assert.equal(out.body.total, 1);
  assert.equal(out.body.hasMore, false);
  assert.equal(out.body.data[0].id, "tx_1");
  assert.equal(out.body.data[0].amount, 100);
});

test("aucun secret ne sort, même si la projection était contournée", async () => {
  // Le faux modèle ignore volontairement la projection et rend les secrets :
  // c'est le sérialiseur, seconde barrière, qui doit les retirer.
  const Transaction = fakeTransactionModel({
    docs: [
      {
        _id: "tx_1",
        securityAnswerHash: "SECRET",
        verificationToken: "SECRET",
        securityCode: "123456",
        attemptCount: 3,
      },
    ],
    total: 1,
  });

  const handler = createListInternal({ Transaction });
  const { res, out } = fakeRes();

  await handler({ user: { id: "u1" }, query: {} }, res, (e) => {
    throw e;
  });

  const serialized = JSON.stringify(out.body);

  for (const secret of ["securityAnswerHash", "verificationToken", "securityCode"]) {
    assert.ok(!serialized.includes(secret), `${secret} ne doit jamais sortir`);
  }

  assert.ok(!serialized.includes("SECRET"));
});

test("la requête ne porte que des champs indexés", async () => {
  const calls = [];
  const Transaction = fakeTransactionModel({ calls });

  await createListInternal({ Transaction })(
    { user: { id: "u1" }, query: {} },
    fakeRes().res,
    (e) => {
      throw e;
    }
  );

  const find = calls.find((c) => c.op === "find");

  assert.deepEqual(find.query, {
    $or: [{ sender: "u1" }, { receiver: "u1" }, { userId: "u1" }],
  });
});

test("hasMore est calculé par limit + 1, sans compter", async () => {
  const calls = [];
  const docs = Array.from({ length: 11 }, (_, i) => ({ _id: `tx_${i}` }));
  const Transaction = fakeTransactionModel({ docs, total: 999, calls });

  const { res, out } = fakeRes();

  await createListInternal({ Transaction })(
    { user: { id: "u1" }, query: { limit: "10" } },
    res,
    (e) => {
      throw e;
    }
  );

  assert.equal(calls.find((c) => c.op === "limit").n, 11);
  assert.equal(out.body.hasMore, true);
  assert.equal(out.body.count, 10, "le document sentinelle n'est pas rendu");
});

test("le plafond de pagination ne peut pas être dépassé", async () => {
  const Transaction = fakeTransactionModel();
  const { res, out } = fakeRes();

  await createListInternal({ Transaction })(
    { user: { id: "u1" }, query: { limit: "100000" } },
    res,
    (e) => {
      throw e;
    }
  );

  assert.equal(out.body.limit, 100);
});

test("un appelant non authentifié reçoit 401", async () => {
  const Transaction = fakeTransactionModel();
  const { res, out } = fakeRes();

  await createListInternal({ Transaction })({ query: {} }, res, (e) => {
    throw e;
  });

  assert.equal(out.statusCode, 401);
});

test("une erreur de base part dans next(), jamais dans la réponse", async () => {
  const Transaction = fakeTransactionModel();
  Transaction.countDocuments = async () => {
    throw new Error("cluster indisponible");
  };

  let caught = null;

  await createListInternal({ Transaction })(
    { user: { id: "u1" }, query: {} },
    fakeRes().res,
    (e) => {
      caught = e;
    }
  );

  assert.equal(caught?.message, "cluster indisponible");
});

test("les dépendances manquantes sont refusées à la CONSTRUCTION", () => {
  // Au démarrage du service, pas à la première requête d'un utilisateur.
  assert.throws(() => createListInternal({}), /Transaction/);
  assert.throws(
    () => createListInternal({ Transaction: {}, toPublic: "pas une fonction" }),
    /toPublic/
  );
});

test("une projection qui cesse de couvrir un secret fait échouer le démarrage", () => {
  // C'est la garantie qui compte : l'oubli se voit au boot, bruyamment, et non
  // en production sous la forme d'une fuite silencieuse.
  assert.throws(
    () =>
      createListInternal({
        Transaction: {},
        projection: { __v: 0 },
        secretFields: ["securityAnswerHash"],
      }),
    /securityAnswerHash/
  );
});

/* -------------------------------------------------------------------------- */
/* Couture — outil de transition pour le code pas encore converti             */
/* -------------------------------------------------------------------------- */

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
