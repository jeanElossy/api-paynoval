"use strict";

/**
 * ============================================================================
 * REPRISE D'UN BONUS DE PARRAINAGE (CLAWBACK)
 * ============================================================================
 *
 * Quand l'activité qui a ouvert droit à un bonus est annulée après coup
 * (transaction qualifiante remboursée), le principal le constate et demande la
 * reprise. Pratique Wise / Revolut : le bonus est repris par contre-écriture.
 *
 * ZERO-TRUST, DANS LE SENS INVERSE
 * --------------------------------
 * Le principal n'envoie qu'un `rewardId`. Tout le reste — qui a été payé,
 * combien, dans quelle devise, combien la trésorerie a déboursé — est relu dans
 * le registre `ReferralPayout`. Un appelant compromis ne peut donc ni débiter
 * un montant de son choix, ni viser un portefeuille qui n'a pas reçu de bonus.
 *
 * TOUT OU RIEN
 * ------------
 * Parrain et filleul sont repris dans la MÊME transaction Mongo. Si l'un des
 * deux n'a plus les fonds, RIEN n'est débité et la reprise est rendue à un
 * humain (`CLAWBACK_INSUFFICIENT_FUNDS`, définitif). On ne pousse jamais un
 * portefeuille en négatif et on ne fait pas de reprise partielle : un état à
 * moitié repris est plus difficile à auditer qu'un état non repris et signalé.
 *
 * MONTANTS EXACTS
 * ---------------
 * Le bénéficiaire rend `creditedAmount` ; la trésorerie récupère
 * `treasuryDebitedAmount`. Aucun taux n'est réappliqué : la trésorerie retrouve
 * exactement ce qu'elle a déboursé, et la position de change est soldée.
 */

let logger = console;
try {
  logger = require("../utils/logger");
} catch {}

const { getTxConn } = require("../config/db");

const TxWalletBalanceModel = require("../models/TxWalletBalance");
const TxSystemBalanceModel = require("../models/TxSystemBalance");
const TransactionModel = require("../models/Transaction");
const ReferralPayoutModel = require("../models/ReferralPayout");
const ReferralClawbackModel = require("../models/ReferralClawback");

const { buildClawbackIdempotencyKey } = require("./referral/referralKeys");

const {
  postReferralLedgerEntries,
  decimalToNumber,
} = require("./internalReferralTransferService");

function models() {
  const conn = getTxConn();
  return {
    TxWalletBalance: TxWalletBalanceModel(conn),
    TxSystemBalance: TxSystemBalanceModel(conn),
    Transaction: TransactionModel(conn),
    ReferralPayout: ReferralPayoutModel(conn),
    ReferralClawback: ReferralClawbackModel(conn),
  };
}

function coded(code, message, details = null) {
  return Object.assign(new Error(message || code), { code, details });
}

/** Codes définitifs : les rejouer ne changera rien. */
const PERMANENT_CLAWBACK_FAILURES = Object.freeze([
  "CLAWBACK_INSUFFICIENT_FUNDS",
  "REWARD_ID_REQUIRED",
  "CLAWBACK_WALLET_INACTIVE",
]);

function replayResponse(clawbacks, rewardId) {
  return {
    ok: true,
    alreadyReversed: true,
    code: "ALREADY_REVERSED",
    rewardId,
    beneficiaries: clawbacks.map((c) => ({
      userId: c.beneficiaryId,
      role: c.beneficiaryRole,
      debitedAmount: c.debitedAmount,
      debitedCurrency: c.debitedCurrency,
      treasuryCreditedAmount: c.treasuryCreditedAmount,
      treasuryCurrency: c.treasuryCurrency,
      balanceBefore: c.balanceBefore,
      balanceAfter: c.balanceAfter,
      transactionReference: c.transactionReference,
      completedAt: c.completedAt,
    })),
  };
}

/**
 * Reprend le bonus d'une récompense, exactement une fois.
 *
 * @param {object} p
 * @param {string} p.rewardId       récompense dont le versement est repris
 * @param {string} [p.reversedTxId] transaction remboursée à l'origine de la reprise
 * @param {string} [p.reason]       motif lisible (journal d'audit, historique)
 * @param {string} [p.correlationId]
 */
async function reverseReferralBonus({
  rewardId,
  reversedTxId = "",
  reason = "",
  correlationId = "",
}) {
  const reward = String(rewardId || "").trim();

  if (!reward) {
    return {
      ok: false,
      retryable: false,
      code: "REWARD_ID_REQUIRED",
      message: "rewardId requis",
    };
  }

  const { TxWalletBalance, TxSystemBalance, Transaction, ReferralPayout, ReferralClawback } =
    models();

  const payouts = await ReferralPayout.find({
    rewardId: reward,
    status: "succeeded",
  }).lean();

  /**
   * Rien n'a été versé sous ce rewardId : rien à reprendre. Ce n'est pas une
   * erreur — c'est une réponse, que le principal doit distinguer d'une reprise
   * effectuée (`reversed: false`).
   */
  if (!payouts.length) {
    return { ok: true, reversed: false, code: "NOTHING_TO_REVERSE", rewardId: reward };
  }

  const keys = payouts.map((p) => buildClawbackIdempotencyKey(reward, p.beneficiaryId));

  const already = await ReferralClawback.find({
    idempotencyKey: { $in: keys },
    status: "succeeded",
  }).lean();

  if (already.length === payouts.length) {
    return replayResponse(already, reward);
  }

  const safeReason = String(reason || "Activité qualifiante annulée").slice(0, 200);
  const session = await getTxConn().startSession();
  let result = null;

  try {
    await session.withTransaction(async () => {
      /* 1. LE VERROU, AVANT TOUT MOUVEMENT. */
      await ReferralClawback.create(
        payouts.map((p) => ({
          idempotencyKey: buildClawbackIdempotencyKey(reward, p.beneficiaryId),
          rewardId: reward,
          beneficiaryId: p.beneficiaryId,
          beneficiaryRole: p.beneficiaryRole,
          payoutIdempotencyKey: p.idempotencyKey,
          treasuryUserId: p.treasuryUserId,
          treasurySystemType: p.treasurySystemType,
          debitedAmount: p.creditedAmount,
          debitedCurrency: p.creditedCurrency,
          treasuryCreditedAmount: p.treasuryDebitedAmount,
          treasuryCurrency: p.treasuryCurrency,
          status: "processing",
          reversedTxId: String(reversedTxId || ""),
          reason: safeReason,
          correlationId: String(correlationId || ""),
          transactionReference: `${p.transactionReference || `REFBONUS-${reward}`}-REVERSAL`,
        })),
        { session, ordered: true }
      );

      const reversed = [];

      for (const p of payouts) {
        const amount = Number(p.creditedAmount);
        const currency = String(p.creditedCurrency || "").toUpperCase();

        /* 2. Le portefeuille peut-il rendre le bonus ? Lu DANS la transaction. */
        const wallet = await TxWalletBalance.findWallet(p.beneficiaryId, currency, {
          session,
        });

        if (!wallet || wallet.status !== "active") {
          throw coded("CLAWBACK_WALLET_INACTIVE", "Portefeuille absent ou inactif", {
            beneficiaryRole: p.beneficiaryRole,
            currency,
          });
        }

        const balanceBefore = decimalToNumber(wallet.amount);
        const available = decimalToNumber(wallet.availableAmount);

        if (available < amount) {
          throw coded("CLAWBACK_INSUFFICIENT_FUNDS", "Solde insuffisant pour reprendre le bonus", {
            beneficiaryRole: p.beneficiaryRole,
            currency,
            required: amount,
            available,
          });
        }

        const updated = await TxWalletBalance.debit(p.beneficiaryId, currency, amount, {
          session,
        });

        /* 3. La trésorerie récupère exactement ce qu'elle a déboursé. */
        const treasuryAmount = Number(p.treasuryDebitedAmount);

        if (treasuryAmount > 0) {
          await TxSystemBalance.credit(
            p.treasuryUserId,
            p.treasurySystemType,
            p.treasuryCurrency,
            treasuryAmount,
            {
              session,
              reason: "Referral bonus clawback",
              reference: p.idempotencyKey,
              historyMetadata: {
                source: "internal_referral_clawback",
                rewardId: reward,
                beneficiaryRole: p.beneficiaryRole,
                correlationId: String(correlationId || ""),
              },
            }
          );
        }

        /* 4. Mouvement visible par l'utilisateur. */
        const reference = `${p.transactionReference || `REFBONUS-${reward}`}-REVERSAL`;
        const now = new Date();

        const [txDoc] = await Transaction.create(
          [
            {
              reference,
              idempotencyKey: buildClawbackIdempotencyKey(reward, p.beneficiaryId),
              internalImported: false,
              flow: "PAYNOVAL_INTERNAL_TRANSFER",
              operationKind: "adjustment_debit",
              initiatedBy: "system",
              context: "referral_bonus",
              contextId: reward,
              provider: "paynoval",
              type: "referral_bonus_reversal",
              userId: p.beneficiaryId,
              sender: p.beneficiaryId,
              receiver: p.treasuryUserId,
              senderName: null,
              receiverName: "PayNoval Referral Treasury",
              amount,
              localAmount: amount,
              currency,
              localCurrency: currency,
              currencySource: currency,
              currencyTarget: currency,
              localCurrencySymbol: currency,
              status: "confirmed",
              confirmedAt: now,
              completedAt: now,
              requiresSecurityValidation: false,
              securityAttempts: 0,
              securityLockedUntil: null,
              metadata: {
                category: "referral_bonus_reversal",
                role: p.beneficiaryRole,
                rewardId: reward,
                reversedTxId: String(reversedTxId || ""),
                originalReference: p.transactionReference || "",
                correlationId: String(correlationId || ""),
                balanceBefore,
                balanceAfter: decimalToNumber(updated?.amount),
              },
              meta: {
                category: "referral_bonus_reversal",
                role: p.beneficiaryRole,
                direction: "debit",
                rewardId: reward,
                balanceBefore,
                balanceAfter: decimalToNumber(updated?.amount),
              },
              createdAt: now,
              updatedAt: now,
            },
          ],
          { session }
        );

        /* 5. Contre-écriture en partie double — image miroir du versement. */
        await postReferralLedgerEntries({
          mode: "clawback",
          transactionId: txDoc._id,
          reference,
          beneficiaryId: p.beneficiaryId,
          beneficiaryCurrency: currency,
          creditedAmount: amount,
          treasuryUserId: p.treasuryUserId,
          treasurySystemType: p.treasurySystemType,
          treasuryCurrency: p.treasuryCurrency,
          treasuryDebitedAmount: treasuryAmount,
          session,
          metadata: {
            role: p.beneficiaryRole,
            rewardId: reward,
            correlationId: String(correlationId || ""),
            reversedTxId: String(reversedTxId || ""),
            originalReference: p.transactionReference || "",
          },
        });

        reversed.push({
          userId: p.beneficiaryId,
          role: p.beneficiaryRole,
          debitedAmount: amount,
          debitedCurrency: currency,
          treasuryCreditedAmount: treasuryAmount,
          treasuryCurrency: p.treasuryCurrency,
          balanceBefore,
          balanceAfter: decimalToNumber(updated?.amount),
          transactionReference: reference,
          transactionId: String(txDoc._id),
        });
      }

      result = {
        ok: true,
        reversed: true,
        alreadyReversed: false,
        code: null,
        rewardId: reward,
        correlationId: String(correlationId || ""),
        beneficiaries: reversed,
      };

      const completedAt = new Date();

      for (const entry of reversed) {
        await ReferralClawback.updateOne(
          { idempotencyKey: buildClawbackIdempotencyKey(reward, entry.userId) },
          {
            $set: {
              status: "succeeded",
              balanceBefore: entry.balanceBefore,
              balanceAfter: entry.balanceAfter,
              transactionId: entry.transactionId,
              transactionReference: entry.transactionReference,
              responseSnapshot: result,
              completedAt,
            },
          },
          { session }
        );
      }
    });

    logger.info?.("[REFERRAL][TX-CORE][CLAWBACK] bonus repris", {
      rewardId: reward,
      correlationId,
      beneficiaries: result.beneficiaries.length,
    });

    return result;
  } catch (e) {
    if (e?.code === 11000) {
      const settled = await ReferralClawback.find({
        idempotencyKey: { $in: keys },
        status: "succeeded",
      }).lean();

      if (settled.length === payouts.length) return replayResponse(settled, reward);

      logger.error?.("[REFERRAL][TX-CORE][CLAWBACK] doublon d'index inexplique — aucun mouvement", {
        rewardId: reward,
        correlationId,
        keyPattern: e?.keyPattern || null,
      });

      return {
        ok: false,
        retryable: true,
        code: "DUPLICATE_KEY_UNEXPLAINED",
        message: "Conflit d'index inexpliqué, aucun mouvement effectué",
        rewardId: reward,
      };
    }

    const code = e?.code || "TXCORE_REFERRAL_CLAWBACK_FAILED";
    const permanent = PERMANENT_CLAWBACK_FAILURES.includes(code);

    (permanent ? logger.warn : logger.error)?.call(
      logger,
      "[REFERRAL][TX-CORE][CLAWBACK] reprise non effectuee — aucun mouvement",
      { rewardId: reward, correlationId, code, details: e?.details || null }
    );

    return {
      ok: false,
      retryable: !permanent,
      code,
      message: permanent ? e?.message : "Reprise du bonus indisponible",
      details: e?.details || null,
      rewardId: reward,
    };
  } finally {
    await session.endSession();
  }
}

/**
 * Lecture des versements d'un lot de récompenses — pour la réconciliation du
 * principal (« récompense `granted` ⟺ versement enregistré »). Lecture seule.
 */
async function lookupReferralPayouts({ rewardIds = [] } = {}) {
  const ids = [...new Set((Array.isArray(rewardIds) ? rewardIds : []).map(String))]
    .filter((id) => /^[0-9a-f]{24}$/i.test(id))
    .slice(0, 500);

  if (!ids.length) return { payouts: [], clawbacks: [] };

  const { ReferralPayout, ReferralClawback } = models();

  const [payouts, clawbacks] = await Promise.all([
    ReferralPayout.find({ rewardId: { $in: ids } })
      .select("rewardId beneficiaryId beneficiaryRole status creditedAmount creditedCurrency completedAt")
      .lean(),
    ReferralClawback.find({ rewardId: { $in: ids } })
      .select("rewardId beneficiaryId beneficiaryRole status debitedAmount debitedCurrency completedAt")
      .lean(),
  ]);

  const strip = ({ _id, ...rest }) => rest;
  return { payouts: payouts.map(strip), clawbacks: clawbacks.map(strip) };
}

module.exports = {
  reverseReferralBonus,
  lookupReferralPayouts,
  PERMANENT_CLAWBACK_FAILURES,
};
