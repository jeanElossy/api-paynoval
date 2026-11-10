"use strict";

/**
 * LE SERVEUR REFUSE UN SOLDE INSUFFISANT — ON NE FAIT PAS CONFIANCE AU MOBILE (2026-11-10)
 * =====================================================================================
 *
 * L'application vérifie le solde en amont (`payNoval-master/utils/balanceSufficiency.js`),
 * pour le confort seulement. La seule barrière qui protège l'argent est ici :
 * `TxWalletBalance.reserve` réserve en UNE opération conditionnelle
 * (`availableAmount: { $gte: n }`) — deux envois simultanés ne peuvent pas
 * passer tous les deux sur le même disponible — et refuse en 422
 * `INSUFFICIENT_FUNDS`, un refus définitif et lisible, jamais un « envoi incertain ».
 *
 * Ces tests exercent la VRAIE fonction (modèle construit sur une connexion
 * jamais ouverte, accès base remplacés) et échouent si l'on retire la
 * condition, si l'on réserve sur le solde total, ou si le refus redevient une
 * erreur interne (règle B.5).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const conn = mongoose.createConnection(); // jamais ouverte : aucune base touchée
const TxWalletBalance = require("../src/models/TxWalletBalance")(conn);
const errorHandler = require("../src/middleware/errorHandler");

const USER = new mongoose.Types.ObjectId();

function stubDb({ returns }) {
  const calls = [];
  const original = { ensureWallet: TxWalletBalance.ensureWallet, findOneAndUpdate: TxWalletBalance.findOneAndUpdate };
  TxWalletBalance.ensureWallet = async () => ({});
  TxWalletBalance.findOneAndUpdate = async (filter, update, options) => {
    calls.push({ filter, update, options });
    return returns;
  };
  return {
    calls,
    restore() {
      TxWalletBalance.ensureWallet = original.ensureWallet;
      TxWalletBalance.findOneAndUpdate = original.findOneAndUpdate;
    },
  };
}

test("la réservation est CONDITIONNELLE au disponible, en une seule opération", async () => {
  const db = stubDb({ returns: { _id: "w" } });
  try {
    await TxWalletBalance.reserve(USER, "XOF", 10000, { mode: "live" });
    assert.equal(db.calls.length, 1);
    const [{ filter, update }] = db.calls;
    assert.deepEqual(filter.availableAmount, { $gte: 10000 });
    assert.equal(filter.status, "active");
    // Le disponible baisse, le réservé monte, du même montant : rien d'autre.
    assert.deepEqual(update.$inc, { reservedAmount: 10000, availableAmount: -10000 });
  } finally {
    db.restore();
  }
});

test("disponible insuffisant : 422 INSUFFICIENT_FUNDS, exposé — pas une erreur interne", async () => {
  const db = stubDb({ returns: null }); // la condition $gte n'a rien trouvé
  try {
    await assert.rejects(TxWalletBalance.reserve(USER, "XOF", 10000, { mode: "live" }), (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.code, "INSUFFICIENT_FUNDS");
      assert.equal(err.expose, true);
      return true;
    });
  } finally {
    db.restore();
  }
});

test("le refus arrive au client avec son code, pas comme « erreur interne »", async () => {
  const db = stubDb({ returns: null });
  let caught;
  try {
    await TxWalletBalance.reserve(USER, "XOF", 10000, { mode: "live" }).catch((e) => {
      caught = e;
    });
  } finally {
    db.restore();
  }

  let status;
  let body;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  errorHandler(caught, { originalUrl: "/api/v1/transactions/initiate", method: "POST" }, res, () => {});
  assert.equal(status, 422);
  assert.equal(body.code, "INSUFFICIENT_FUNDS");
  assert.notEqual(body.message, "Une erreur interne est survenue.");
});

test("un montant nul, négatif ou illisible n'est jamais réservé", async () => {
  const db = stubDb({ returns: { _id: "w" } });
  try {
    for (const bad of [0, -5, "abc", null]) {
      await assert.rejects(TxWalletBalance.reserve(USER, "XOF", bad, { mode: "live" }));
    }
    assert.equal(db.calls.length, 0);
  } finally {
    db.restore();
  }
});

test("les deux chemins d'envoi réservent DANS la transaction qui crée l'opération, avant tout prestataire", () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

  const internal = read("src/services/transactions/handlers/initiateInternal.js");
  const unit = internal.slice(internal.indexOf("runtime.runInTransaction(session"));
  assert.ok(unit.indexOf("Transaction.create(") < unit.indexOf("reserveSenderFunds("), "interne : création puis réserve");
  // Le montant réservé est le brut APRÈS la réduction du code promo.
  assert.match(internal, /promotion = await reservePromotion\(/);
  assert.match(internal, /\} = promotion\.bundle;/);
  assert.match(internal, /const amountSourceStd = round2\(grossFrom\);/);
  assert.match(unit, /reserveSenderFunds\(\{[\s\S]{0,120}amount: amountSourceStd,/);

  const external = read("src/services/transactions/handlers/initiateExternalTransactions.js");
  assert.match(external, /reserveSenderFunds\(\{[\s\S]{0,120}amount: pricingCtx\.amountSourceStd,/);
});
