"use strict";

/**
 * ============================================================================
 * LA RELECTURE DE DÉDUPLICATION DOIT UTILISER SON INDEX — PAS BALAYER
 * ============================================================================
 *
 * ── Ce que ce test empêche de revenir ────────────────────────────────────────
 * `ledgerService.js` relit les clés d'un lot après un refus d'index unique,
 * pour distinguer « ce mouvement était déjà enregistré » de « le lot précédent
 * s'est interrompu au milieu ». C'est un chemin de RATTRAPAGE : il s'exécute
 * quand le système est déjà en train de se reprendre.
 *
 * `dedupKey_unique_partial` est un index PARTIEL de condition
 * `{ dedupKey: { $type: "string" } }`. MongoDB refuse d'utiliser un index
 * partiel tant que le prédicat ne PROUVE pas que les documents cherchés
 * satisfont sa condition — et une égalité sur une chaîne littérale ne le prouve
 * pas : le planificateur ne déduit pas « c'est une chaîne » de « c'est "abc" ».
 *
 * Sans la clause `$type` dans la requête, l'index existe, il est unique, il
 * protège l'écriture — mais la relecture BALAYE TOUTE LA COLLECTION.
 *
 * Mesuré le 2026-08-28 sur le banc de charge, 240 000 écritures :
 *   · sans `$type` → COLLSCAN, 240 000 documents examinés, 125 ms à froid,
 *     et **11 s de moyenne / 16 s au pire** sous la charge de cette suite ;
 *   · avec `$type` → `dedupKey_unique_partial`, **0 document examiné**.
 *
 * ── Pourquoi ce test vit ICI et pas dans `npm test` ─────────────────────────
 * Un plan d'exécution ne s'observe pas sans base : `explain()` est une réponse
 * du serveur, pas une propriété du code. Les suites de `npm test` n'ouvrent
 * aucune connexion et doivent le rester. Ce contrôle appartient donc à la
 * suite de concurrence, qui a déjà une base.
 *
 * ── Comment il tombe ────────────────────────────────────────────────────────
 * Retirer `$type: "string"` de `filtreRelectureDedup()` dans `ledgerService.js` :
 * redevient `COLLSCAN` et l'assertion échoue en le nommant.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const H = require("./lib/harness");

before(async () => {
  await H.ouvrir();
  await H.verifierIndex();
});

after(async () => {
  await H.fermer();
});

/**
 * ⚠️ LE FILTRE VIENT DU SERVICE, IL N'EST PAS RECOPIÉ ICI.
 *
 * La première version de ce test recopiait le filtre. Elle passait donc au vert
 * même après avoir retiré `$type: "string"` de `ledgerService.js` : elle ne
 * vérifiait plus que sa propre copie. Vérifié en retirant réellement la clause
 * du service — 2 tests, 2 verts, la faute intacte.
 *
 * C'est la règle B.5 prise en défaut par le garde-fou lui-même : un test qui
 * passe avant ET après le correctif ne teste rien. On demande donc à MongoDB le
 * plan du filtre RÉELLEMENT utilisé par le service.
 */
const { filtreRelectureDedup } = require("../src/services/ledgerService");

test("la relecture de déduplication utilise dedupKey_unique_partial, jamais un balayage", async () => {
  const e = await H.ouvrir();

  const cles = ["plan-test|leg|0", "plan-test|leg|1"];
  const plan = await e.LedgerEntry.find(filtreRelectureDedup(cles)).explain("executionStats");

  const gagnant = plan.queryPlanner.winningPlan;
  const nomIndex =
    gagnant.inputStage?.inputStage?.indexName || gagnant.inputStage?.indexName || gagnant.indexName;

  assert.equal(
    nomIndex,
    "dedupKey_unique_partial",
    `la relecture de déduplication n'utilise pas son index : plan « ${JSON.stringify(gagnant.stage)} ». ` +
      "Sans `$type: \"string\"` dans le filtre, MongoDB refuse l'index partiel et balaye toute la collection — " +
      "sur le chemin de rattrapage du grand livre."
  );

  assert.equal(
    plan.executionStats.totalDocsExamined,
    0,
    `${plan.executionStats.totalDocsExamined} document(s) examiné(s) pour des clés inexistantes : ` +
      "l'index n'écarte rien, c'est un balayage déguisé."
  );
});

/**
 * Le contrôle précédent porte sur la requête telle qu'on la déclare ici. Celui-ci
 * porte sur la RÉALITÉ : que l'index existe bien avec la bonne condition
 * partielle. Les deux sont nécessaires — un filtre correct sur un index absent
 * balaye tout autant.
 */
test("dedupKey_unique_partial existe, unique, avec sa condition partielle", async () => {
  const e = await H.ouvrir();
  const index = await e.LedgerEntry.collection.indexes();
  const cible = index.find((i) => i.name === "dedupKey_unique_partial");

  assert.ok(
    cible,
    "`dedupKey_unique_partial` est ABSENT. Il ne se pose pas par `npm run indexes:apply` " +
      "(qui ne couvre que les index déclarés aux schémas) mais par `npm run indexes:ledger`. " +
      "Sans lui, l'invariant 3 n'est pas tenu par la base."
  );

  assert.equal(cible.unique, true, "`dedupKey_unique_partial` n'est plus UNIQUE : la déduplication ne tient plus.");
  assert.deepEqual(
    cible.partialFilterExpression,
    { dedupKey: { $type: "string" } },
    "la condition partielle a changé — la requête de `ledgerService.js` doit la refléter, sinon retour au balayage."
  );
});
