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
 *
 * Deux natures (2026-09-15) :
 *   WALLET — participant de l'app : son portefeuille est recrédité dans la même
 *            transaction, le remboursement est acquis (`confirmed`).
 *   PAYOUT — invité (lien public) : l'argent SORT vers son opérateur mobile
 *            money. Le coffre est débité et le grand livre écrit AVANT l'appel
 *            à l'opérateur, dont la réponse arrive ensuite :
 *
 *              payout_pending    réservé, versement pas encore soumis
 *              payout_uncertain  appel à l'opérateur sans réponse lisible
 *              payout_submitted  accepté par l'opérateur, confirmation attendue
 *              payout_succeeded  confirmé par l'opérateur — acquis
 *              failed_reversed   refusé : contre-écriture passée, coffre recrédité
 *
 * ⚠️ Aucun numéro de téléphone complet n'est conservé (règle B.4) : il est
 * transmis à l'opérateur puis oublié. `payout.phoneLast4` suffit à répondre au
 * support et à vérifier la correspondance avec le payeur d'origine.
 */

const mongoose = require("mongoose");

const PAYOUT_STATUSES = [
  "payout_pending",
  "payout_uncertain",
  "payout_submitted",
  "payout_succeeded",
  "failed_reversed",
];

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

  const payoutSchema = new mongoose.Schema(
    {
      rail: { type: String, required: true, lowercase: true, trim: true },
      provider: { type: String, required: true, lowercase: true, trim: true },
      phoneLast4: { type: String, required: true, trim: true, maxlength: 4 },
      providerReference: { type: String, default: null, trim: true },
      providerStatus: { type: String, default: null, trim: true },
      mock: { type: Boolean, default: false },
      attempts: { type: Number, default: 0, min: 0 },
      submittedAt: { type: Date, default: null },
      settledAt: { type: Date, default: null },
      lastError: {
        code: { type: String, default: null },
        message: { type: String, default: null, maxlength: 300 },
      },
    },
    { _id: false }
  );

  const schema = new mongoose.Schema(
    {
      reference: { type: String, required: true, trim: true },
      idempotencyKey: { type: String, required: true, trim: true },

      kind: { type: String, enum: ["WALLET", "PAYOUT"], default: "WALLET" },

      participationReference: { type: String, required: true, trim: true },
      participationSettlementId: { type: String, required: true, trim: true },

      cagnotteId: { type: String, required: true, trim: true },
      vaultId: { type: String, required: true, trim: true },
      // Un invité n'a pas de compte : le payeur n'est obligatoire que pour WALLET.
      payerUserId: {
        type: String,
        trim: true,
        default: "",
        required() {
          return this.kind !== "PAYOUT";
        },
      },
      initiatedByUserId: { type: String, required: true, trim: true },
      reason: { type: String, default: "", trim: true, maxlength: 500 },

      refundTarget: { type: money, required: true },
      refundSource: { type: money, required: true },
      isFinal: { type: Boolean, required: true },

      status: { type: String, enum: ["confirmed", ...PAYOUT_STATUSES], default: "confirmed" },
      payout: { type: payoutSchema, default: null },
      payerWalletAfter: { type: mongoose.Schema.Types.Mixed, default: null },
      meta: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    { collection: "tx_cagnotte_refund_settlements", timestamps: true }
  );

  schema.index({ reference: 1 }, { unique: true, name: "uniq_cagnotte_refund_reference" });
  schema.index({ participationReference: 1, createdAt: -1 });
  schema.index({ vaultId: 1, createdAt: -1 });
  // Rapprochement d'un rappel opérateur qui ne renverrait que SA référence.
  schema.index(
    { "payout.providerReference": 1 },
    {
      name: "cagnotte_refund_payout_provider_reference",
      partialFilterExpression: { "payout.providerReference": { $type: "string" } },
    }
  );

  return conn.model(modelName, schema);
};

module.exports.PAYOUT_STATUSES = PAYOUT_STATUSES;
