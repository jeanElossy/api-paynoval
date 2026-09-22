"use strict";

/**
 * ============================================================================
 * REGISTRE DES REPRISES DE BONUS DE PARRAINAGE
 * ============================================================================
 *
 * Jumeau de `ReferralPayout`, dans l'autre sens. Quand l'activité qui a ouvert
 * droit à un bonus est annulée (transaction remboursée), le bonus est repris :
 * le portefeuille du bénéficiaire est débité et la trésorerie de parrainage
 * recréditée — par CONTRE-ÉCRITURE, jamais en réécrivant le versement
 * d'origine (invariant 4).
 *
 * C'est la pratique de Wise et Revolut : « we may reverse the reward if the
 * qualifying transaction is refunded ».
 *
 * LES MONTANTS NE VIENNENT PAS DE L'APPELANT
 * ------------------------------------------
 * Une reprise rend EXACTEMENT ce qui a été versé : `creditedAmount` débité au
 * bénéficiaire, `treasuryDebitedAmount` rendu à la trésorerie, tous deux lus
 * dans le `ReferralPayout` d'origine. Aucun taux de change n'est réappliqué —
 * la position de la trésorerie revient à l'identique — et aucun montant ne
 * transite dans la requête du principal.
 *
 * CLÉ PERMANENTE
 * --------------
 * `REFERRAL_CLAWBACK:{rewardId}:{beneficiaryId}` — un versement ne peut être
 * repris qu'une fois. Aucun TTL, pour la même raison que `ReferralPayout`.
 */

const mongoose = require("mongoose");

const referralClawbackSchema = new mongoose.Schema(
  {
    idempotencyKey: { type: String, required: true, trim: true },

    rewardId: { type: String, required: true, trim: true, index: true },
    beneficiaryId: { type: String, required: true, trim: true, index: true },
    beneficiaryRole: {
      type: String,
      enum: ["sponsor", "referee"],
      required: true,
    },

    /** Versement d'origine repris (sa clé d'idempotence). */
    payoutIdempotencyKey: { type: String, required: true, trim: true },

    treasuryUserId: { type: String, required: true, trim: true },
    treasurySystemType: { type: String, required: true, trim: true },

    debitedAmount: { type: Number, required: true, min: 0 },
    debitedCurrency: { type: String, required: true, trim: true },

    treasuryCreditedAmount: { type: Number, required: true, min: 0 },
    treasuryCurrency: { type: String, required: true, trim: true },

    balanceBefore: { type: Number, default: null },
    balanceAfter: { type: Number, default: null },

    status: {
      type: String,
      enum: ["processing", "succeeded"],
      default: "processing",
      required: true,
      index: true,
    },

    /** Transaction ayant causé la reprise (celle qui a été remboursée). */
    reversedTxId: { type: String, trim: true, default: "" },
    reason: { type: String, trim: true, default: "", maxlength: 200 },

    transactionReference: { type: String, trim: true, default: "" },
    transactionId: { type: mongoose.Schema.Types.ObjectId, default: null },

    correlationId: { type: String, trim: true, default: "", index: true },

    responseSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },

    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/** Une reprise par versement, pour toujours. Même règle que `ReferralPayout`. */
referralClawbackSchema.index(
  { idempotencyKey: 1 },
  { unique: true, name: "uniq_referral_clawback_idempotency_key" }
);

module.exports = (conn = mongoose) =>
  conn.models.ReferralClawback ||
  conn.model("ReferralClawback", referralClawbackSchema);
