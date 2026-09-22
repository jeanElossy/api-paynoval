"use strict";

/**
 * État de la trésorerie de parrainage — lecture seule, et qui ne ment pas.
 *
 * Deux garanties sont verrouillées ici :
 *   1. lire un état ne PROVISIONNE jamais un portefeuille système (une simple
 *      supervision ne doit pas pouvoir fabriquer une trésorerie orpheline) ;
 *   2. chaque situation où rien ne peut partir porte un motif NOMMÉ — un état
 *      « tout va bien » alors que le solde est nul serait pire que rien.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getReferralTreasuryStatus,
} = require("../src/services/internalReferralTransferService");

const ID = "64b7f3d2e1a4c9f0a1b2c3d4";

/** Double du modèle : retient ce qu'on lui demande. */
function fakeModel({ wallet = null } = {}) {
  const appels = { find: 0, ensure: 0 };

  return {
    appels,
    findSystemWallet: async () => {
      appels.find += 1;
      return wallet;
    },
    ensureSystemWallet: async () => {
      appels.ensure += 1;
      throw new Error("ensureSystemWallet ne doit jamais être appelé ici");
    },
  };
}

test("sans identifiant configuré, l'état le dit — et n'interroge pas la base", async () => {
  const model = fakeModel();

  const status = await getReferralTreasuryStatus({
    treasuryUserId: "",
    TxSystemBalance: model,
  });

  assert.equal(status.configured, false);
  assert.equal(status.provisioned, false);
  assert.equal(status.reason, "TREASURY_USER_ID_MISSING");
  assert.equal(status.balance, null);
  assert.equal(model.appels.find, 0);
});

test("un systemType étranger est refusé, pas interprété", async () => {
  const model = fakeModel();

  const status = await getReferralTreasuryStatus({
    treasuryUserId: ID,
    treasurySystemType: "FEES_TREASURY",
    TxSystemBalance: model,
  });

  assert.equal(status.reason, "INVALID_REFERRAL_TREASURY_TYPE");
  assert.equal(status.provisioned, false);
  assert.equal(model.appels.find, 0);
});

test("portefeuille absent : signalé, JAMAIS créé au passage", async () => {
  const model = fakeModel({ wallet: null });

  const status = await getReferralTreasuryStatus({
    treasuryUserId: ID,
    TxSystemBalance: model,
  });

  assert.equal(status.configured, true);
  assert.equal(status.provisioned, false);
  assert.equal(status.reason, "SYSTEM_WALLET_NOT_PROVISIONED");
  // La garantie centrale de ce test.
  assert.equal(model.appels.ensure, 0);
  assert.equal(model.appels.find, 1);
});

test("un solde nul ne s'annonce pas comme une trésorerie prête", async () => {
  const model = fakeModel({ wallet: { balances: { CAD: 0 } } });

  const status = await getReferralTreasuryStatus({
    treasuryUserId: ID,
    TxSystemBalance: model,
  });

  assert.equal(status.provisioned, true);
  assert.equal(status.balance, 0);
  assert.equal(status.reason, "TREASURY_EMPTY");
});

test("une trésorerie approvisionnée rend son solde, sans motif", async () => {
  const model = fakeModel({ wallet: { balances: { CAD: 1250.5 } } });

  const status = await getReferralTreasuryStatus({
    treasuryUserId: ID,
    TxSystemBalance: model,
  });

  assert.equal(status.provisioned, true);
  assert.equal(status.balance, 1250.5);
  assert.equal(status.currency, "CAD");
  assert.equal(status.reason, "");
});

test("le solde lu est celui de la devise de la trésorerie, pas d'une autre", async () => {
  // Une trésorerie qui détient des XOF mais pas de CAD ne peut pas payer :
  // lire « il y a de l'argent » serait faux.
  const model = fakeModel({ wallet: { balances: { XOF: 900000 } } });

  const status = await getReferralTreasuryStatus({
    treasuryUserId: ID,
    TxSystemBalance: model,
  });

  assert.equal(status.balance, 0);
  assert.equal(status.reason, "TREASURY_EMPTY");
});
