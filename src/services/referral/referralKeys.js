"use strict";

/**
 * Primitives d'idempotence du parrainage — MODULE PUR.
 *
 * Aucune dépendance à la configuration, à la base ou au réseau : c'est
 * délibéré. Ces fonctions définissent la garantie « exactement une fois », donc
 * elles doivent être vérifiables isolément, sans `.env` ni MongoDB. C'est le
 * motif déjà employé dans ce dépôt pour `utils/userScopeQuery.js`, extrait de
 * son contrôleur exactement pour cette raison.
 */

const crypto = require("crypto");

/** Devises sans sous-unité. */
const ZERO_DECIMAL_CURRENCIES = ["XOF", "XAF", "JPY", "KRW"];

function safeNumber(value) {
  const n =
    typeof value === "number"
      ? value
      : parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function normalizeCurrency(value, fallback = "XOF") {
  const code = String(value || fallback)
    .trim()
    .toUpperCase();
  return code || fallback;
}

function roundForCurrency(value, currency) {
  const cur = normalizeCurrency(currency);
  const decimals = ZERO_DECIMAL_CURRENCIES.includes(cur) ? 0 : 2;
  return Number(safeNumber(value).toFixed(decimals));
}

/**
 * Clé métier d'un versement, au format imposé par la spécification :
 *   REFERRAL_BONUS:{rewardId}:{beneficiaryId}
 *
 * DÉTERMINISTE. Deux services, deux processus, deux tentatives séparées de
 * plusieurs jours : la même paire produit toujours la même clé. C'est cette
 * propriété — et l'index unique qui la garde — qui rend le double versement
 * impossible.
 */
function buildPayoutIdempotencyKey(rewardId, beneficiaryId) {
  return `REFERRAL_BONUS:${String(rewardId)}:${String(beneficiaryId)}`;
}

/**
 * Empreinte des paramètres FINANCIERS d'une demande de versement.
 *
 * Ce qu'elle couvre : bénéficiaires, montants, devises, trésorerie.
 * Ce qu'elle ignore VOLONTAIREMENT : `triggerTxId`, `correlationId`, horodatages
 * — ils changent à chaque tentative, et les inclure ferait passer tout rejeu
 * légitime pour une incohérence.
 *
 * L'ordre des bénéficiaires est normalisé avant hachage : deux appels décrivant
 * les mêmes versements dans un ordre différent doivent produire la même
 * empreinte, sans quoi l'alerte se déclencherait sur une différence qui n'en est
 * pas une.
 */
function computeRequestFingerprint({
  rewardId,
  treasuryUserId,
  treasurySystemType,
  treasuryCurrency,
  bonusInputCurrency,
  beneficiaries,
}) {
  const canonical = JSON.stringify({
    rewardId: String(rewardId),
    treasuryUserId: String(treasuryUserId),
    treasurySystemType: String(treasurySystemType),
    treasuryCurrency: normalizeCurrency(treasuryCurrency),
    bonusInputCurrency: normalizeCurrency(bonusInputCurrency),
    beneficiaries: [...(beneficiaries || [])]
      .map((b) => ({
        userId: String(b.userId),
        role: String(b.role),
        amount: roundForCurrency(b.amount, bonusInputCurrency),
        payoutCurrency: normalizeCurrency(b.payoutCurrency),
      }))
      .sort((a, b) => a.userId.localeCompare(b.userId)),
  });

  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Délai avant nouvelle tentative de livraison : exponentiel, plafonné, avec
 * gigue.
 *
 * La gigue évite que N événements mis en échec par la même panne ne repartent
 * tous à la même milliseconde et ne la reproduisent — c'est le « troupeau
 * tonnant » classique des files de reprise.
 *
 * @param {number} attempts  numéro de la tentative qui vient d'échouer (≥ 1)
 */
function computeBackoffMs(attempts, { baseMs = 15_000, maxMs = 3_600_000 } = {}) {
  const exponential = baseMs * Math.pow(2, Math.max(0, attempts - 1));
  const capped = Math.min(exponential, maxMs);
  const jitter = Math.floor(Math.random() * Math.min(capped * 0.2, 30_000));

  return capped + jitter;
}

/** Borne supérieure théorique du délai, utile aux tests et à la supervision. */
function maxBackoffMs({ maxMs = 3_600_000 } = {}) {
  return maxMs + Math.min(maxMs * 0.2, 30_000);
}

/**
 * Normalise et filtre les bénéficiaires d'une demande de versement.
 * Un bénéficiaire sans identifiant, sans rôle, ou à montant nul est écarté :
 * il ne doit produire ni écriture, ni clé d'idempotence.
 */
function normalizeBeneficiaries(rawList, bonusInputCurrency) {
  const list = Array.isArray(rawList) ? rawList : [];

  return list
    .map((b) => ({
      userId: String(b?.userId || "").trim(),
      role: String(b?.role || "")
        .trim()
        .toLowerCase(),
      amount: roundForCurrency(b?.amount, bonusInputCurrency),
      payoutCurrency: normalizeCurrency(b?.payoutCurrency || bonusInputCurrency),
      label: String(b?.label || "").trim(),
    }))
    .filter((b) => b.userId && b.amount > 0 && b.role);
}

module.exports = {
  buildPayoutIdempotencyKey,
  computeRequestFingerprint,
  computeBackoffMs,
  maxBackoffMs,
  normalizeBeneficiaries,
  roundForCurrency,
  normalizeCurrency,
  safeNumber,
};
