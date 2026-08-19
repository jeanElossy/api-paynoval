"use strict";

/**
 * Ces tests protègent une faille réelle, corrigée le 2026-08-19 : sans secret
 * configuré, `verifyHmacWebhook` renvoyait `verified: true`. Une requête forgée
 * par n'importe qui était donc traitée comme un webhook authentique de
 * prestataire de paiement — un oubli de variable d'environnement suffisait.
 *
 * Ils échoueront si la faute est réintroduite.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  verifyHmacWebhook,
} = require("../src/services/transactions/shared/webhookSecurity");

const SECRET = "whsec_test_secret";

function makeReq(rawBody, headers = {}) {
  return { headers, rawBody, body: {} };
}

function sign(payload, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

test("sans secret configuré, le webhook est REFUSÉ", () => {
  const previous = process.env.WEBHOOK_ALLOW_UNSIGNED;
  delete process.env.WEBHOOK_ALLOW_UNSIGNED;

  const result = verifyHmacWebhook({
    req: makeReq("{}", { "x-signature": "peu importe" }),
    secret: "",
    signatureHeaders: ["x-signature"],
  });

  assert.equal(result.verified, false);
  assert.equal(result.reason, "NO_SECRET_CONFIGURED");

  if (previous !== undefined) process.env.WEBHOOK_ALLOW_UNSIGNED = previous;
});

test("l'échappatoire de développement ne s'applique jamais en production", () => {
  const prevAllow = process.env.WEBHOOK_ALLOW_UNSIGNED;
  const prevEnv = process.env.NODE_ENV;

  process.env.WEBHOOK_ALLOW_UNSIGNED = "true";
  process.env.NODE_ENV = "production";

  const result = verifyHmacWebhook({
    req: makeReq("{}"),
    secret: "",
    signatureHeaders: ["x-signature"],
  });

  assert.equal(result.verified, false, "production doit refuser malgré le drapeau");

  process.env.NODE_ENV = "development";
  const dev = verifyHmacWebhook({
    req: makeReq("{}"),
    secret: "",
    signatureHeaders: ["x-signature"],
  });

  assert.equal(dev.verified, true, "hors production, le drapeau explicite autorise");
  assert.equal(dev.reason, "UNSIGNED_ALLOWED_DEV_ONLY");

  if (prevAllow === undefined) delete process.env.WEBHOOK_ALLOW_UNSIGNED;
  else process.env.WEBHOOK_ALLOW_UNSIGNED = prevAllow;
  if (prevEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevEnv;
});

test("signature absente => refus", () => {
  const result = verifyHmacWebhook({
    req: makeReq("{}"),
    secret: SECRET,
    signatureHeaders: ["x-signature"],
  });

  assert.equal(result.verified, false);
  assert.equal(result.reason, "MISSING_SIGNATURE");
});

test("signature erronée => refus", () => {
  const body = '{"id":"evt_1"}';

  const result = verifyHmacWebhook({
    req: makeReq(body, { "x-signature": sign(body, "mauvais_secret") }),
    secret: SECRET,
    signatureHeaders: ["x-signature"],
  });

  assert.equal(result.verified, false);
});

test("signature correcte => accepté", () => {
  const body = '{"id":"evt_1"}';

  const result = verifyHmacWebhook({
    req: makeReq(body, { "x-signature": sign(body) }),
    secret: SECRET,
    signatureHeaders: ["x-signature"],
  });

  assert.equal(result.verified, true);
});

test("un corps modifié invalide la signature", () => {
  const body = '{"amount":100}';
  const signature = sign(body);

  const result = verifyHmacWebhook({
    req: makeReq('{"amount":100000}', { "x-signature": signature }),
    secret: SECRET,
    signatureHeaders: ["x-signature"],
  });

  assert.equal(result.verified, false);
});

test("horodatage périmé => refus (anti-rejeu)", () => {
  const stale = String(Math.floor(Date.now() / 1000) - 3600);
  const body = "{}";
  const payload = `${stale}.${body}`;

  const result = verifyHmacWebhook({
    req: makeReq(body, { "x-signature": sign(payload), "x-timestamp": stale }),
    secret: SECRET,
    signatureHeaders: ["x-signature"],
    timestampHeaders: ["x-timestamp"],
    toleranceSeconds: 300,
  });

  assert.equal(result.verified, false);
  assert.equal(result.reason, "STALE_TIMESTAMP");
});
