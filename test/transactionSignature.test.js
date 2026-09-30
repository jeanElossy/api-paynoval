"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  bodyDigest,
  buildSignedMessage,
  decideSignature,
  stableStringify,
} = require("../src/services/security/transactionSignature");

// Shared with payNoval-master/utils/deviceSigning.test.js — must match byte for byte.
const VECTOR = { b: [1, "é", null, { z: 1, a: true }], a: { y: 1.5, x: '<"\\n>' }, c: 0 };
const VECTOR_DIGEST = "620f3daa27433c8155fbd24c895c73a7beed2d1fd309f1b47018b4f8adaed329";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const spki = { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), format: "spki" };
const pkcs1 = { publicKey: publicKey.export({ type: "pkcs1", format: "der" }).toString("base64"), format: "pkcs1" };

const NOW = 1_800_000_000_000;
const base = { userId: "u1", deviceId: "d1", idempotencyKey: "idem-12345678", body: { amount: 10 }, timestamp: NOW };
const sign = (message) => crypto.sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64");

test("canonical body digest matches the mobile vector", () => {
  assert.equal(bodyDigest(VECTOR), VECTOR_DIGEST);
  assert.equal(stableStringify({ b: 1, a: undefined }), '{"b":1}');
});

test("a valid signature passes, with SPKI (Android) and PKCS#1 (iOS) keys", () => {
  const message = buildSignedMessage(base);
  for (const key of [spki, pkcs1]) {
    const v = decideSignature({ deviceSigningKey: key, userHasBoundDevice: true, signature: sign(message), timestamp: NOW, message, now: NOW });
    assert.equal(v.ok, true);
    assert.equal(v.level, "device_signature");
  }
});

test("a signature over another body is refused", () => {
  const signed = sign(buildSignedMessage(base));
  const tampered = buildSignedMessage({ ...base, body: { amount: 10000 } });
  const v = decideSignature({ deviceSigningKey: spki, userHasBoundDevice: true, signature: signed, timestamp: NOW, message: tampered, now: NOW });
  assert.deepEqual([v.ok, v.code], [false, "SCA_INVALID"]);
});

test("a stale signature is refused", () => {
  const message = buildSignedMessage(base);
  const v = decideSignature({ deviceSigningKey: spki, userHasBoundDevice: true, signature: sign(message), timestamp: NOW, message, now: NOW + 6 * 60 * 1000 });
  assert.equal(v.code, "SCA_EXPIRED");
});

test("a bound device must sign; an unbound device of a bound account is refused", () => {
  assert.equal(decideSignature({ deviceSigningKey: spki, userHasBoundDevice: true, message: "m" }).code, "SCA_REQUIRED");
  assert.equal(decideSignature({ deviceSigningKey: null, userHasBoundDevice: true, message: "m" }).code, "SCA_DEVICE_NOT_BOUND");
  assert.equal(decideSignature({ deviceSigningKey: { publicKey: "x", revokedAt: new Date() }, userHasBoundDevice: false, message: "m" }).code, "SCA_NONE");
});

test("the check runs before idempotency on /initiate", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "transactionsRoutes.js"), "utf8");
  const start = routes.indexOf('router.post(\n  "/initiate"');
  assert.ok(start > -1);
  const block = routes.slice(start, start + 400);
  assert.ok(block.indexOf("requireTransactionSignature()") > -1);
  assert.ok(block.indexOf("requireTransactionSignature()") < block.indexOf("idempotency()"));
});
