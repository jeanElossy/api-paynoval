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
  require.cache[DB_PATH] = { ...saved, exports: { ...saved.exports, getTxConn: () => conn } };

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
