"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { currentRequestId, requestContextMiddleware } = require("../src/utils/requestContext");

test("l'identifiant de requête traverse les attentes", async () => {
  let seen;
  await new Promise((resolve) => {
    requestContextMiddleware({ id: "req-12345678" }, {}, async () => {
      await new Promise((r) => setImmediate(r));
      seen = currentRequestId();
      resolve();
    });
  });
  assert.equal(seen, "req-12345678");
});

test("hors requête, aucune valeur n'est inventée", () => {
  assert.equal(currentRequestId(), null);
});

test("le modèle le pose une seule fois, à la création", () => {
  const model = fs.readFileSync(path.join(__dirname, "../src/models/Transaction.js"), "utf8");
  assert.match(model, /this\.isNew && !this\.requestId/);
  assert.match(model, /requestId: \{[\s\S]*?immutable: true/);
});

test("le contexte est monté juste après l'identifiant", () => {
  const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  assert.match(server, /app\.use\(requestIdMiddleware\);\napp\.use\(requestContextMiddleware\);/);
});
