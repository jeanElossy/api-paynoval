"use strict";

/**
 * UNE ÉCRITURE DU GRAND LIVRE NE SE MODIFIE NI NE SE SUPPRIME
 * ============================================================================
 *
 * Invariant 4 : toute écriture financière est immuable. Pour corriger, on écrit
 * une contre-écriture (`REVERSAL`/`ADJUSTMENT`/`REFUND`) — jamais on ne réécrit
 * l'originale.
 *
 * L'audit de `ledger.md` du 2026-09-03 a montré, mesures à l'appui, que les
 * gardes de `models/LedgerEntry.js` laissaient TROIS portes ouvertes — et que
 * le commentaire qui les décrivait était inexact dans les deux sens :
 *
 *   • `Model.updateOne` était présenté comme non intercepté. **Il l'est.**
 *   • `Model.updateMany` ne l'était pas — non par incapacité de Mongoose, mais
 *     parce qu'il ne figurait pas dans la liste. Un mot manquant.
 *   • `Model.findOneAndReplace` ne l'était pas. C'est la plus destructrice de
 *     toutes : elle remplace le document ENTIER.
 *   • `doc.deleteOne()` ne l'était pas. Or `doc.remove()` a disparu en
 *     Mongoose 7 : c'est LE geste idiomatique de suppression. Le chemin le plus
 *     probable était le seul non gardé.
 *
 * ── Comment ce test procède ───────────────────────────────────────────────
 *
 * Sans base. Une opération GARDÉE rejette immédiatement, dans le hook, avec
 * `LEDGER_ENTRY_IMMUTABLE`. Une opération NON gardée part vers la couche réseau
 * et n'aboutit jamais — l'attente qui expire EST la preuve qu'aucun hook ne l'a
 * arrêtée. On distingue donc les deux par la nature du rejet, pas par un délai
 * choisi au hasard : un hook rejette de façon synchrone, très en deçà du seuil.
 *
 * Ce test échoue si l'on retire l'une des entrées de `LedgerEntry.js`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const construireSchema = require("../src/models/LedgerEntry");

/**
 * Une connexion NON connectée : `conn.model()` enregistre le schéma avec ses
 * hooks, mais aucune opération n'atteindra jamais un serveur. C'est exactement
 * ce qu'on veut — on n'observe que les hooks.
 */
const conn = mongoose.createConnection();
const LedgerEntry = construireSchema(conn);

const DELAI_MS = 2000;

/** `"garde"` si un hook a refusé, `"passe"` si l'opération a filé vers la base. */
async function verdict(operation) {
  try {
    await Promise.race([
      operation(),
      new Promise((_, rejeter) =>
        setTimeout(() => rejeter(new Error("__PARTI_VERS_LA_BASE__")), DELAI_MS)
      ),
    ]);
    return "passe";
  } catch (err) {
    if (err.code === "LEDGER_ENTRY_IMMUTABLE") return "garde";
    if (err.message === "__PARTI_VERS_LA_BASE__") return "passe";
    throw err;
  }
}

/**
 * Un document VALIDE : la validation Mongoose s'exécute avant le hook `save`.
 * Un document incomplet échouerait sur la validation et ne prouverait rien sur
 * la garde d'immutabilité — le test passerait pour la mauvaise raison.
 */
const documentValide = () =>
  new LedgerEntry({
    transactionId: new mongoose.Types.ObjectId(),
    entryType: "RESERVE",
    direction: "DEBIT",
    accountId: "user_wallet:000000000000000000000001:XOF",
    accountType: "USER_WALLET",
    currency: "XOF",
    amount: 1000,
  });

const docExistant = () => {
  const d = documentValide();
  d.isNew = false;
  return d;
};

/* -------------------------------------------------------------------------- */
/* Mutation                                                                   */
/* -------------------------------------------------------------------------- */

const MUTATIONS = [
  ["Model.updateOne", () => LedgerEntry.updateOne({}, { status: "REVERSED" })],
  ["Model.updateMany", () => LedgerEntry.updateMany({}, { status: "REVERSED" })],
  ["Model.replaceOne", () => LedgerEntry.replaceOne({}, { status: "REVERSED" })],
  ["Model.findOneAndUpdate", () => LedgerEntry.findOneAndUpdate({}, { status: "REVERSED" })],
  ["Model.findOneAndReplace", () => LedgerEntry.findOneAndReplace({}, { status: "REVERSED" })],
  ["doc.save() sur un document existant", () => docExistant().save()],
];

for (const [nom, operation] of MUTATIONS) {
  test(`${nom} est REFUSÉ`, async () => {
    assert.equal(
      await verdict(operation),
      "garde",
      `${nom} n'est pas intercepté : une écriture du grand livre pourrait être ` +
        "modifiée sans laisser de contre-écriture (invariant 4)."
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Suppression — pire encore : une modification laisse `updatedAt`,           */
/* une suppression ne laisse rien                                            */
/* -------------------------------------------------------------------------- */

const SUPPRESSIONS = [
  ["Model.deleteOne", () => LedgerEntry.deleteOne({})],
  ["Model.deleteMany", () => LedgerEntry.deleteMany({})],
  ["Model.findOneAndDelete", () => LedgerEntry.findOneAndDelete({})],
  // Le geste idiomatique en Mongoose 7, `doc.remove()` ayant disparu.
  ["doc.deleteOne()", () => docExistant().deleteOne()],
];

for (const [nom, operation] of SUPPRESSIONS) {
  test(`${nom} est REFUSÉ`, async () => {
    assert.equal(
      await verdict(operation),
      "garde",
      `${nom} n'est pas intercepté : une écriture du grand livre pourrait ` +
        "disparaître sans laisser la moindre trace."
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Ce qui doit RESTER possible                                                */
/* -------------------------------------------------------------------------- */

test("la CRÉATION reste possible — sinon plus rien ne s'écrit", async () => {
  const nouveau = documentValide();
  assert.equal(
    await verdict(() => nouveau.save()),
    "passe",
    "une écriture neuve doit pouvoir être enregistrée : la garde ne vise que la MUTATION"
  );
});

/* -------------------------------------------------------------------------- */
/* La limite réelle, énoncée pour qu'on cesse de la croire plus large         */
/* -------------------------------------------------------------------------- */

test("le message de refus oriente vers la contre-écriture", async () => {
  try {
    await LedgerEntry.updateMany({}, { status: "REVERSED" });
    assert.fail("aurait dû être refusé");
  } catch (err) {
    assert.equal(err.code, "LEDGER_ENTRY_IMMUTABLE");
    assert.match(
      err.message,
      /contre-écriture/i,
      "un refus doit dire quoi faire à la place, sinon on cherche un contournement"
    );
  }
});
