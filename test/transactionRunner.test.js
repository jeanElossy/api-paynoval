"use strict";

/**
 * Ce test protège un piège coûteux et silencieux : sur le pilote mongodb 5.x
 * (celui de Mongoose 7), `session.withTransaction()` **ne propage pas** la
 * valeur retournée par le corps — il renvoie le résultat du commit.
 *
 * Un appelant qui écrit `const r = await session.withTransaction(...)` obtient
 * donc `undefined` sans la moindre erreur, et répond « succès » avec un corps
 * vide. Vérifié contre le vrai cluster avant d'être contourné.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { runWithTransaction } = require("../src/utils/transactionRunner");

/** Session factice reproduisant le pilote 5.x : le retour du corps est perdu. */
function driver5Session() {
  const state = { bodyRuns: 0 };
  return {
    state,
    async withTransaction(body) {
      state.bodyRuns += 1;
      await body();
      return { ok: 1 }; // résultat du COMMIT, pas celui du corps
    },
  };
}

test("la valeur du corps est rendue, malgré un pilote qui ne la propage pas", async () => {
  const session = driver5Session();

  const result = await runWithTransaction(session, async () => ({ id: "tx_1", montant: 42 }));

  assert.deepEqual(result, { id: "tx_1", montant: 42 });
});

test("sans session, le corps s'exécute quand même (mode dégradé)", async () => {
  const result = await runWithTransaction(null, async () => "degrade");
  assert.equal(result, "degrade");
});

test("un objet sans withTransaction retombe en mode dégradé", async () => {
  const result = await runWithTransaction({}, async () => "degrade");
  assert.equal(result, "degrade");
});

test("la session est transmise au corps", async () => {
  const session = driver5Session();
  let received = null;

  await runWithTransaction(session, async (s) => { received = s; });

  assert.equal(received, session);
});

test("une erreur du corps se propage", async () => {
  const session = driver5Session();

  await assert.rejects(
    () => runWithTransaction(session, async () => { throw new Error("boom"); }),
    /boom/
  );
});

test("un rejeu du corps rend la valeur de la DERNIÈRE exécution", async () => {
  // C'est celle qui a été validée : les précédentes ont été annulées.
  let n = 0;

  const retryingSession = {
    async withTransaction(body) {
      await body().catch(() => {});
      await body();
      return { ok: 1 };
    },
  };

  const result = await runWithTransaction(retryingSession, async () => {
    n += 1;
    if (n === 1) throw new Error("conflit");
    return `execution-${n}`;
  });

  assert.equal(result, "execution-2");
});
