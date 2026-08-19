"use strict";

/**
 * ============================================================================
 * RÉCONCILIATION DES VERSEMENTS DE PARRAINAGE (§20)
 * ============================================================================
 *
 * Troisième et dernier filet, après l'idempotence et l'outbox. Il ne prévient
 * rien : il CONSTATE. Sa valeur est là — un système financier a besoin d'un
 * observateur qui ne partage aucune hypothèse avec les mécanismes qu'il observe.
 *
 * LA CHAÎNE VÉRIFIÉE
 * ------------------
 *     versement enregistré
 *          ⟺ transaction visible par l'utilisateur
 *          ⟺ deux écritures au grand livre (débit trésorerie / crédit wallet)
 *
 * Chaque maillon manquant est une anomalie nommée, pas un simple compteur : le
 * but est qu'un humain puisse agir, et pour cela il doit savoir QUOI est cassé.
 *
 * ⚠️ RÈGLE ABSOLUE : CE MODULE NE CRÉDITE JAMAIS, NE CORRIGE JAMAIS.
 * Une réconciliation qui répare automatiquement est une seconde source de
 * paiement — donc un second risque de double crédit, et le plus pernicieux qui
 * soit puisqu'il se déclenche précisément quand l'état est déjà douteux. Elle
 * signale ; la décision de corriger appartient à un humain, qui passera par le
 * chemin normal, lequel est idempotent.
 */

let logger = console;
try {
  logger = require("../../logger");
} catch {}

const { getTxConn } = require("../../config/db");

const ReferralPayoutModel = require("../../models/ReferralPayout");
const TransactionModel = require("../../models/Transaction");
const LedgerEntryModel = require("../../models/LedgerEntry");

/** Anomalies possibles. Nommées pour être actionnables. */
const ANOMALIES = Object.freeze({
  MISSING_TRANSACTION: "MISSING_TRANSACTION",
  MISSING_LEDGER_CREDIT: "MISSING_LEDGER_CREDIT",
  MISSING_LEDGER_DEBIT: "MISSING_LEDGER_DEBIT",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  STUCK_PROCESSING: "STUCK_PROCESSING",
  ORPHAN_TRANSACTION: "ORPHAN_TRANSACTION",
});

/**
 * Au-delà de ce délai, un versement resté `processing` est anormal : la
 * transaction Mongo qui l'a créé aurait dû le clore ou disparaître avec elle.
 */
const STUCK_PROCESSING_MS = Number(
  process.env.REFERRAL_STUCK_PROCESSING_MS || 30 * 60 * 1000
);

function decimalToNumber(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(value?.toString?.() ?? value);
  return Number.isFinite(n) ? n : 0;
}

/** Tolérance de comparaison : l'arrondi d'une devise à deux décimales. */
function amountsDiffer(a, b) {
  return Math.abs(decimalToNumber(a) - decimalToNumber(b)) > 0.005;
}

/**
 * Vérifie la cohérence des versements sur une fenêtre récente.
 *
 * @param {object} [options]
 * @param {number} [options.sinceHours] profondeur d'examen, en heures
 * @param {number} [options.limit]      plafond de documents examinés
 * @returns {Promise<{checked:number, anomalies:Array, healthy:boolean}>}
 */
async function reconcileReferralPayouts({ sinceHours = 48, limit = 1000 } = {}) {
  const conn = getTxConn();

  const ReferralPayout = ReferralPayoutModel(conn);
  const Transaction = TransactionModel(conn);
  const LedgerEntry = LedgerEntryModel(conn);

  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const anomalies = [];

  /* --- 1. Versements bloqués en cours de traitement ---------------------- */

  const stuck = await ReferralPayout.find({
    status: "processing",
    createdAt: { $lte: new Date(Date.now() - STUCK_PROCESSING_MS) },
  })
    .limit(limit)
    .lean();

  for (const payout of stuck) {
    anomalies.push({
      type: ANOMALIES.STUCK_PROCESSING,
      idempotencyKey: payout.idempotencyKey,
      rewardId: payout.rewardId,
      beneficiaryId: payout.beneficiaryId,
      correlationId: payout.correlationId,
      since: payout.createdAt,
    });
  }

  /* --- 2. Versements réussis : la chaîne est-elle complète ? -------------- */

  const payouts = await ReferralPayout.find({
    status: "succeeded",
    completedAt: { $gte: since },
  })
    .limit(limit)
    .lean();

  for (const payout of payouts) {
    const reference = String(payout.transactionReference || "");

    if (!reference) {
      anomalies.push({
        type: ANOMALIES.MISSING_TRANSACTION,
        idempotencyKey: payout.idempotencyKey,
        rewardId: payout.rewardId,
        beneficiaryId: payout.beneficiaryId,
        correlationId: payout.correlationId,
        detail: "aucune référence de transaction enregistrée",
      });
      continue;
    }

    const tx = await Transaction.findOne({ reference })
      .select("_id amount currency status userId")
      .lean();

    if (!tx) {
      anomalies.push({
        type: ANOMALIES.MISSING_TRANSACTION,
        idempotencyKey: payout.idempotencyKey,
        rewardId: payout.rewardId,
        beneficiaryId: payout.beneficiaryId,
        correlationId: payout.correlationId,
        reference,
      });
      continue;
    }

    if (amountsDiffer(tx.amount, payout.creditedAmount)) {
      anomalies.push({
        type: ANOMALIES.AMOUNT_MISMATCH,
        idempotencyKey: payout.idempotencyKey,
        rewardId: payout.rewardId,
        beneficiaryId: payout.beneficiaryId,
        correlationId: payout.correlationId,
        reference,
        payoutAmount: payout.creditedAmount,
        transactionAmount: decimalToNumber(tx.amount),
      });
    }

    const walletAccountId = `user_wallet:${String(payout.beneficiaryId)}:${
      payout.creditedCurrency
    }`;
    const treasuryAccountId = `treasury:${payout.treasurySystemType}:${String(
      payout.treasuryUserId
    )}:${payout.treasuryCurrency}`;

    const entries = await LedgerEntry.find({
      reference,
      accountId: { $in: [walletAccountId, treasuryAccountId] },
    })
      .select("accountId direction amount")
      .lean();

    const accounts = new Set(entries.map((e) => e.accountId));

    if (!accounts.has(walletAccountId)) {
      anomalies.push({
        type: ANOMALIES.MISSING_LEDGER_CREDIT,
        idempotencyKey: payout.idempotencyKey,
        rewardId: payout.rewardId,
        beneficiaryId: payout.beneficiaryId,
        correlationId: payout.correlationId,
        reference,
        accountId: walletAccountId,
      });
    }

    if (
      !accounts.has(treasuryAccountId) &&
      decimalToNumber(payout.treasuryDebitedAmount) > 0
    ) {
      anomalies.push({
        type: ANOMALIES.MISSING_LEDGER_DEBIT,
        idempotencyKey: payout.idempotencyKey,
        rewardId: payout.rewardId,
        correlationId: payout.correlationId,
        reference,
        accountId: treasuryAccountId,
      });
    }
  }

  /* --- 3. Transactions de bonus sans versement enregistré ----------------
   * Deux causes possibles, toutes deux méritant l'œil d'un humain :
   *   - une récompense versée AVANT l'introduction du registre (attendu, et
   *     sans danger : l'index unique de `Transaction` protège toujours) ;
   *   - un crédit produit par un chemin qui contourne le registre (anormal).
   */

  const orphanCandidates = await Transaction.find({
    type: "referral_bonus",
    status: "confirmed",
    confirmedAt: { $gte: since },
  })
    .select("reference userId amount currency confirmedAt")
    .limit(limit)
    .lean();

  for (const tx of orphanCandidates) {
    const exists = await ReferralPayout.exists({
      transactionReference: String(tx.reference || ""),
    });

    if (!exists) {
      anomalies.push({
        type: ANOMALIES.ORPHAN_TRANSACTION,
        reference: String(tx.reference || ""),
        beneficiaryId: String(tx.userId || ""),
        amount: decimalToNumber(tx.amount),
        currency: tx.currency,
        confirmedAt: tx.confirmedAt,
        detail:
          "transaction de bonus sans versement au registre — antérieure au registre, ou chemin de crédit non conforme",
      });
    }
  }

  const checked = stuck.length + payouts.length + orphanCandidates.length;
  const healthy = anomalies.length === 0;

  if (!healthy) {
    /**
     * Niveau `error` délibérément : une incohérence sur un flux financier n'est
     * pas un avertissement. Elle doit remonter aux alertes.
     */
    logger.error?.("[REFERRAL][RECONCILE] incoherences detectees", {
      checked,
      anomalies: anomalies.length,
      byType: anomalies.reduce((acc, a) => {
        acc[a.type] = (acc[a.type] || 0) + 1;
        return acc;
      }, {}),
    });
  } else {
    logger.info?.("[REFERRAL][RECONCILE] chaine coherente", { checked });
  }

  return { checked, anomalies, healthy, window: { since, sinceHours } };
}

module.exports = {
  reconcileReferralPayouts,
  ANOMALIES,
  STUCK_PROCESSING_MS,
};
