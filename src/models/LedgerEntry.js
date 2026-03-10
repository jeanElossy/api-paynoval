"use strict";

const mongoose = require("mongoose");

function normCurrency(v) {
  return String(v || "").trim().toUpperCase();
}

const ledgerEntrySchema = new mongoose.Schema(
  {
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      required: true,
      index: true,
    },

    reference: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    accountType: {
      type: String,
      enum: [
        "USER_WALLET",
        "ADMIN_REVENUE",
        "SYSTEM_CLEARING",
        "SYSTEM_RESERVE",
      ],
      required: true,
      index: true,
    },

    accountId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    direction: {
      type: String,
      enum: ["DEBIT", "CREDIT"],
      required: true,
      index: true,
    },

    entryType: {
      type: String,
      enum: [
        "RESERVE",
        "RESERVE_RELEASE",
        "RESERVE_CAPTURE",
        "USER_DEBIT",
        "USER_CREDIT",
        "FEE_REVENUE",
        "FX_REVENUE",
        "REFUND",
        "REVERSAL",
        "ADJUSTMENT",
      ],
      required: true,
      index: true,
    },

    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
    },

    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      maxlength: 4,
      index: true,
    },

    status: {
      type: String,
      enum: ["PENDING", "POSTED", "REVERSED"],
      default: "POSTED",
      index: true,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

ledgerEntrySchema.index(
  {
    transactionId: 1,
    accountId: 1,
    entryType: 1,
    direction: 1,
    currency: 1,
  },
  { unique: false }
);

ledgerEntrySchema.pre("validate", function (next) {
  this.currency = normCurrency(this.currency);
  next();
});

ledgerEntrySchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id;
    ret.amount = Number(ret.amount?.toString?.() || 0);
    delete ret._id;
    return ret;
  },
});

module.exports = (conn = mongoose) =>
  conn.models.LedgerEntry || conn.model("LedgerEntry", ledgerEntrySchema);