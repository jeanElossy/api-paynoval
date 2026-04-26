// File: models/TxRefundRequest.js

"use strict";

const mongoose = require("mongoose");

module.exports = (conn = mongoose) => {
  if (conn.models.TxRefundRequest) return conn.models.TxRefundRequest;

  const Schema = mongoose.Schema;

  const refundRequestSchema = new Schema(
    {
      transactionId: {
        type: String,
        required: true,
        trim: true,
        index: true,
      },

      reference: {
        type: String,
        default: null,
        trim: true,
        index: true,
      },

      sender: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
      },

      type: {
        type: String,
        enum: ["cancellation_refund"],
        default: "cancellation_refund",
        index: true,
      },

      status: {
        type: String,
        enum: [
          "pending",
          "processing",
          "completed",
          "failed",
          "manual_review_required",
        ],
        default: "pending",
        index: true,
      },

      currency: {
        type: String,
        required: true,
        uppercase: true,
        trim: true,
        index: true,
      },

      countryCode: {
        type: String,
        uppercase: true,
        trim: true,
        default: null,
        index: true,
      },

      originalAmount: {
        type: Number,
        required: true,
        min: 0,
      },

      refundAmount: {
        type: Number,
        required: true,
        min: 0,
      },

      cancellationFee: {
        type: Number,
        required: true,
        min: 0,
      },

      feeSourceCurrency: {
        type: String,
        uppercase: true,
        trim: true,
        default: null,
      },

      treasuryFeeAmount: {
        type: Number,
        default: 0,
        min: 0,
      },

      treasuryFeeCurrency: {
        type: String,
        uppercase: true,
        trim: true,
        default: null,
      },

      treasurySystemType: {
        type: String,
        default: "FEES_TREASURY",
        trim: true,
        index: true,
      },

      treasuryUserId: {
        type: String,
        default: null,
        trim: true,
      },

      treasuryLabel: {
        type: String,
        default: "PayNoval Fees Treasury",
        trim: true,
      },

      reason: {
        type: String,
        required: true,
        trim: true,
        maxlength: 1000,
      },

      requestedBy: {
        id: {
          type: String,
          default: null,
          trim: true,
        },
        email: {
          type: String,
          default: null,
          trim: true,
        },
        role: {
          type: String,
          default: null,
          trim: true,
        },
        source: {
          type: String,
          enum: ["user", "support", "admin", "superadmin", "system"],
          default: "support",
        },
      },

      idempotencyKey: {
        type: String,
        required: true,
        trim: true,
        unique: true,
        index: true,
      },

      completedAt: {
        type: Date,
        default: null,
      },

      failedAt: {
        type: Date,
        default: null,
      },

      failureReason: {
        type: String,
        default: null,
      },

      metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
      },
    },
    {
      timestamps: true,
      versionKey: "__v",
      collection: "tx_refund_requests",
    }
  );

  refundRequestSchema.index(
    { transactionId: 1, type: 1 },
    {
      unique: true,
      partialFilterExpression: {
        type: "cancellation_refund",
      },
    }
  );

  return conn.model("TxRefundRequest", refundRequestSchema);
};