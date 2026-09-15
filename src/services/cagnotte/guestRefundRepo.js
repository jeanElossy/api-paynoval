"use strict";

/**
 * Accès Mongo du remboursement invité (voir `guestRefund.js` pour la logique).
 *
 * Deux transactions, chacune COURTE et sans appel réseau :
 *   reserve    — garde du cumul remboursé, débit de la position, règlement,
 *                grand livre vers la sortie prestataire ;
 *   compensate — transition gardée vers `failed_reversed`, position
 *                recréditée, cumul rétabli, contre-écriture au grand livre.
 *
 * Toute écriture d'argent est conditionnelle : un rejeu ou une course ne peut
 * ni débiter deux fois, ni contre-passer deux fois.
 */

const { getTxConn } = require("../../config/db");
const buildCagnotteRefundSettlementModel = require("../../models/CagnotteRefundSettlement");
const buildCagnotteExternalSettlementModel = require("../../models/CagnotteExternalSettlement");
const buildCagnotteVaultPositionModel = require("../../models/CagnotteVaultPosition");
const { runWithTransaction } = require("../../utils/transactionRunner");
const { postCagnotteLotEntries, settlementObjectIdFromReference } = require("../ledgerService");
const { debitPosition, reverseRefundDebit } = require("./vaultPosition");
const { roundMoney } = require("../pricing/pricingEngine");
const { getProviderAdapter } = require("../../providers/providerSelector");
const { STATUS, OPEN_STATUSES, guestRefundError } = require("./guestRefund");

/** `field` vaut `value` — ou est absent quand `value` vaut 0 (documents antérieurs au cumul). */
function eqOrMissing(field, value) {
  return Number(value) === 0
    ? { $or: [{ [field]: 0 }, { [field]: { $exists: false } }, { [field]: null }] }
    : { [field]: value };
}

function makeGuestRefundRepo() {
  const txConn = getTxConn();
  const Refund = buildCagnotteRefundSettlementModel(txConn);
  const External = buildCagnotteExternalSettlementModel(txConn);
  const Position = buildCagnotteVaultPositionModel(txConn);
  const CollectionIntent = txConn.models.CollectionIntent || require("../../models/CollectionIntent")(txConn);

  async function inTransaction(fn) {
    const session = await txConn.startSession();
    try {
      return await runWithTransaction(session, () => fn(session));
    } finally {
      await session.endSession();
    }
  }

  return {
    findRefundByReference: (reference) => Refund.findOne({ reference }).lean(),

    findExternalSettlement: (reference) => External.findOne({ reference }).lean(),

    findCollectionIntent({ providerReference, cagnotteId }) {
      const ref = String(providerReference || "").trim();
      if (!ref) return null;
      return CollectionIntent.findOne({
        "target.cagnotteId": String(cagnotteId),
        $or: [{ reference: ref }, { providerReference: ref }],
      }).lean();
    },

    findRefundForWebhook({ reference, providerReference }) {
      const or = [];
      if (reference) or.push({ reference });
      if (providerReference) or.push({ "payout.providerReference": providerReference });
      if (!or.length) return null;
      return Refund.findOne({ kind: "PAYOUT", $or: or }).lean();
    },

    reserve({ original, refundedSource, refundedTarget, amounts, doc, lots }) {
      const S = doc.refundSource.currency;
      const T = doc.refundTarget.currency;

      return inTransaction(async (session) => {
        const again = await Refund.findOne({ reference: doc.reference }).session(session).lean();
        if (again) return { replay: true, refund: again };

        // Deux remboursements simultanés ne partent pas du même cumul.
        const guard = await External.updateOne(
          {
            _id: original._id,
            $and: [eqOrMissing("refunded.source", refundedSource), eqOrMissing("refunded.target", refundedTarget)],
          },
          {
            $set: {
              "refunded.source": roundMoney(refundedSource + amounts.refundSource, S),
              "refunded.target": roundMoney(refundedTarget + amounts.refundTarget, T),
            },
          },
          { session }
        );

        if (!guard?.modifiedCount) {
          throw guestRefundError(409, "CONCURRENT_REFUND", "Un autre remboursement est en cours sur cette participation. Réessayer.");
        }

        await debitPosition({
          Model: Position,
          vaultId: original.vaultId,
          currency: T,
          amount: amounts.refundTarget,
          kind: "REFUND",
          forbidClosed: true,
          session,
        });

        const settlementId = settlementObjectIdFromReference(doc.reference, "cagnotte.guest-refund");
        const [refund] = await Refund.create([{ _id: settlementId, ...doc }], { session });

        await postCagnotteLotEntries({
          settlementId,
          reference: doc.reference,
          lots,
          session,
          metadata: {
            settlementKind: "cagnotte_guest_refund",
            cagnotteId: doc.cagnotteId,
            vaultId: doc.vaultId,
            participationReference: doc.participationReference,
            provider: doc.payout.provider,
          },
        });

        return { replay: false, refund: refund.toObject() };
      });
    },

    setStatus(id, fromStatuses, toStatus, set = {}) {
      return Refund.findOneAndUpdate(
        { _id: id, status: { $in: fromStatuses } },
        { $set: { status: toStatus, ...set } },
        { new: true }
      ).lean();
    },

    incrementAttempts: (id) => Refund.updateOne({ _id: id }, { $inc: { "payout.attempts": 1 } }),

    /** Rend `true` si la contre-écriture a été passée ici, `false` si l'état était déjà tranché. */
    compensate({ refund, error, reversalLots, at }) {
      const S = refund.refundSource.currency;
      const T = refund.refundTarget.currency;
      const s = Number(refund.refundSource.amount);
      const t = Number(refund.refundTarget.amount);

      return inTransaction(async (session) => {
        const flipped = await Refund.findOneAndUpdate(
          { _id: refund._id, status: { $in: OPEN_STATUSES } },
          { $set: { status: STATUS.REVERSED, "payout.settledAt": at, "payout.lastError": error } },
          { new: true, session }
        );

        if (!flipped) return false;

        await reverseRefundDebit({ Model: Position, vaultId: refund.vaultId, currency: T, amount: t, session });

        const current = await External.findOne({ reference: refund.participationReference }).session(session).lean();
        const cs = Number(current?.refunded?.source || 0);
        const ct = Number(current?.refunded?.target || 0);

        const restored = await External.updateOne(
          { _id: current?._id, "refunded.source": cs, "refunded.target": ct },
          {
            $set: {
              "refunded.source": Math.max(0, roundMoney(cs - s, S)),
              "refunded.target": Math.max(0, roundMoney(ct - t, T)),
            },
          },
          { session }
        );

        if (!current || !restored?.modifiedCount) {
          throw guestRefundError(409, "CONCURRENT_REFUND", "Cumul remboursé modifié pendant la contre-passation. Réessayer.");
        }

        const reversalReference = `${refund.reference}:reversal`;
        await postCagnotteLotEntries({
          settlementId: settlementObjectIdFromReference(reversalReference, "cagnotte.guest-refund.reversal"),
          reference: reversalReference,
          lots: reversalLots,
          session,
          metadata: {
            settlementKind: "cagnotte_guest_refund_reversal",
            cagnotteId: refund.cagnotteId,
            vaultId: refund.vaultId,
            refundReference: refund.reference,
            reason: error?.code || null,
          },
        });

        return true;
      });
    },
  };
}

/** Dépendances réelles de `guestRefund.js`. */
function guestRefundDeps() {
  return { repo: makeGuestRefundRepo(), getAdapter: getProviderAdapter, now: () => new Date() };
}

module.exports = { makeGuestRefundRepo, guestRefundDeps, eqOrMissing };
