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
  scaPayload,
  stableStringify,
} = require("../src/services/security/transactionSignature");

// Shared with payNoval-master/utils/deviceSigning.test.js — must match byte for byte.
const VECTOR = {
  amount: "1500.50",
  funds: "paynoval",
  destination: "paynoval",
  toEmail: "zoé@example.com",
  quoteId: "q_1",
  phoneNumber: "",
  pricingId: null,
  recipientInfo: { z: 1, a: [true, null, '<"\\n>'] },
  note: "not signed",
  action: "send",
};
const VECTOR_CANONICAL =
  '{"amount":1500.5,"destination":"paynoval","funds":"paynoval","quoteId":"q_1","recipientInfo":{"a":[true,null,"<\\"\\\\n>"],"z":1},"toEmail":"zoé@example.com"}';
const VECTOR_DIGEST = "15cc2b46db618968a2f6d56c4d66f2bb4971043bd1ab4df8e68cd57785169e4b";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const spki = { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), format: "spki" };
const pkcs1 = { publicKey: publicKey.export({ type: "pkcs1", format: "der" }).toString("base64"), format: "pkcs1" };

const NOW = 1_800_000_000_000;
const base = { userId: "u1", deviceId: "d1", idempotencyKey: "idem-12345678", body: { amount: 10 }, timestamp: NOW };
const sign = (message) => crypto.sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64");

test("canonical SCA payload digest matches the mobile vector", () => {
  assert.equal(stableStringify(scaPayload(VECTOR)), VECTOR_CANONICAL);
  assert.equal(bodyDigest(VECTOR), VECTOR_DIGEST);
  assert.equal(stableStringify({ b: 1, a: undefined }), '{"b":1}');
});

test("the digest survives the gateway normalisation, not a change of payee or amount", () => {
  // What the gateway forwards: Joi-converted amount, stripped extras, added fields.
  const forwarded = { ...VECTOR, amount: 1500.5, note: undefined, provider: "paynoval", method: "INTERNAL" };
  assert.equal(bodyDigest(forwarded), VECTOR_DIGEST);

  assert.notEqual(bodyDigest({ ...VECTOR, toEmail: "mallory@example.com" }), VECTOR_DIGEST);
  assert.notEqual(bodyDigest({ ...VECTOR, amount: "1500.51" }), VECTOR_DIGEST);
  assert.notEqual(bodyDigest({ ...VECTOR, quoteId: "q_2" }), VECTOR_DIGEST);
  assert.notEqual(bodyDigest({ ...VECTOR, recipientInfo: { ...VECTOR.recipientInfo, z: 2 } }), VECTOR_DIGEST);
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
