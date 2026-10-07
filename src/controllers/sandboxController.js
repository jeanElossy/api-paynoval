"use strict";

/**
 * Contrôleur des outils de simulation — MINCE : il lit la requête, appelle le
 * service, écrit la réponse. Aucune règle métier ici (`services/sandbox/`).
 */

const asyncHandler = require("express-async-handler");

const tools = require("../services/sandbox/sandboxToolsService");
const threeDS = require("../services/sandbox/sandboxThreeDSService");
const { ACCOUNT_MODES } = require("../utils/accountMode");

function idempotencyKeyOf(req) {
  const raw = req.get("Idempotency-Key") || req.body?.idempotencyKey || "";
  const key = String(raw).trim();
  return key && key.length <= 128 ? key : undefined;
}

/**
 * Les outils n'existent que pour un compte sandbox. Pour tout autre compte :
 * 404, pas 403 — un compte réel n'apprend pas qu'ils existent.
 */
function requireSandboxAccount(req, res, next) {
  if (req.user?.mode !== ACCOUNT_MODES.SANDBOX) {
    return res.status(404).json({ success: false, message: "Ressource introuvable." });
  }
  return next();
}

const getState = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await tools.getState(req.user) });
});

const updateScenario = asyncHandler(async (req, res) => {
  const scenario = await tools.updateScenario(req.user, {
    outcome: req.body?.outcome,
    confirmationDelaySeconds: req.body?.confirmationDelaySeconds,
  });
  res.json({ success: true, data: { scenario } });
});

const faucet = asyncHandler(async (req, res) => {
  const out = await tools.faucet(req.user, {
    amount: req.body?.amount,
    idempotencyKey: idempotencyKeyOf(req),
  });
  res.status(out.replayed ? 200 : 201).json({ success: true, data: out });
});

const drain = asyncHandler(async (req, res) => {
  const out = await tools.drain(req.user, { idempotencyKey: idempotencyKeyOf(req) });
  res.json({ success: true, data: out });
});

const reset = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await tools.reset(req.user) });
});

const getThreeDSChallenge = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ success: true, data: await threeDS.getChallenge(req.params.token) });
});

const submitThreeDSDecision = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const decision = String(req.body?.decision || "").trim().toLowerCase();
  res.json({ success: true, data: await threeDS.submitDecision(req.params.token, decision) });
});

const provisionAccount = asyncHandler(async (req, res) => {
  const out = await tools.provisionAccount({
    userId: req.params.userId,
    currency: req.body?.currency,
    initialBalance: req.body?.initialBalance,
  });
  res.status(201).json({ success: true, data: out });
});

const provisionTreasuries = asyncHandler(async (req, res) => {
  const out = await tools.provisionTreasuries(
    Array.isArray(req.body?.treasuries) ? req.body.treasuries : []
  );
  res.status(201).json({ success: true, data: out });
});

module.exports = {
  requireSandboxAccount,
  getState,
  updateScenario,
  faucet,
  drain,
  reset,
  getThreeDSChallenge,
  submitThreeDSDecision,
  provisionAccount,
  provisionTreasuries,
};
