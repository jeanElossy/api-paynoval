"use strict";

/**
 * TRANSACTION SIGNATURE — server-verified strong customer authentication.
 *
 * The phone keeps an RSA key in its hardware keystore, unlocked by biometrics
 * (enrolled with the account password, `paynoval-backend/utils/signingKey.js`).
 * Each initiation is signed; Tx-Core — the engine that moves the money —
 * verifies it. Local biometrics alone proved nothing to the server: a stolen
 * access token could initiate transfers. Revolut / N26 device binding, PSD2 SCA
 * "possession + inherence".
 *
 * Signed message (UTF-8, `\n`-joined):
 *   PAYNOVAL-SCA-v1 | userId | deviceId | idempotencyKey | sha256(canonical body) | timestampMs
 *
 * The idempotency key already makes a replay harmless (same key + same body ⇒
 * original answer); the timestamp bounds how long a captured signature lives.
 */

const crypto = require("crypto");

const SIGNATURE_VERSION = "PAYNOVAL-SCA-v1";
const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Canonical JSON: sorted keys, `undefined` object members dropped. MUST stay
 * byte-identical to `payNoval-master/utils/paymentIntent.js#stableStringify`
 * (shared test vector in both repositories).
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value === undefined ? null : value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();

  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

const bodyDigest = (body) =>
  crypto.createHash("sha256").update(stableStringify(body ?? null), "utf8").digest("hex");

function buildSignedMessage({ userId, deviceId, idempotencyKey, body, timestamp }) {
  return [
    SIGNATURE_VERSION,
    String(userId || ""),
    String(deviceId || ""),
    String(idempotencyKey || ""),
    bodyDigest(body),
    String(timestamp || ""),
  ].join("\n");
}

function publicKeyObject(signingKey) {
  const der = Buffer.from(String(signingKey?.publicKey || ""), "base64");
  const type = signingKey?.format === "pkcs1" ? "pkcs1" : "spki";
  return crypto.createPublicKey({ key: der, format: "der", type });
}

function verifySignature({ signingKey, message, signature }) {
  try {
    return crypto.verify(
      "RSA-SHA256",
      Buffer.from(message, "utf8"),
      publicKeyObject(signingKey),
      Buffer.from(String(signature || ""), "base64")
    );
  } catch {
    return false;
  }
}

const isActiveKey = (key) => Boolean(key?.publicKey) && !key?.revokedAt;

/**
 * Decision (pure).
 *
 * @returns {{ ok: boolean, status?: number, code: string, level?: string }}
 */
function decideSignature({
  deviceSigningKey,
  userHasBoundDevice,
  signature,
  timestamp,
  message,
  now = Date.now(),
}) {
  const deviceBound = isActiveKey(deviceSigningKey);

  if (!deviceBound) {
    // Another device of this account is bound: this one must be bound too —
    // which needs the password. A stolen token on a foreign phone stops here.
    if (userHasBoundDevice) {
      return { ok: false, status: 428, code: "SCA_DEVICE_NOT_BOUND" };
    }

    // No bound device at all (phone without biometrics, not yet enrolled).
    return { ok: true, code: "SCA_NONE", level: "none" };
  }

  if (!signature || !timestamp) {
    return { ok: false, status: 428, code: "SCA_REQUIRED" };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) {
    return { ok: false, status: 401, code: "SCA_EXPIRED" };
  }

  if (!verifySignature({ signingKey: deviceSigningKey, message, signature })) {
    return { ok: false, status: 401, code: "SCA_INVALID" };
  }

  return { ok: true, code: "SCA_OK", level: "device_signature" };
}

module.exports = {
  SIGNATURE_VERSION,
  MAX_SKEW_MS,
  stableStringify,
  bodyDigest,
  buildSignedMessage,
  verifySignature,
  decideSignature,
  isActiveKey,
};
