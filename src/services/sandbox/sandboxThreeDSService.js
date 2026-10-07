"use strict";

/**
 * ============================================================================
 * 3-D SECURE DE TEST — LA PAGE D'AUTHENTIFICATION DU DÉPÔT PAR CARTE
 * ============================================================================
 *
 * L'adapter carte de simulation rend une action `redirect_to_url` ; l'app
 * ouvre la page (servie par la passerelle) dans un navigateur intégré, le
 * titulaire approuve ou refuse, et le navigateur revient à l'application.
 * C'est le parcours du 3DS de test de Stripe (« Complete / Fail
 * authentication ») — le seul moyen de filmer l'étape que verra un vrai client.
 *
 * Ce service ne rend que des DONNÉES (résumé du paiement, décision) ; la page
 * HTML est l'affaire de la passerelle, qui est la seule à parler au
 * navigateur. Le jeton n'est jamais stocké en clair.
 */

const runtime = require("../transactions/shared/runtime");
const events = require("./sandboxProviderEvents");

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.code = code;
  return err;
}

function amountOf(tx) {
  const raw =
    tx?.money?.source?.amount ??
    tx?.amountSource ??
    tx?.amount ??
    null;

  const n = Number(raw && typeof raw === "object" && raw.toString ? raw.toString() : raw);
  return Number.isFinite(n) ? n : null;
}

/** Résumé affiché sur la page. Rien de personnel : montant, devise, marchand. */
async function getChallenge(token) {
  const event = await events.findThreeDSByToken(token);

  if (!event) {
    throw httpError(404, "THREE_DS_NOT_FOUND", "Authentification expirée ou déjà traitée.");
  }

  const tx = await runtime.Transaction.findById(event.transactionId)
    .select("mode amount amountSource money currencySource currency reference")
    .lean();

  if (!tx || tx.mode !== "sandbox") {
    throw httpError(404, "THREE_DS_NOT_FOUND", "Authentification expirée ou déjà traitée.");
  }

  return {
    merchant: "PayNoval",
    amount: amountOf(tx),
    currency: tx?.money?.source?.currency || tx.currencySource || tx.currency || null,
    reference: tx.reference || null,
    expiresAt: event.threeDS?.expiresAt || null,
    sandbox: true,
  };
}

async function submitDecision(token, decision) {
  const decided = await events.decideThreeDS(token, decision);

  if (!decided) {
    throw httpError(410, "THREE_DS_GONE", "Authentification expirée ou déjà traitée.");
  }

  return { decision };
}

module.exports = { getChallenge, submitDecision };
