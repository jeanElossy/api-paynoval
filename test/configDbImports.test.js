"use strict";

/**
 * Tout ce qu'un module importe de `config/db` EXISTE — 2026-09-17.
 *
 * `controllers/internalWallets.controller.js` importait
 * `getTransactionsConnection`, jamais exporté par `config/db.js`. La
 * déstructuration rendait `undefined` sans bruit ; l'appel levait `TypeError`
 * à chaque provisionnement de portefeuille. Mesuré en production : 500 à
 * chaque inscription (le backend annule l'utilisateur quand le portefeuille
 * n'est pas créé), du 2026-09-10 au 2026-09-17.
 *
 * Aucune base ouverte : on lit les sources et les clés exportées.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const DB_PATH = path.join(SRC, "config", "db.js");
const exported = new Set(Object.keys(require(DB_PATH)));

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function dbImports(file) {
  const code = stripComments(fs.readFileSync(file, "utf8"));
  const found = [];
  const re = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(code))) {
    if (path.resolve(path.dirname(file), m[2]).replace(/\.js$/, "") !== DB_PATH.replace(/\.js$/, "")) continue;
    for (const part of m[1].split(",")) {
      const name = part.split(":")[0].trim();
      if (name) found.push(name);
    }
  }
  return found;
}

test("config/db exporte bien getTxConn (sanity)", () => {
  assert.ok(exported.has("getTxConn"));
});

test("aucun import de config/db ne vise un nom qui n'existe pas", () => {
  const missing = [];
  for (const file of walk(SRC)) {
    for (const name of dbImports(file)) {
      if (!exported.has(name)) missing.push(`${path.relative(SRC, file)} → ${name}`);
    }
  }
  assert.deepEqual(missing, [], `imports inexistants :\n${missing.join("\n")}`);
});

/** Base Users simulée : le contrôleur y lit les marqueurs du compte. */
function usersConnWith(owner) {
  return {
    db: { collection: () => ({ findOne: async () => owner }) },
  };
}

/** Exécute `fn` avec `config/db` simulé, puis restaure le cache de modules. */
async function withStubbedDb({ conn, usersConn }, fn) {
  const saved = require.cache[DB_PATH];

  require.cache[DB_PATH] = {
    ...saved,
    exports: {
      ...saved.exports,
      getTxConn: () => conn,
      getUsersConn: () => {
        if (usersConn instanceof Error) throw usersConn;
        return usersConn;
      },
    },
  };

  try {
    return await fn();
  } finally {
    require.cache[DB_PATH] = saved;
  }
}

const reponse = () => ({
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});

const requete = (userId = "64b000000000000000000001", currency = "xof") => ({
  body: { userId, currency },
  headers: {},
});

test("le provisionnement crée le portefeuille sur la connexion Transactions", async () => {
  const saved = require.cache[DB_PATH];
  const calls = [];
  const conn = {
    models: {
      TxWalletBalance: {
        ensureWallet: async (userId, currency) => {
          calls.push([userId, currency]);
          return { _id: "w1", currency, status: "ACTIVE" };
        },
      },
    },
  };
  require.cache[DB_PATH] = {
    ...saved,
    exports: {
      ...saved.exports,
      getTxConn: () => conn,
      getUsersConn: () => usersConnWith({ _id: "u", role: "user" }),
    },
  };

  try {
    const { ensureWallet } = require("../src/controllers/internalWallets.controller");
    const res = {
      status(code) { this.code = code; return this; },
      json(body) { this.body = body; return this; },
    };

    await ensureWallet({ body: { userId: "64b000000000000000000001", currency: "xof" }, headers: {} }, res);

    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.wallet, { id: "w1", currency: "XOF", status: "ACTIVE" });
    assert.deepEqual(calls, [["64b000000000000000000001", "XOF"]]);
  } finally {
    require.cache[DB_PATH] = saved;
  }
});

test("un compte INTERNE (personnel ou trésorerie) n'obtient pas de portefeuille client", async () => {
  /**
   * Décision du 2026-09-22, reprise des fintechs : une identité de back-office
   * AGIT sur des comptes, elle n'en détient pas ; une trésorerie a son compte
   * dans `txsystembalances`. Mesuré sur les bases -test : un superadmin et un
   * compte support étaient entrés en file de provisionnement.
   */
  const { ensureWallet } = require("../src/controllers/internalWallets.controller");

  const conn = {
    models: {
      TxWalletBalance: {
        ensureWallet: async () => {
          throw new Error("le portefeuille ne doit pas être ouvert");
        },
      },
    },
  };

  for (const owner of [
    { _id: "u", role: "superadmin" },
    { _id: "u", role: "support" },
    { _id: "u", role: "user", isStaff: true },
    { _id: "u", role: "treasury", isSystem: true, systemType: "FEES_TREASURY" },
  ]) {
    const res = reponse();

    await withStubbedDb({ conn, usersConn: usersConnWith(owner) }, () =>
      ensureWallet(requete(), res)
    );

    assert.equal(res.code, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "INTERNAL_ACCOUNT_NO_CLIENT_WALLET");
  }
});

test("compte introuvable ⇒ 404 ; base Users injoignable ⇒ 503 — jamais d'ouverture « dans le doute »", async () => {
  const { ensureWallet } = require("../src/controllers/internalWallets.controller");

  const conn = {
    models: {
      TxWalletBalance: {
        ensureWallet: async () => {
          throw new Error("le portefeuille ne doit pas être ouvert");
        },
      },
    },
  };

  const absent = reponse();
  await withStubbedDb({ conn, usersConn: usersConnWith(null) }, () =>
    ensureWallet(requete(), absent)
  );
  assert.equal(absent.code, 404);
  assert.equal(absent.body.code, "USER_NOT_FOUND");

  const panne = reponse();
  await withStubbedDb({ conn, usersConn: new Error("Users DB non initialisée") }, () =>
    ensureWallet(requete(), panne)
  );
  assert.equal(panne.code, 503);
  assert.equal(panne.body.code, "USER_LOOKUP_UNAVAILABLE");
});
