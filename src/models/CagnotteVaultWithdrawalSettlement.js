// "use strict";

// const mongoose = require("mongoose");

// module.exports = function buildCagnotteVaultWithdrawalSettlementModel(conn) {
//   if (!conn) {
//     throw new Error("CagnotteVaultWithdrawalSettlement model requires a mongoose connection");
//   }

//   const modelName = "CagnotteVaultWithdrawalSettlement";
//   if (conn.models[modelName]) return conn.models[modelName];

//   const walletAfterSchema = new mongoose.Schema(
//     {
//       walletId: { type: String, default: "" },
//       currency: { type: String, default: "", uppercase: true, trim: true },
//       amount: { type: Number, default: 0 },
//       availableAmount: { type: Number, default: 0 },
//       reservedAmount: { type: Number, default: 0 },
//     },
//     { _id: false }
//   );

//   const moneySchema = new mongoose.Schema(
//     {
//       amount: { type: Number, required: true, min: 0 },
//       currency: { type: String, required: true, uppercase: true, trim: true },
//     },
//     { _id: false }
//   );

//   const feeDebitSchema = new mongoose.Schema(
//     {
//       amount: { type: Number, default: 0, min: 0 },
//       currency: { type: String, default: "", uppercase: true, trim: true },
//       baseAmount: { type: Number, default: 0, min: 0 },
//       baseCurrencyCode: { type: String, default: "", uppercase: true, trim: true },
//     },
//     { _id: false }
//   );

//   const schema = new mongoose.Schema(
//     {
//       reference: {
//         type: String,
//         required: true,
//         unique: true,
//         index: true,
//         trim: true,
//       },

//       idempotencyKey: {
//         type: String,
//         required: true,
//         index: true,
//         trim: true,
//       },

//       userId: {
//         type: String,
//         required: true,
//         index: true,
//         trim: true,
//       },

//       adminUserId: {
//         type: String,
//         default: "",
//         index: true,
//         trim: true,
//       },

//       vaultId: {
//         type: String,
//         required: true,
//         index: true,
//         trim: true,
//       },

//       cagnotteId: {
//         type: String,
//         required: true,
//         index: true,
//         trim: true,
//       },

//       cagnotteName: {
//         type: String,
//         default: "",
//         trim: true,
//       },

//       mode: {
//         type: String,
//         enum: ["full", "partial"],
//         required: true,
//         index: true,
//       },

//       credit: {
//         type: moneySchema,
//         required: true,
//       },

//       feeDebit: {
//         type: feeDebitSchema,
//         default: () => ({}),
//       },

//       status: {
//         type: String,
//         enum: ["confirmed", "failed"],
//         default: "confirmed",
//         index: true,
//       },

//       userWalletAfter: {
//         type: walletAfterSchema,
//         default: null,
//       },

//       adminWalletAfter: {
//         type: walletAfterSchema,
//         default: null,
//       },

//       meta: {
//         type: mongoose.Schema.Types.Mixed,
//         default: {},
//       },
//     },
//     {
//       collection: "tx_cagnotte_vault_withdrawal_settlements",
//       timestamps: true,
//       minimize: false,
//     }
//   );

//   schema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
//   schema.index({ vaultId: 1, createdAt: -1 });
//   schema.index({ cagnotteId: 1, createdAt: -1 });
//   schema.index({ adminUserId: 1, createdAt: -1 });

//   return conn.model(modelName, schema);
// };







"use strict";

const mongoose = require("mongoose");

module.exports = function buildCagnotteVaultWithdrawalSettlementModel(conn) {
  if (!conn) {
    throw new Error(
      "CagnotteVaultWithdrawalSettlement model requires a mongoose connection"
    );
  }

  const modelName = "CagnotteVaultWithdrawalSettlement";
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

  const moneySchema = new mongoose.Schema(
    {
      amount: { type: Number, required: true, min: 0 },
      currency: { type: String, required: true, uppercase: true, trim: true },
    },
    { _id: false }
  );

  const feeDebitSchema = new mongoose.Schema(
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

      vaultId: {
        type: String,
        required: true,
        index: true,
        trim: true,
      },

      cagnotteId: {
        type: String,
        required: true,
        index: true,
        trim: true,
      },

      cagnotteName: {
        type: String,
        default: "",
        trim: true,
      },

      mode: {
        type: String,
        enum: ["full", "partial"],
        required: true,
        index: true,
      },

      credit: {
        type: moneySchema,
        required: true,
      },

      feeDebit: {
        type: feeDebitSchema,
        default: () => ({}),
      },

      status: {
        type: String,
        enum: ["confirmed", "failed"],
        default: "confirmed",
        index: true,
      },

      userWalletAfter: {
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
    },
    {
      collection: "tx_cagnotte_vault_withdrawal_settlements",
      timestamps: true,
      minimize: false,
    }
  );

  schema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
  schema.index({ vaultId: 1, createdAt: -1 });
  schema.index({ cagnotteId: 1, createdAt: -1 });
  schema.index({ treasuryUserId: 1, createdAt: -1 });
  schema.index({ treasurySystemType: 1, createdAt: -1 });

  return conn.model(modelName, schema);
};