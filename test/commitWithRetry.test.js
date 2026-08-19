"use strict";

/**
 * Le rejeu du commit protège un cas précis et coûteux :
 * `UnknownTransactionCommitResult` ne dit pas « échec », il dit « je ne sais
 * pas ». Traiter ce signal comme un échec, c'est déclarer perdue une opération
 * peut-être réussie — et, si l'appelant réessaie, la faire deux fois.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { commitWithRetry, isUnknownCommitResult } = require("../src/utils/commitWithRetry");

function unknownCommitError() {
  const err = new Error("commit incertain");
  err.errorLabels = ["UnknownTransactionCommitResult"];
  err.hasErrorLabel = (label) => err.errorLabels.includes(label);
  return err;
}

function otherError() {
  const err = new Error("WriteConflict");
  err.errorLabels = ["TransientTransactionError"];
  err.hasErrorLabel = (label) => err.errorLabels.includes(label);
  return err;
}

/** Session factice : échoue `failures` fois, puis réussit. */
function fakeSession(failures, error = unknownCommitError) {
  const state = { calls: 0 };
  return {
    state,
    async commitTransaction() {
      state.calls += 1;
      if (state.calls <= failures) throw error();
    },
  };
}

test("un commit qui passe du premier coup n'est pas rejoué", async () => {
  const session = fakeSession(0);
  await commitWithRetry(session);
  assert.equal(session.state.calls, 1);
});

test("un commit incertain est rejoué jusqu'à aboutir", async () => {
  const session = fakeSession(3);
  await commitWithRetry(session);
  assert.equal(session.state.calls, 4, "3 incertitudes puis 1 succès");
});

test("une erreur qui n'est PAS une incertitude remonte immédiatement", async () => {
  const session = fakeSession(1, otherError);

  await assert.rejects(() => commitWithRetry(session), /WriteConflict/);
  assert.equal(session.state.calls, 1, "aucun rejeu sur une vraie erreur");
});

test("hors du budget, l'incertitude est remontée au lieu de boucler sans fin", async () => {
  const session = fakeSession(Number.POSITIVE_INFINITY);

  await assert.rejects(
    () => commitWithRetry(session, { budgetMs: 0 }),
    /commit incertain/
  );

  assert.equal(session.state.calls, 1);
});

test("le rappel de journalisation est invoqué à chaque rejeu", async () => {
  const session = fakeSession(2);
  let retries = 0;

  await commitWithRetry(session, { onRetry: () => { retries += 1; } });

  assert.equal(retries, 2);
});

test("une session absente ou incomplète ne fait pas échouer l'appelant", async () => {
  await commitWithRetry(null);
  await commitWithRetry(undefined);
  await commitWithRetry({});
});

test("l'étiquette est reconnue avec ou sans hasErrorLabel", () => {
  assert.equal(isUnknownCommitResult(unknownCommitError()), true);

  // Pilote ancien : liste brute, pas de méthode.
  assert.equal(
    isUnknownCommitResult({ errorLabels: ["UnknownTransactionCommitResult"] }),
    true
  );

  assert.equal(isUnknownCommitResult(new Error("banale")), false);
  assert.equal(isUnknownCommitResult(null), false);
});
