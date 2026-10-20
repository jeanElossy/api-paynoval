"use strict";

/**
 * A deliberate service-control refusal is NEVER frozen under the
 * Idempotency-Key (2026-10-20). 5xx were already released; the 426
 * UPDATE_REQUIRED (a 4xx) was frozen for 24 h — the same key replayed after
 * updating the app would have been answered "update required" again.
 * A business 4xx (limit, insufficient funds) is still frozen.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const calls = { deleteOne: 0, updateOne: 0 };
const fakeModel = {
  create: async (doc) => ({ ...doc }),
  findOne: () => ({ lean: async () => null }),
  findOneAndUpdate: async () => null,
  deleteOne: () => {
    calls.deleteOne += 1;
    return Promise.resolve();
  },
  updateOne: () => {
    calls.updateOne += 1;
    return Promise.resolve();
  },
};

const dbPath = require.resolve(path.join(__dirname, "..", "..", "src", "config", "db"));
const modelPath = require.resolve(path.join(__dirname, "..", "..", "src", "models", "IdempotencyRecord"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getTxConn: () => ({}) } };
const factory = () => fakeModel;
factory.IN_PROGRESS_LEASE_MS = 60_000;
require.cache[modelPath] = { id: modelPath, filename: modelPath, loaded: true, exports: factory };

const idempotency = require("../../src/middleware/idempotency");

function makeRes() {
  const headers = {};
  return {
    statusCode: 200,
    on() {},
    once() {},
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return headers[k.toLowerCase()];
    },
    status(s) {
      this.statusCode = s;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

async function run(handler) {
  calls.deleteOne = 0;
  calls.updateOne = 0;
  const req = {
    method: "POST",
    path: "/initiate",
    baseUrl: "/api/v1/transactions",
    headers: { "idempotency-key": "key-0123456789abcdef" },
    body: { a: 1 },
    user: { _id: "u1" },
  };
  const res = makeRes();
  await idempotency({ required: true })(req, res, () => handler(res));
  await new Promise((r) => setImmediate(r));
  return { ...calls };
}

test("426 UPDATE_REQUIRED (deliberate) is released, not frozen", async () => {
  const c = await run((res) => {
    res.setHeader("X-PayNoval-Service-Control", "UPDATE_REQUIRED");
    res.status(426).json({ success: false, code: "UPDATE_REQUIRED" });
  });
  assert.deepEqual(c, { deleteOne: 1, updateOne: 0 });
});

test("503 maintenance is released", async () => {
  const c = await run((res) => {
    res.setHeader("X-PayNoval-Service-Control", "FEATURE_UNAVAILABLE");
    res.status(503).json({ success: false });
  });
  assert.deepEqual(c, { deleteOne: 1, updateOne: 0 });
});

test("a business refusal (limit) is still frozen — it is a stable result", async () => {
  const c = await run((res) => res.status(403).json({ success: false, code: "LIMIT_ROLLING_24H" }));
  assert.deepEqual(c, { deleteOne: 0, updateOne: 1 });
});
