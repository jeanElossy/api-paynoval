// "use strict";

// const mongoose = require("mongoose");

// module.exports = function buildCagnotteSettlementModel(conn) {
//   if (!conn) {
//     throw new Error("CagnotteSettlement model requires a mongoose connection");
//   }

//   const modelName = "CagnotteSettlement";
//   if (conn.models[modelName]) return conn.models[modelName];

//   const schema = new mongoose.Schema(
//     {
//       reference: { type: String, required: true, unique: true, index: true },
//       idempotencyKey: { type: String, required: true, index: true },

//       userId: { type: String, required: true, index: true },
//       adminUserId: { type: String, required: true, index: true },

//       payer: {
//         amount: { type: Number, required: true },
//         currency: { type: String, required: true, uppercase: true, trim: true },
//       },

//       feeCredit: {
//         amount: { type: Number, default: 0 },
//         currency: { type: String, uppercase: true, trim: true },
//         baseAmount: { type: Number, default: 0 },
//         baseCurrencyCode: { type: String, uppercase: true, trim: true },
//       },

//       status: {
//         type: String,
//         default: "confirmed",
//         index: true,
//       },

//       payerWalletAfter: {
//         walletId: String,
//         currency: String,
//         amount: Number,
//         availableAmount: Number,
//         reservedAmount: Number,
//       },

//       adminWalletAfter: {
//         walletId: String,
//         currency: String,
//         amount: Number,
//         availableAmount: Number,
//         reservedAmount: Number,
//       },

//       meta: {
//         type: Object,
//         default: {},
//       },
//     },
//     {
//       collection: "tx_cagnotte_settlements",
//       timestamps: true,
//     }
//   );

//   schema.index({ userId: 1, idempotencyKey: 1 });

//   return conn.model(modelName, schema);
// };






"use strict";

const mongoose = require("mongoose");

module.exports = function buildCagnotteSettlementModel(conn) {
  if (!conn) {
    throw new Error("CagnotteSettlement model requires a mongoose connection");
  }

  const modelName = "CagnotteSettlement";
  if (conn.models[modelName]) return conn.models[modelName];

  const walletAfterSchema = new mongoose.Schema(
    {
      walletId: { type: String, default: "", trim: true },
      currency: { type: String, default: "", uppercase: true, trim: true },
      amount: { type: Number, default: 0, min: 0 },
      availableAmount: { type: Number, default: 0, min: 0 },
      reservedAmount: { type: Number, default: 0, min: 0 },
    },
    { _id: false }
  );

  const feeCreditSchema = new mongoose.Schema(
    {
      amount: { type: Number, default: 0, min: 0 },
      currency: { type: String, default: "", uppercase: true, trim: true },
      baseAmount: { type: Number, default: 0, min: 0 },
      baseCurrencyCode: {
        type: String,
        default: "",
        uppercase: true,
        trim: true,
      },
    },
    { _id: false }
  );

  const payerSchema = new mongoose.Schema(
    {
      amount: { type: Number, required: true, min: 0 },
      currency: { type: String, required: true, uppercase: true, trim: true },
    },
    { _id: false }
  );

  const schema = new mongoose.Schema(
    {
      reference: {
        type: String,
        required: true,
        unique: true,
        index: true,
        trim: true,
      },

      idempotencyKey: {
        type: String,
        required: true,
        index: true,
        trim: true,
      },

      userId: {
        type: String,
        required: true,
        index: true,
        trim: true,
      },

      treasuryUserId: {
        type: String,
        default: "",
        index: true,
        trim: true,
      },

      treasurySystemType: {
        type: String,
        default: "",
        index: true,
        trim: true,
        uppercase: true,
      },

      treasuryLabel: {
        type: String,
        default: "",
        trim: true,
      },

      payer: {
        type: payerSchema,
        required: true,
      },

      feeCredit: {
        type: feeCreditSchema,
        default: () => ({}),
      },

      status: {
        type: String,
        enum: ["confirmed", "failed"],
        default: "confirmed",
        index: true,
      },

      payerWalletAfter: {
        type: walletAfterSchema,
        default: null,
      },

      treasuryWalletAfter: {
        type: walletAfterSchema,
        default: null,
      },

      meta: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },

      /**
       * ── Forme v2 (2026-09-10) : les montants sont ceux du DEVIS Tx-Core ──
       *
       * v1 recopiait ce que le backend envoyait (y compris un « taux » fourni
       * par le client). v2 relit un `CagnotteQuote` consommé dans la même
       * transaction : source, frais, taux et montant crédité sont historisés
       * ici et ne sont JAMAIS recalculés au taux du jour (R11).
       */
      schemaVersion: { type: Number, default: 1 },
      cagnotteId: { type: String, default: null, trim: true },
      vaultId: { type: String, default: null, trim: true },
      quoteId: { type: String, default: null, trim: true },
      source: { type: payerSchema, default: null },
      fee: { type: payerSchema, default: null },
      netSource: { type: Number, default: null, min: 0 },
      destination: { type: payerSchema, default: null },
      fx: {
        required: { type: Boolean, default: false },
        appliedRate: { type: Number, default: null },
        marketRate: { type: Number, default: null },
        revenue: { type: Number, default: 0, min: 0 },
        provider: { type: String, default: null },
        rateSource: { type: String, default: null },
        asOf: { type: Date, default: null },
      },
      /** Cumul remboursé, maintenu par mise à jour CONDITIONNELLE. */
      refunded: {
        source: { type: Number, default: 0, min: 0 },
        target: { type: Number, default: 0, min: 0 },
      },
    },
    {
      collection: "tx_cagnotte_settlements",
      timestamps: true,
      minimize: false,
    }
  );

  schema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
  schema.index({ treasuryUserId: 1, createdAt: -1 });
  schema.index({ treasurySystemType: 1, createdAt: -1 });
  schema.index({ vaultId: 1, createdAt: -1 });

  return conn.model(modelName, schema);
};