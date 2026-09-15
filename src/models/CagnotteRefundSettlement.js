"use strict";

/**
 * ============================================================================
 * REMBOURSEMENT D'UNE PARTICIPATION DE CAGNOTTE — UNE CONTRE-ÉCRITURE
 * ============================================================================
 *
 * On ne réécrit jamais la participation d'origine (invariant 4) : on écrit un
 * règlement de remboursement, rattaché à elle par `participationReference`,
 * qui débite le coffre et recrédite le payeur AU TAUX D'ORIGINE.
 *
 * Identifiant dérivé de la référence (`settlementObjectIdFromReference`) : un
 * rejeu entre en collision sur la clé primaire, et les écritures du grand
 * livre gardent un `dedupKey` stable.
 */

const mongoose = require("mongoose");

module.exports = function buildCagnotteRefundSettlementModel(conn) {
  if (!conn) {
    throw new Error("CagnotteRefundSettlement : connexion Mongoose requise (base transactions).");
  }

  const modelName = "CagnotteRefundSettlement";
  if (conn.models[modelName]) return conn.models[modelName];

  const money = new mongoose.Schema(
    {
      amount: { type: Number, required: true, min: 0 },
      currency: { type: String, required: true, uppercase: true, trim: true },
    },
    { _id: false }
  );

  const schema = new mongoose.Schema(
    {
      reference: { type: String, required: true, trim: true },
      idempotencyKey: { type: String, required: true, trim: true },

      participationReference: { type: String, required: true, trim: true },
      participationSettlementId: { type: String, required: true, trim: true },

      cagnotteId: { type: String, required: true, trim: true },
      vaultId: { type: String, required: true, trim: true },
      payerUserId: { type: String, required: true, trim: true },
      initiatedByUserId: { type: String, required: true, trim: true },
      reason: { type: String, default: "", trim: true, maxlength: 500 },

      refundTarget: { type: money, required: true },
      refundSource: { type: money, required: true },
      isFinal: { type: Boolean, required: true },

      status: { type: String, enum: ["confirmed"], default: "confirmed" },
      payerWalletAfter: { type: mongoose.Schema.Types.Mixed, default: null },
      meta: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    { collection: "tx_cagnotte_refund_settlements", timestamps: true }
  );

  schema.index({ reference: 1 }, { unique: true, name: "uniq_cagnotte_refund_reference" });
  schema.index({ participationReference: 1, createdAt: -1 });
  schema.index({ vaultId: 1, createdAt: -1 });

  return conn.model(modelName, schema);
};
