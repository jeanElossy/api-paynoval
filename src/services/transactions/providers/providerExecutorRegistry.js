"use strict";

/**
 * Registry des executors provider TX Core.
 *
 * Rôle :
 * - Résoudre quel executor utiliser selon le flow.
 * - Normaliser le provider choisi.
 * - Ne jamais résoudre un vrai executor pour un flow/provider sandbox.
 *
 * Important :
 * - La sécurité principale sandbox est dans initiateByFlow.
 * - La sécurité secondaire est dans submitExternalExecution.
 * - Ce fichier ne doit pas appeler de provider directement.
 */

const {
  executeMobileMoneyPayout,
  startMobileMoneyCollection,
} = require("./mobilemoneyExecutor");

const {
  executeCardPayout,
  startCardTopup,
} = require("./cardExecutor");

const FLOWS = Object.freeze({
  PAYNOVAL_TO_MOBILEMONEY_PAYOUT: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  MOBILEMONEY_COLLECTION_TO_PAYNOVAL: "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",


  PAYNOVAL_TO_CARD_PAYOUT: "PAYNOVAL_TO_CARD_PAYOUT",
  CARD_TOPUP_TO_PAYNOVAL: "CARD_TOPUP_TO_PAYNOVAL",
});

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeFlow(flow) {
  return String(flow || "").trim().toUpperCase();
}

function normalizeProvider(provider) {
  const p = norm(provider).replace(/\s+/g, "_").replace(/-/g, "_");

  if (!p) return "";

  if (["mobile_money", "momo", "mobilemoneyaccount"].includes(p)) {
    return "mobilemoney";
  }

  if (["orange_money", "orangemoney", "orange_money_ci"].includes(p)) {
    return "orange";
  }

  if (["mtn_money", "mtn_momo"].includes(p)) {
    return "mtn";
  }

  if (["moov_money", "flooz"].includes(p)) {
    return "moov";
  }

  if (["visa", "visa_direct", "visadirect"].includes(p)) {
    return "visa_direct";
  }

  /* « stripe_card » retiré le 2026-09-09 avec le rail Stripe. */
  if (["card", "visa", "visadirect", "visa_direct"].includes(p)) {
    return "card";
  }

  return p;
}

function isSandboxProvider(provider) {
  const p = normalizeProvider(provider);

  return (
    p === "sandbox" ||
    p === "apple_review" ||
    p === "apple_review_sandbox"
  );
}

function isSandboxFlow(flow) {
  const f = normalizeFlow(flow);

  return (
    f === "SANDBOX" ||
    f === "SANDBOX_APPLE_REVIEW" ||
    f.startsWith("SANDBOX_")
  );
}

/**
 * Placeholder conservé pour compatibilité.
 * Si certains anciens fichiers appellent cette fonction, elle existe toujours.
 */
function getServiceUrlByProvider() {
  return "";
}

function resolveMobileMoneyExecutor(flow, provider) {
  if (
    flow !== FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT &&
    flow !== FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL
  ) {
    return null;
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * AUCUN REPLI D'OPÉRATEUR — RÈGLE B.2
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Cette ligne valait `normalizeProvider(provider) || "wave"`.
   *
   * Une transaction dont l'opérateur n'était pas résolu partait donc **chez
   * Wave**, sans journal, sans erreur, sans que rien ne distingue ce choix
   * d'un choix délibéré de l'utilisateur. L'argent d'un client destiné à
   * Orange Money pouvait être poussé vers un autre opérateur — et le seul
   * symptôme aurait été un échec côté Wave, attribué au réseau.
   *
   * Choisir un opérateur par défaut sur le chemin de l'argent n'est pas de la
   * robustesse : c'est décider à la place du client, en silence. On lève.
   */
  const resolvedProvider = normalizeProvider(provider);

  if (!resolvedProvider) {
    const err = new Error(
      "Opérateur mobile money non résolu — aucun repli n'est appliqué sur le " +
        "chemin de l'argent (règle B.2). Poser explicitement l'opérateur."
    );
    err.status = 422;
    err.code = "OPERATEUR_NON_RESOLU";
    throw err;
  }

  return {
    execute:
      flow === FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT
        ? executeMobileMoneyPayout
        : startMobileMoneyCollection,
    rail: "mobilemoney",
    provider: resolvedProvider,
  };
}

/**
 * ⚠️ IL N'Y A PLUS DE `resolveBankExecutor`. Rail retiré le 2026-08-26 (§1).
 *
 * Les flux `PAYNOVAL_TO_BANK_PAYOUT` et `BANK_TRANSFER_TO_PAYNOVAL` ne
 * trouvent donc PLUS d'exécuteur : `resolveExecutor` rend `null`, et l'appelant
 * traite ce `null` comme « aucun rail ne sert ce flux » — un refus, pas une
 * exécution silencieuse par un autre rail.
 *
 * C'est le comportement voulu : mieux vaut une transaction refusée qu'une
 * transaction exécutée par un chemin que personne n'a choisi.
 */

function resolveCardExecutor(flow, provider) {
  if (
    flow !== FLOWS.PAYNOVAL_TO_CARD_PAYOUT &&
    flow !== FLOWS.CARD_TOPUP_TO_PAYNOVAL
  ) {
    return null;
  }

  const normalizedProvider = normalizeProvider(provider);

  /**
   * Le dépôt par carte retombait sur « stripe ». Stripe retiré du périmètre le 2026-09-08 : le rail carte, dans les DEUX
   sens, est servi par Visa Direct — et demain par le partenaire
   multi-réseaux. Un défaut pointant vers un prestataire supprimé faisait
   lever `getProviderAdapter`, donc échouait le dépôt par carte.
   *
   * Les deux sens partagent désormais le même défaut : il n'y a plus qu'un
   * prestataire carte, et le distinguer par flux n'avait plus d'objet.
   */
  const fallbackProvider = "visa_direct";

  return {
    execute:
      flow === FLOWS.PAYNOVAL_TO_CARD_PAYOUT
        ? executeCardPayout
        : startCardTopup,
    rail: "card",
    provider: normalizedProvider || fallbackProvider,
  };
}

function resolveExecutor({ flow, provider } = {}) {
  const f = normalizeFlow(flow);
  const p = normalizeProvider(provider);

  /**
   * Sécurité :
   * Un flow/provider sandbox ne doit jamais être résolu vers un vrai executor.
   * Si une tx sandbox arrive ici, submitExternalExecution va la traiter sans provider.
   */
  if (isSandboxFlow(f) || isSandboxProvider(p)) {
    return null;
  }

  return (
    resolveMobileMoneyExecutor(f, p) ||
    resolveCardExecutor(f, p) ||
    null
  );
}

module.exports = {
  FLOWS,
  getServiceUrlByProvider,
  normalizeProvider,
  normalizeFlow,
  isSandboxProvider,
  isSandboxFlow,
  resolveExecutor,
};