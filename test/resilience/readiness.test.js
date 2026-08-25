"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateReadiness, createReadiness, STATUS } =
  require("../../src/services/readiness");

/**
 * Fonction pure : ni horloge, ni connexion. On teste la DÉCISION — la seule
 * chose qui, mal prise, envoie du trafic à une instance incapable de le servir.
 */

test("toutes les connexions établies : l'instance prend du trafic", () => {
  const r = evaluateReadiness({ connections: { a: "connected", b: "connected" }, required: ["a", "b"] });

  assert.equal(r.ready, true);
  assert.equal(r.httpStatus, 200);
});

test("une connexion critique manquante retire l'instance de la rotation", () => {
  // Le défaut d'origine : l'état était calculé, mis dans le corps, et le code
  // HTTP restait 200.
  const r = evaluateReadiness({ connections: { a: "connected", b: "disconnected" }, required: ["a", "b"] });

  assert.equal(r.ready, false);
  assert.equal(r.httpStatus, 503);
  assert.deepEqual(r.failing, ["b"]);
});

test("« connecting » n'est pas « connected »", () => {
  const r = evaluateReadiness({ connections: { a: "connecting" }, required: ["a"] });
  assert.equal(r.ready, false);
});

test("une connexion absente du rapport est traitée comme défaillante", () => {
  // Ne jamais supposer qu'un silence vaut succès.
  const r = evaluateReadiness({ connections: {}, required: ["a"] });

  assert.equal(r.ready, false);
  assert.equal(r.checks.a.state, "unknown");
});

test("le vidage l'emporte sur des connexions parfaitement saines", () => {
  const r = evaluateReadiness({
    connections: { a: "connected" }, required: ["a"], draining: true,
  });

  assert.equal(r.status, STATUS.DRAINING);
  assert.equal(r.httpStatus, 503);
});

test("l'état est relu à chaque sonde, jamais mis en cache", () => {
  let current = { a: "connected" };
  const svc = createReadiness({ readConnections: () => current, required: ["a"] });
  svc.markStarted();

  assert.equal(svc.snapshot().ready, true);
  current = { a: "disconnected" };
  assert.equal(svc.snapshot().ready, false);
});

test("une lecture d'état qui lève ne fait pas planter la sonde", () => {
  const svc = createReadiness({
    readConnections: () => { throw new Error("illisible"); },
    required: ["a"],
    logger: { warn() {} },
  });
  svc.markStarted();

  assert.doesNotThrow(() => svc.snapshot());
  assert.equal(svc.snapshot().ready, false);
});
