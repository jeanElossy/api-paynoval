"use strict";

/**
 * Contrôleur des outils de simulation — MINCE : il lit la requête, appelle le
 * service, écrit la réponse. Aucune règle métier ici (`services/sandbox/`).
 */

const asyncHandler = require("express-async-handler");

const tools = require("../services/sandbox/sandboxToolsService");
const threeDS = require("../services/sandbox/sandboxThreeDSService");
const { ACCOUNT_MODES } = require("../utils/accountMode");
const { mapUserToReqUser } = require("../middleware/authMiddleware");
const { confirmController } = require("../services/transactions/handlers/confirmTransaction");

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
    applyTo: req.body?.applyTo,
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

const listPendingTransfers = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await tools.listPendingTransfers(req.user) });
});

/**
 * Répondre à la place du destinataire : le VRAI contrôleur de confirmation,
 * appelé avec son identité. Il répond lui-même, succès ou refus.
 */
const confirmAsRecipient = asyncHandler(async (req, res, next) => {
  const recipient = await tools.loadRecipientOf(req.user, req.params.id);

  const asRecipient = Object.create(req);
  asRecipient.user = mapUserToReqUser(recipient);
  asRecipient.body = { transactionId: req.params.id, securityAnswer: req.body?.securityAnswer };

  return confirmController(asRecipient, res, next);
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

const adminGetState = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await tools.adminGetState(req.params.userId) });
});

const adminUpdateScenario = asyncHandler(async (req, res) => {
  const scenario = await tools.adminUpdateScenario(req.params.userId, {
    outcome: req.body?.outcome,
    confirmationDelaySeconds: req.body?.confirmationDelaySeconds,
    applyTo: req.body?.applyTo,
  });
  res.json({ success: true, data: { scenario } });
});

const adminReset = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await tools.adminReset(req.params.userId) });
});

const applyDataset = asyncHandler(async (req, res) => {
  const out = await tools.applyDataset(req.params.userId, {
    dataset: req.body?.dataset,
    counterpartyId: req.body?.counterpartyId,
    ownerName: req.body?.ownerName,
    counterpartyName: req.body?.counterpartyName,
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
  listPendingTransfers,
  confirmAsRecipient,
  getThreeDSChallenge,
  submitThreeDSDecision,
  adminGetState,
  adminUpdateScenario,
  adminReset,
  applyDataset,
  provisionAccount,
  provisionTreasuries,
};
