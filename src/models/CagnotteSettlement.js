"use strict";

const mongoose = require("mongoose");

module.exports = function buildCagnotteSettlementModel(conn) {
  if (!conn) {
    throw new Error("CagnotteSettlement model requires a mongoose connection");
  }

  const modelName = "CagnotteSettlement";
  if (conn.models[modelName]) return conn.models[modelName];

  const schema = new mongoose.Schema(
    {
      reference: { type: String, required: true, unique: true, index: true },
      idempotencyKey: { type: String, required: true, index: true },

      userId: { type: String, required: true, index: true },
      adminUserId: { type: String, required: true, index: true },

      payer: {
        amount: { type: Number, required: true },
        currency: { type: String, required: true, uppercase: true, trim: true },
      },

      feeCredit: {
        amount: { type: Number, default: 0 },
        currency: { type: String, uppercase: true, trim: true },
        baseAmount: { type: Number, default: 0 },
        baseCurrencyCode: { type: String, uppercase: true, trim: true },
      },

      status: {
        type: String,
        default: "confirmed",
        index: true,
      },

      payerWalletAfter: {
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
      collection: "tx_cagnotte_settlements",
      timestamps: true,
    }
  );

  schema.index({ userId: 1, idempotencyKey: 1 });

  return conn.model(modelName, schema);
};