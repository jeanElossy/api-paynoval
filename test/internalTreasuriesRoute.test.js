"use strict";

/**
 * PROVISIONNEMENT D'UN COMPTE INTERNE — `POST /internal/treasuries/ensure`.
 *
 * Défaut fermé le 2026-09-22 : le backend principal écrivait directement dans
 * `txsystembalances` (collection de Tx-Core) avec son propre schéma, et son
 * seed « finançait » une trésorerie en recopiant un solde — de l'argent créé
 * sans écriture comptable. Le backend DEMANDE désormais, Tx-Core écrit.
 *
 * Aucune base : les deux connexions sont simulées dans le cache de modules.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const DB_PATH = path.join(__dirname, "..", "src", "config", "db.js");
const { ensureTreasury } = require("../src/controllers/internalTreasuries.controller");

const USER = "69dadd3370fd7d74cf627182";

const reponse = () => ({
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});

const requete = (body = {}) => ({
  body: { userId: USER, systemType: "FEES_TREASURY", currency: "CAD", ...body },
  headers: {},
});

function usersConnWith(owner) {
  return { db: { collection: () => ({ findOne: async () => owner }) } };
}

/**
 * Simule `config/db` ET la fabrique du modèle dans le cache de modules. Les
 * deux peuvent ne pas être chargés : on pose alors une entrée, qu'on retire.
 */
async function avecBase({ owner, ensure }, fn) {
  const saved = require.cache[DB_PATH] || { exports: require(DB_PATH) };
  const appels = [];

  const conn = {
    models: {},
    model: () => ({}),
  };

  const modelPath = path.join(__dirname, "..", "src", "models", "TxSystemBalance.js");
  const savedModel = require.cache[modelPath];

  require.cache[modelPath] = {
    ...(savedModel || {}),
    id: modelPath,
    filename: modelPath,
    loaded: true,
    exports: () => ({
      ensureSystemWallet: async (...args) => {
        appels.push(args);
        return ensure ? ensure(...args) : { _id: "t1", systemType: args[1], defaultCurrency: args[2], managedCurrency: "MULTI", isActive: true };
      },
    }),
  };

  require.cache[DB_PATH] = {
    ...saved,
    exports: { ...saved.exports, getTxConn: () => conn, getUsersConn: () => usersConnWith(owner) },
  };

  try {
    await fn();
  } finally {
    require.cache[DB_PATH] = saved;

    if (savedModel) require.cache[modelPath] = savedModel;
    else delete require.cache[modelPath];
  }

  return appels;
}

const SYSTEME = { _id: USER, isSystem: true, systemType: "FEES_TREASURY" };

test("compte système du bon type ⇒ provisionné à zéro", async () => {
  const res = reponse();

  const appels = await avecBase({ owner: SYSTEME }, () => ensureTreasury(requete(), res));

  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.treasury, {
    id: "t1",
    systemType: "FEES_TREASURY",
    defaultCurrency: "CAD",
    managedCurrency: "MULTI",
    isActive: true,
  });
  assert.equal(appels[0][3].allowCreate, true, "le provisionnement est le SEUL chemin de création");
});

test("aucun montant n'est accepté — approvisionner est une écriture comptable", async () => {
  for (const champ of ["amount", "balance", "balances", "credit", "initialBalances"]) {
    const res = reponse();

    await avecBase({ owner: SYSTEME }, () =>
      ensureTreasury(requete({ [champ]: 10000 }), res)
    );

    assert.equal(res.code, 400, `${champ} aurait dû être refusé`);
    assert.equal(res.body.code, "AMOUNT_NOT_ALLOWED");
  }
});

test("le propriétaire doit être LE compte système de ce type", async () => {
  const autreType = reponse();
  await avecBase({ owner: { _id: USER, isSystem: true, systemType: "FX_MARGIN_TREASURY" } }, () =>
    ensureTreasury(requete(), autreType)
  );
  assert.equal(autreType.code, 409);
  assert.equal(autreType.body.code, "NOT_A_SYSTEM_ACCOUNT");

  const client = reponse();
  await avecBase({ owner: { _id: USER, isSystem: false, role: "user" } }, () =>
    ensureTreasury(requete(), client)
  );
  assert.equal(client.code, 409);

  const absent = reponse();
  await avecBase({ owner: null }, () => ensureTreasury(requete(), absent));
  assert.equal(absent.code, 404);
});

test("identifiant, type et devise sont validés — aucune valeur par défaut", async () => {
  const cas = [
    [{ userId: "abc" }, "INVALID_USER_ID"],
    [{ systemType: "INCONNU" }, "INVALID_SYSTEM_TYPE"],
    [{ currency: "" }, "INVALID_CURRENCY"],
  ];

  for (const [override, code] of cas) {
    const res = reponse();
    await avecBase({ owner: SYSTEME }, () => ensureTreasury(requete(override), res));

    assert.equal(res.code, 400);
    assert.equal(res.body.code, code);
  }
});

test("la route est montée derrière le jeton interne", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "internalWallets.routes.js"),
    "utf8"
  );

  assert.match(source, /router\.post\(\s*"\/treasuries\/ensure",\s*internalProtect/);
});
