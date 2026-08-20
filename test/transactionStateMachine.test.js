"use strict";

/**
 * Machine à états transactionnelle.
 *
 * `assertTransition` est la seule autorité sur les transitions, mais rien ne le
 * vérifiait : `relaunchController` écrivait `tx.status = "relaunch"` en direct,
 * effectuant en production deux transitions (`pending → relaunch` et
 * `locked → relaunch`) que `ALLOWED` ne déclarait pas. Le contournement était
 * invisible précisément parce qu'aucun test ne lisait la table.
 *
 * Ce fichier fige donc les deux faces :
 *   — les transitions INTERDITES le restent (la liste vient du §5 de l'audit) ;
 *   — les transitions AUTORISÉES, y compris les relances administratives
 *     nouvellement déclarées, sont bien acceptées.
 *
 * Le module est pur : ni configuration, ni Mongo, ni réseau. Il se charge donc
 * directement, contrairement aux contrôleurs qui traînent `dotenv-safe`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STATES,
  ALLOWED,
  canTransition,
  assertTransition,
} = require("../src/services/transactionStateMachine");

/**
 * Les interdictions absolues de l'audit. Chacune est une manière différente de
 * faire réapparaître de l'argent déjà réglé ou déjà rendu.
 */
const FORBIDDEN = [
  ["cancelled", "confirmed"],
  ["confirmed", "confirmed"],
  ["confirmed", "cancelled"],
  ["failed", "confirmed"],
  ["refunded", "confirmed"],
  ["refunded", "cancelled"],
  ["cancelled", "processing"],
  ["cancelled", "failed"],
  ["confirmed", "processing"],
  ["confirmed", "pending"],
  ["created", "confirmed"],
  ["created", "processing"],
];

test("les transitions interdites par l'audit sont refusées", () => {
  for (const [from, to] of FORBIDDEN) {
    assert.equal(
      canTransition(from, to),
      false,
      `${from} -> ${to} ne doit jamais être autorisée`
    );

    assert.throws(
      () => assertTransition(from, to),
      /Transition invalide/,
      `${from} -> ${to} devrait lever`
    );
  }
});

test("une transaction ne peut pas passer directement de created à confirmed", () => {
  // §3 : « passer directement à COMPLETED sans validation requise ». Le chemin
  // légitime impose l'étape d'attente de confirmation.
  assert.equal(canTransition(STATES.CREATED, STATES.CONFIRMED), false);
  assert.equal(canTransition(STATES.CREATED, STATES.PENDING_CONFIRMATION), true);
  assert.equal(
    canTransition(STATES.PENDING_CONFIRMATION, STATES.CONFIRMED),
    true
  );
});

test("un état confirmé ne mène qu'au remboursement", () => {
  assert.deepEqual(ALLOWED[STATES.CONFIRMED], [STATES.REFUNDED]);
});

test("un remboursement est terminal", () => {
  assert.deepEqual(ALLOWED[STATES.REFUNDED], []);

  for (const target of Object.values(STATES)) {
    assert.equal(
      canTransition(STATES.REFUNDED, target),
      false,
      `refunded -> ${target} doit être refusée`
    );
  }
});

test("les relances administratives sont déclarées, pas contournées", () => {
  /**
   * `relaunchController` accepte pending/cancelled/locked/failed. Les quatre
   * doivent exister dans la table, sinon le contrôleur retombe à écrire le
   * statut en direct — ce qu'il faisait avant le correctif.
   */
  for (const from of ["pending", "cancelled", "locked", "failed"]) {
    assert.equal(
      canTransition(from, STATES.RELAUNCH),
      true,
      `${from} -> relaunch doit être déclarée dans ALLOWED`
    );
  }
});

test("une relance ne mène jamais directement à confirmed", () => {
  /**
   * Garde-fou du flow interne : `assertConfirmable` appelle `assertTransition`,
   * donc une transaction relancée doit repasser par `pending`. Le flow externe
   * sortant, lui, autorise explicitement `relaunch` — c'est pourquoi la garde
   * `reserveReleased` de `confirmTransaction` est indispensable de ce côté.
   */
  assert.equal(canTransition(STATES.RELAUNCH, STATES.CONFIRMED), false);
  assert.equal(
    canTransition(STATES.RELAUNCH, STATES.PENDING_CONFIRMATION),
    true
  );
});

test("le verrouillage anti-brute-force est réversible mais ne saute pas d'étape", () => {
  assert.equal(canTransition(STATES.PENDING_CONFIRMATION, STATES.LOCKED), true);
  assert.equal(canTransition(STATES.LOCKED, STATES.PENDING_CONFIRMATION), true);
  assert.equal(canTransition(STATES.LOCKED, STATES.CANCELLED), true);

  // Un verrou ne se lève pas en confirmant.
  assert.equal(canTransition(STATES.LOCKED, STATES.CONFIRMED), false);
});

test("la table est insensible à la casse et aux espaces parasites", () => {
  // `normalizeState` existe pour absorber les statuts venus d'un provider ou
  // d'un ancien document. Le vérifier évite qu'un " Pending " passe pour un
  // état inconnu et bloque une confirmation légitime.
  assert.equal(canTransition("  PENDING  ", "Confirmed"), true);
  assert.equal(canTransition("CANCELLED", "CONFIRMED"), false);
});

test("un statut inconnu n'ouvre aucune transition", () => {
  // Fail-safe : une valeur absente de la table ne doit jamais être permissive.
  for (const target of Object.values(STATES)) {
    assert.equal(canTransition("statut_inexistant", target), false);
    assert.equal(canTransition("", target), false);
    assert.equal(canTransition(null, target), false);
    assert.equal(canTransition(undefined, target), false);
  }
});
