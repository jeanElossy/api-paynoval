// "use strict";

// /**
//  * Registry des executors provider TX Core.
//  * Résout quel executor utiliser selon le flow.
//  * Les executors choisissent ensuite le bon adapter provider.
//  */

// const {
//   executeMobileMoneyPayout,
//   startMobileMoneyCollection,
// } = require("./mobilemoneyExecutor");

// const {
//   executeBankPayout,
//   startBankCollection,
// } = require("./bankExecutor");

// const {
//   executeCardPayout,
//   startCardTopup,
// } = require("./cardExecutor");

// function norm(v) {
//   return String(v || "").trim().toLowerCase();
// }

// function getServiceUrlByProvider() {
//   return "";
// }

// function resolveExecutor({ flow, provider }) {
//   const p = norm(provider);
//   const f = String(flow || "").trim();

//   if (
//     f === "PAYNOVAL_TO_MOBILEMONEY_PAYOUT" ||
//     f === "MOBILEMONEY_COLLECTION_TO_PAYNOVAL"
//   ) {
//     return {
//       execute:
//         f === "PAYNOVAL_TO_MOBILEMONEY_PAYOUT"
//           ? executeMobileMoneyPayout
//           : startMobileMoneyCollection,
//       rail: "mobilemoney",
//       provider: p || "wave",
//     };
//   }

//   if (
//     f === "PAYNOVAL_TO_BANK_PAYOUT" ||
//     f === "BANK_TRANSFER_TO_PAYNOVAL"
//   ) {
//     return {
//       execute:
//         f === "PAYNOVAL_TO_BANK_PAYOUT"
//           ? executeBankPayout
//           : startBankCollection,
//       rail: "bank",
//       provider: p || "bank_generic",
//     };
//   }

//   if (
//     f === "PAYNOVAL_TO_CARD_PAYOUT" ||
//     f === "CARD_TOPUP_TO_PAYNOVAL"
//   ) {
//     return {
//       execute:
//         f === "PAYNOVAL_TO_CARD_PAYOUT"
//           ? executeCardPayout
//           : startCardTopup,
//       rail: "card",
//       provider: p || (f === "CARD_TOPUP_TO_PAYNOVAL" ? "stripe" : "visa_direct"),
//     };
//   }

//   return null;
// }

// module.exports = {
//   getServiceUrlByProvider,
//   resolveExecutor,
// };







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
  executeBankPayout,
  startBankCollection,
} = require("./bankExecutor");

const {
  executeCardPayout,
  startCardTopup,
} = require("./cardExecutor");

const FLOWS = Object.freeze({
  PAYNOVAL_TO_MOBILEMONEY_PAYOUT: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  MOBILEMONEY_COLLECTION_TO_PAYNOVAL: "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",

  PAYNOVAL_TO_BANK_PAYOUT: "PAYNOVAL_TO_BANK_PAYOUT",
  BANK_TRANSFER_TO_PAYNOVAL: "BANK_TRANSFER_TO_PAYNOVAL",

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

  if (["banque", "bank_account", "bank_transfer"].includes(p)) {
    return "bank";
  }

  if (["visa", "visa_direct", "visadirect"].includes(p)) {
    return "visa_direct";
  }

  if (["card", "stripe_card"].includes(p)) {
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

  const resolvedProvider = normalizeProvider(provider) || "wave";

  return {
    execute:
      flow === FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT
        ? executeMobileMoneyPayout
        : startMobileMoneyCollection,
    rail: "mobilemoney",
    provider: resolvedProvider,
  };
}

function resolveBankExecutor(flow, provider) {
  if (
    flow !== FLOWS.PAYNOVAL_TO_BANK_PAYOUT &&
    flow !== FLOWS.BANK_TRANSFER_TO_PAYNOVAL
  ) {
    return null;
  }

  const resolvedProvider = normalizeProvider(provider) || "bank_generic";

  return {
    execute:
      flow === FLOWS.PAYNOVAL_TO_BANK_PAYOUT
        ? executeBankPayout
        : startBankCollection,
    rail: "bank",
    provider: resolvedProvider,
  };
}

function resolveCardExecutor(flow, provider) {
  if (
    flow !== FLOWS.PAYNOVAL_TO_CARD_PAYOUT &&
    flow !== FLOWS.CARD_TOPUP_TO_PAYNOVAL
  ) {
    return null;
  }

  const normalizedProvider = normalizeProvider(provider);

  const fallbackProvider =
    flow === FLOWS.CARD_TOPUP_TO_PAYNOVAL ? "stripe" : "visa_direct";

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
    resolveBankExecutor(f, p) ||
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