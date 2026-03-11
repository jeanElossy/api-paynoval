"use strict";

const mongoose = require("mongoose");

module.exports = function buildCagnotteVaultWithdrawalSettlementModel(conn) {
  if (!conn) {
    throw new Error("CagnotteVaultWithdrawalSettlement model requires a mongoose connection");
  }

  const modelName = "CagnotteVaultWithdrawalSettlement";
  if (conn.models[modelName]) return conn.models[modelName];

  const schema = new mongoose.Schema(
    {
      reference: {
        type: String,
        required: true,
        unique: true,
        index: true,
      },

      idempotencyKey: {
        type: String,
        required: true,
        index: true,
      },

      userId: {
        type: String,
        required: true,
        index: true,
      },

      vaultId: {
        type: String,
        required: true,
        index: true,
      },

      cagnotteId: {
        type: String,
        required: true,
        index: true,
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
        amount: {
          type: Number,
          required: true,
          min: 0,
        },
        currency: {
          type: String,
          required: true,
          uppercase: true,
          trim: true,
        },
      },

      feeDebit: {
        amount: {
          type: Number,
          default: 0,
          min: 0,
        },
        currency: {
          type: String,
          uppercase: true,
          trim: true,
        },
        baseAmount: {
          type: Number,
          default: 0,
        },
        baseCurrencyCode: {
          type: String,
          uppercase: true,
          trim: true,
        },
      },

      status: {
        type: String,
        enum: ["confirmed", "failed"],
        default: "confirmed",
        index: true,
      },

      userWalletAfter: {
        walletId: String,
        currency: String,
        amount: Number,
        availableAmount: Number,
        reservedAmount: Number,
      },

      adminWalletAfter: {
        walletId: String,
        currency: String,
        amount: Number,
        availableAmount: Number,
        reservedAmount: Number,
      },

      meta: {
        type: Object,
        default: {},
      },
    },
    {
      collection: "tx_cagnotte_vault_withdrawal_settlements",
      timestamps: true,
    }
  );

  schema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
  schema.index({ vaultId: 1, createdAt: -1 });
  schema.index({ cagnotteId: 1, createdAt: -1 });

  return conn.model(modelName, schema);
};