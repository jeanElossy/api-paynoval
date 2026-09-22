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
    .map((b) => {
      /*
       * ⚠️ DEUX DEVISES DISTINCTES, À NE PAS CONFONDRE.
       *
       *   `bonusCurrency`  — celle dans laquelle le MONTANT est exprimé,
       *                      c'est-à-dire celle du barème appliqué à cette
       *                      partie. C'est elle qui commande l'arrondi.
       *   `payoutCurrency` — celle du PORTEFEUILLE du bénéficiaire, dans
       *                      laquelle le montant sera converti puis crédité.
       *
       * `bonusCurrency` est nouvelle (2026-09-22). Auparavant, une seule
       * devise d'entrée valait pour tous les bénéficiaires — ce qui était
       * exact tant que les deux parts suivaient le même barème. Depuis que
       * chacune suit le pays de sa partie, les deux montants ne sont plus dans
       * la même unité : les traiter comme tels aurait converti 5,00 CAD comme
       * s'il s'agissait de 5 XOF. Le repli sur la devise d'entrée conserve le
       * comportement exact des appelants qui ne l'envoient pas encore.
       */
      const bonusCurrency = normalizeCurrency(b?.bonusCurrency || bonusInputCurrency);

      return {
        userId: String(b?.userId || "").trim(),
        role: String(b?.role || "")
          .trim()
          .toLowerCase(),
        amount: roundForCurrency(b?.amount, bonusCurrency),
        bonusCurrency,
        payoutCurrency: normalizeCurrency(b?.payoutCurrency || bonusCurrency),
        label: String(b?.label || "").trim(),
      };
    })
    .filter((b) => b.userId && b.amount > 0 && b.role);
}

/** Rôles admis dans un versement de parrainage. */
const BENEFICIARY_ROLES = Object.freeze(["sponsor", "referee"]);

/**
 * Vérifie la FORME d'une liste de bénéficiaires déjà normalisée.
 *
 * Une récompense de parrainage paie au plus UN parrain et UN filleul, deux
 * personnes distinctes, et jamais la trésorerie qui finance. Tout le reste est
 * une demande incohérente : on la refuse avant qu'un centime ne bouge, plutôt
 * que de verser « ce qui ressemble » à un bonus.
 *
 * @returns {{ ok: true } | { ok: false, code: string, detail: string }}
 */
function validateBeneficiaryRoles(beneficiaries, { treasuryUserId = "" } = {}) {
  const list = Array.isArray(beneficiaries) ? beneficiaries : [];
  const seenRoles = new Set();
  const seenUsers = new Set();

  for (const b of list) {
    if (!BENEFICIARY_ROLES.includes(b.role)) {
      return { ok: false, code: "INVALID_BENEFICIARY_ROLE", detail: `rôle « ${b.role} » inconnu` };
    }
    if (seenRoles.has(b.role)) {
      return { ok: false, code: "DUPLICATE_BENEFICIARY_ROLE", detail: `rôle « ${b.role} » répété` };
    }
    if (seenUsers.has(b.userId)) {
      return {
        ok: false,
        code: "SELF_REFERRAL_PAYOUT",
        detail: "le parrain et le filleul sont la même personne",
      };
    }
    if (treasuryUserId && String(b.userId) === String(treasuryUserId)) {
      return {
        ok: false,
        code: "TREASURY_AS_BENEFICIARY",
        detail: "la trésorerie ne peut pas se verser un bonus",
      };
    }
    seenRoles.add(b.role);
    seenUsers.add(b.userId);
  }

  return { ok: true };
}

/**
 * Qualifie un refus d'index unique (E11000) survenu pendant un versement.
 *
 * ⚠️ Avant le 2026-09-17, TOUT E11000 sans registre `succeeded` était déclaré
 * « déjà payé (antérieur au registre) » avec `ok: true`. Or la transaction
 * Mongo venait d'être ANNULÉE : aucun argent n'avait bougé, et le principal
 * marquait pourtant la récompense `granted`. Un doublon sur la création d'un
 * portefeuille suffisait à faire disparaître un bonus dû, en silence.
 *
 * On ne conclut plus « payé » que sur PREUVE :
 *   - replay                   : le registre porte ces clés en `succeeded` ;
 *   - referee_already_rewarded : ce filleul a déjà été payé sur une AUTRE
 *                                récompense (index « un bonus à vie ») ;
 *   - legacy_paid              : chaque bénéficiaire a sa transaction de bonus
 *                                confirmée, antérieure au registre ;
 *   - unexplained              : rien de tout cela → échec REJOUABLE, bruyant.
 *
 * @param {object} facts
 * @param {number} facts.settledCount            versements `succeeded` pour ces clés
 * @param {boolean} facts.refereePaidElsewhere   filleul payé sous un autre rewardId
 * @param {number} facts.legacyTransactionCount  transactions de bonus retrouvées
 * @param {number} facts.beneficiaryCount        bénéficiaires de la demande
 */
function classifyPayoutDuplicate({
  settledCount = 0,
  refereePaidElsewhere = false,
  legacyTransactionCount = 0,
  beneficiaryCount = 0,
} = {}) {
  if (settledCount > 0) return "replay";
  if (refereePaidElsewhere) return "referee_already_rewarded";
  if (beneficiaryCount > 0 && legacyTransactionCount >= beneficiaryCount) {
    return "legacy_paid";
  }
  return "unexplained";
}

/**
 * Codes d'échec DÉFINITIFS : les rejouer ne changera rien, seule une
 * intervention humaine le peut. Tout autre échec est rejouable.
 */
const PERMANENT_TRANSFER_FAILURES = Object.freeze([
  "INVALID_BENEFICIARY_ROLE",
  "DUPLICATE_BENEFICIARY_ROLE",
  "SELF_REFERRAL_PAYOUT",
  "TREASURY_AS_BENEFICIARY",
  "INVALID_REFERRAL_TREASURY_TYPE",
  "REFERRAL_TREASURY_MUST_BE_CAD",
  "REFEREE_ALREADY_REWARDED",
  "REFERRAL_LEGS_INVALID",
  "REFERRAL_LEGS_INCONSISTENT",
]);

function isPermanentTransferFailure(code) {
  return PERMANENT_TRANSFER_FAILURES.includes(String(code || ""));
}

/** Clé de reprise d'un versement : une seule reprise possible par versement. */
function buildClawbackIdempotencyKey(rewardId, beneficiaryId) {
  return `REFERRAL_CLAWBACK:${String(rewardId)}:${String(beneficiaryId)}`;
}

module.exports = {
  classifyPayoutDuplicate,
  PERMANENT_TRANSFER_FAILURES,
  isPermanentTransferFailure,
  BENEFICIARY_ROLES,
  validateBeneficiaryRoles,
  buildClawbackIdempotencyKey,
  buildPayoutIdempotencyKey,
  computeRequestFingerprint,
  computeBackoffMs,
  maxBackoffMs,
  normalizeBeneficiaries,
  roundForCurrency,
  normalizeCurrency,
  safeNumber,
};
