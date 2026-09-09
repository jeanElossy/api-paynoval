"use strict";

/**
 * LE RÈGLEMENT PRESTATAIRE PASSE PAR LA MACHINE À ÉTATS
 * ============================================================================
 *
 * `externalSettlementController.js` est le chemin qui crédite un bénéficiaire à
 * réception d'un rappel prestataire. C'est le plus exposé du service : il est
 * déclenché par un TIERS. Jusqu'au 2026-09-03 il écrivait `tx.status` en direct
 * à quatre endroits, sans jamais consulter `assertTransition` — alors que le
 * document d'architecture affirmait que la machine était « la seule autorité ».
 *
 * `isFinalOrAutoCancelled` couvrait déjà les états FINAUX. Ce test verrouille
 * ce qu'elle ne couvrait pas : les états non finaux que la machine refuse.
 *
 * Lecture du source plutôt qu'import : charger ce contrôleur charge `runtime`,
 * qui résout `getTxConn()` au chargement — donc une connexion Mongo.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { canTransition, STATES } = require("../src/services/transactionStateMachine");

const CHEMIN = path.join(__dirname, "..", "src", "controllers", "externalSettlementController.js");
const SOURCE = fs.readFileSync(CHEMIN, "utf8");

/* -------------------------------------------------------------------------- */
/* Les transitions que la barrière doit refuser                               */
/* -------------------------------------------------------------------------- */

test("les états non finaux que la machine refuse restent refusés", () => {
  /**
   * Chacun était atteignable avant le correctif : ni final, ni auto-annulé,
   * donc `isFinalOrAutoCancelled` les laissait passer.
   */
  const refuses = [
    [STATES.LOCKED, "confirmed", "un rappel sur une transaction VERROUILLÉE créditait le bénéficiaire"],
    [STATES.RELAUNCH, "confirmed", "une relance doit repasser par `pending` avant confirmation"],
    [STATES.CREATED, "processing", "une transaction pas encore en attente n'est pas en cours de traitement"],
    [STATES.CREATED, "confirmed", "confirmer une transaction jamais mise en attente"],
    [STATES.LOCKED, "processing", "traiter une transaction verrouillée"],
  ];

  for (const [depuis, vers, pourquoi] of refuses) {
    assert.equal(canTransition(depuis, vers), false, `${depuis} -> ${vers} : ${pourquoi}`);
  }
});

test("les transitions légitimes du règlement restent permises", () => {
  // Si l'une d'elles cassait, des règlements valides seraient refusés :
  // le client aurait payé sans être crédité.
  const permises = [
    [STATES.PENDING_CONFIRMATION, "processing"],
    [STATES.PENDING_CONFIRMATION, "confirmed"],
    [STATES.PENDING_CONFIRMATION, "failed"],
    [STATES.PENDING_REVIEW, "confirmed"],
    [STATES.PROCESSING, "confirmed"],
    [STATES.PROCESSING, "failed"],
    [STATES.RELAUNCH, "processing"],
    [STATES.RELAUNCH, "failed"],
  ];

  for (const [depuis, vers] of permises) {
    assert.ok(canTransition(depuis, vers), `${depuis} -> ${vers} doit rester possible`);
  }
});

/* -------------------------------------------------------------------------- */
/* La barrière est là, et au bon endroit                                      */
/* -------------------------------------------------------------------------- */

test("le contrôleur consulte la machine à états", () => {
  assert.match(
    SOURCE,
    /require\(["'][^"']*transactionStateMachine["']\)/,
    "le règlement doit importer la machine à états"
  );
  assert.match(SOURCE, /canTransition\(\s*tx\.status\s*,\s*statutVise\s*\)/);
});

test("la barrière précède TOUT mouvement d'argent", () => {
  const posBarriere = SOURCE.indexOf("canTransition(tx.status, statutVise)");
  assert.ok(posBarriere > -1, "barrière introuvable");

  // Les quatre fonctions de règlement sont appelées après elle.
  for (const appel of [
    "await settleProcessingWebhook({",
    "await settleOutboundSuccess({",
    "await settleInboundSuccess({",
    "await settleFailureWebhook({",
  ]) {
    const pos = SOURCE.indexOf(appel);
    assert.ok(pos > -1, `${appel} introuvable`);
    assert.ok(
      posBarriere < pos,
      `${appel} est appelé AVANT la barrière : l'argent bougerait puis on refuserait ` +
        "le statut — le pire des deux."
    );
  }
});

test("les trois statuts visés sont correctement dérivés du rappel", () => {
  const m = SOURCE.match(/const\s+statutVise\s*=([\s\S]*?);/);
  assert.ok(m, "statutVise introuvable");
  const expr = m[1];

  assert.match(expr, /"PROCESSING"[\s\S]*?"processing"/);
  assert.match(expr, /"SUCCESS"[\s\S]*?"confirmed"/);
  assert.match(expr, /"failed"/, "tout le reste est un échec");
});

test("un refus rend 409 et dit qu'aucun argent n'a bougé", () => {
  assert.match(SOURCE, /statusCode:\s*409/);
  assert.match(SOURCE, /INVALID_STATE_TRANSITION/);
  assert.match(
    SOURCE,
    /Aucun mouvement d'argent n'a eu lieu/,
    "le message doit être sans ambiguïté pour qui lit le journal du prestataire"
  );
});

test("la garde des états finaux n'a pas été retirée au passage", () => {
  // La nouvelle barrière la COMPLÈTE, elle ne la remplace pas : un rappel sur
  // une transaction déjà confirmée doit rendre 200/ignored, pas 409.
  assert.match(SOURCE, /if\s*\(\s*isFinalOrAutoCancelled\(tx\)\s*\)/);
  assert.ok(
    SOURCE.indexOf("isFinalOrAutoCancelled(tx)") <
      SOURCE.indexOf("canTransition(tx.status, statutVise)"),
    "les états finaux se traitent d'abord, en 200/ignored"
  );
});
