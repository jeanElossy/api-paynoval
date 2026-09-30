"use strict";

/**
 * The error handler exposes a machine-readable `code` on client errors.
 *
 * The mobile app refreshes the session and replays a request on a session 401.
 * Tx-Core ALSO answers 401 to a wrong security answer on /transactions/confirm;
 * without a code the app replayed it after a refresh, burning a second
 * attempt of the recipient's quota. This test calls the real handler.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const createError = require("http-errors");
const fs = require("node:fs");
const path = require("node:path");

const errorHandler = require("../src/middleware/errorHandler");

function run(err) {
  let statusCode = null;
  let body = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  errorHandler(err, { originalUrl: "/api/v1/transactions/confirm", method: "POST" }, res, () => {});
  return { statusCode, body };
}

test("a business 401 carries its code", () => {
  const { statusCode, body } = run(
    createError(401, "Réponse incorrecte.", { code: "SECURITY_ANSWER_INVALID" })
  );
  assert.equal(statusCode, 401);
  assert.equal(body.code, "SECURITY_ANSWER_INVALID");
});

test("a 500 never exposes a system error code", () => {
  const err = new Error("connect ECONNREFUSED");
  err.code = "ECONNREFUSED";
  const { statusCode, body } = run(err);
  assert.equal(statusCode, 500);
  assert.equal(body.code, undefined);
});

test("a system-looking code is not exposed even on a 4xx", () => {
  const err = createError(400, "bad");
  err.code = "ENOENT";
  assert.equal(run(err).body.code, undefined);
});

test("confirm tags every wrong answer with SECURITY_ANSWER_INVALID", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "transactions", "handlers", "confirmTransaction.js"),
    "utf8"
  );
  const wrongAnswers = [...source.matchAll(/createError\(\s*401,\s*[`"]Réponse incorrecte[\s\S]*?\)\s*;/g)];
  assert.ok(wrongAnswers.length >= 2, `found ${wrongAnswers.length}`);
  for (const [call] of wrongAnswers) {
    assert.match(call, /SECURITY_ANSWER_INVALID/);
  }
});
