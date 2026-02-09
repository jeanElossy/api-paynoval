// File: services/referralService.js
"use strict";

/**
 * Referral Service (TX Core)
 * - Hook à appeler après confirm (si tx confirmed)
 * - Retourne referralSnapshot (idempotent)
 *
 * ⚠️ Ici c’est un squelette “safe” (no-op par défaut)
 * Tu me donneras ton code referral réel et je l’intègre.
 */

async function applyReferralIfEligible({ tx, senderUser, receiverUser }, deps = {}) {
  // Si tu as un système referral existant, branche-le ici.
  // Exemple futur:
  // - detect referral code on sender
  // - check eligible rules
  // - create reward doc
  // - return snapshot

  const code = tx?.metadata?.referralCode || tx?.referralCode || null;
  if (!code) return null;

  // no-op decision: eligible false par défaut
  return {
    code: String(code),
    eligible: false,
    rewardId: null,
    reason: "referral_engine_not_configured",
    ts: new Date().toISOString(),
    version: process.env.REFERRAL_VERSION || "v1",
  };
}

module.exports = {
  applyReferralIfEligible,
};
