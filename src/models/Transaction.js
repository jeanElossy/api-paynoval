// File: models/Transaction.js
"use strict";

const mongoose = require("mongoose");
const crypto = require("crypto");

const transactionSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reference: { type: String, required: true, unique: true, trim: true },

    // ✅ idempotency
    idempotencyKey: { type: String, default: null, trim: true },

    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: {
        validator: (v) => parseFloat(v.toString()) >= 0.01,
        message: (props) => `Le montant doit être ≥ 0.01, reçu ${props.value}`,
      },
    },
    transactionFees: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      default: mongoose.Types.Decimal128.fromString("0.00"),
      validate: {
        validator: (v) => parseFloat(v.toString()) >= 0.0,
        message: (props) => `Les frais doivent être ≥ 0.00, reçus ${props.value}`,
      },
    },
    netAmount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: {
        validator: (v) => parseFloat(v.toString()) >= 0.0,
        message: (props) => `Le net à créditer doit être ≥ 0.00, reçu ${props.value}`,
      },
    },

    senderName: { type: String, required: true, trim: true, maxlength: 100 },
    senderEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 100,
      match: /.+@.+\..+/,
    },

    // legacy (mais on force ISO dedans)
    senderCurrencySymbol: { type: String, required: true, trim: true, maxlength: 3 },

    exchangeRate: { type: mongoose.Schema.Types.Decimal128, required: true },
    localAmount: { type: mongoose.Schema.Types.Decimal128, required: true },

    // legacy (mais on force ISO dedans)
    localCurrencySymbol: { type: String, required: true, trim: true, maxlength: 3 },

    nameDestinataire: { type: String, required: true, trim: true, maxlength: 100 },
    recipientEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: /.+@.+\..+/,
    },

    country: { type: String, required: true, trim: true, maxlength: 100 },

    // ✅ Question visible
    securityQuestion: { type: String, required: true, trim: true, maxlength: 200 },

    // ✅ NEW: hash de la réponse (jamais exposé)
    securityAnswerHash: { type: String, select: false, default: null },

    // ✅ legacy (on garde pour compat; on le considère aussi comme hash)
    securityCode: { type: String, required: true, select: false },

    refundedAt: { type: Date, default: null },
    refundReason: { type: String, default: null },
    validatedAt: { type: Date, default: null },
    adminNote: { type: String, default: null },
    reassignedAt: { type: Date, default: null },

    archived: { type: Boolean, default: false },
    archivedAt: { type: Date },
    archivedBy: { type: String },

    relaunchedAt: { type: Date },
    relaunchedBy: { type: String },
    relaunchCount: { type: Number, default: 0 },

    cancellationFee: { type: Number, default: 0 },
    cancellationFeeType: { type: String, enum: ["fixed", "percent"], default: "fixed" },
    cancellationFeePercent: { type: Number, default: 0 },
    cancellationFeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Fee", default: null },

    operationKind: {
      type: String,
      enum: [
        "transfer",
        "bonus",
        "cashback",
        "purchase",
        "adjustment_credit",
        "adjustment_debit",
        "cagnotte_participation",
        "cagnotte_withdrawal",
        "generic",
        null,
      ],
      default: "transfer",
    },
    initiatedBy: { type: String, enum: ["user", "system", "admin", "job", null], default: "user" },
    context: { type: String, default: null },
    contextId: { type: String, default: null },

    destination: {
      type: String,
      required: true,
      enum: ["paynoval", "stripe", "bank", "mobilemoney", "visa_direct", "stripe2momo", "cashin", "cashout"],
    },
    funds: {
      type: String,
      required: true,
      enum: ["paynoval", "stripe", "bank", "mobilemoney", "visa_direct", "stripe2momo", "cashin", "cashout"],
    },

    status: {
      type: String,
      enum: ["pending", "pending_review", "confirmed", "cancelled", "refunded", "relaunch", "locked"],
      default: "pending",
    },

    verificationToken: {
      type: String,
      unique: true,
      select: false,
      default: null,
    },

    confirmedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },

    description: { type: String, default: null },
    orderId: { type: String, default: null },
    metadata: { type: Object, default: null },

    attemptCount: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },

    // ✅ fees snapshots
    feeSnapshot: { type: Object, default: null },
    feeActual: { type: Object, default: null },
    feeId: { type: mongoose.Schema.Types.Mixed, default: null },

    // ✅ AML snapshots
    amlSnapshot: { type: Object, default: null },
    amlStatus: { type: String, default: null }, // "passed"/"blocked"/"challenge"/"error" (optionnel)

    referralSnapshot: { type: Object, default: null },

    // ✅ FORMAT STANDARD UNIQUE
    amountSource: { type: mongoose.Schema.Types.Decimal128, default: null },
    amountTarget: { type: mongoose.Schema.Types.Decimal128, default: null },
    feeSource: { type: mongoose.Schema.Types.Decimal128, default: null },
    fxRateSourceToTarget: { type: mongoose.Schema.Types.Decimal128, default: null },
    currencySource: { type: String, default: null, trim: true, maxlength: 3 },
    currencyTarget: { type: String, default: null, trim: true, maxlength: 3 },

    money: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { versionKey: false, timestamps: true }
);

transactionSchema.index({ sender: 1, createdAt: -1 });
transactionSchema.index({ receiver: 1, status: 1 });
transactionSchema.index({ verificationToken: 1 });
transactionSchema.index({ sender: 1, idempotencyKey: 1 }, { unique: true, sparse: true }); // ✅ idempotency

transactionSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id;

    // legacy numbers
    if (ret.amount != null) ret.amount = parseFloat(ret.amount.toString());
    if (ret.transactionFees != null) ret.transactionFees = parseFloat(ret.transactionFees.toString());
    if (ret.netAmount != null) ret.netAmount = parseFloat(ret.netAmount.toString());
    if (ret.exchangeRate != null) ret.exchangeRate = parseFloat(ret.exchangeRate.toString());
    if (ret.localAmount != null) ret.localAmount = parseFloat(ret.localAmount.toString());

    // standard numbers
    if (ret.amountSource != null) ret.amountSource = parseFloat(ret.amountSource.toString());
    if (ret.amountTarget != null) ret.amountTarget = parseFloat(ret.amountTarget.toString());
    if (ret.feeSource != null) ret.feeSource = parseFloat(ret.feeSource.toString());
    if (ret.fxRateSourceToTarget != null) ret.fxRateSourceToTarget = parseFloat(ret.fxRateSourceToTarget.toString());

    // money.* amounts
    if (ret.money && typeof ret.money === "object") {
      const m = ret.money;
      if (m.source?.amount != null) m.source.amount = parseFloat(String(m.source.amount));
      if (m.feeSource?.amount != null) m.feeSource.amount = parseFloat(String(m.feeSource.amount));
      if (m.target?.amount != null) m.target.amount = parseFloat(String(m.target.amount));
      ret.money = m;
    }

    delete ret._id;

    // sécurité
    delete ret.securityCode;
    delete ret.securityAnswerHash;
    delete ret.verificationToken;
    delete ret.attemptCount;
    delete ret.lastAttemptAt;
    delete ret.lockedUntil;

    return ret;
  },
});

transactionSchema.pre("validate", function (next) {
  if (this.isNew && !this.verificationToken) {
    this.verificationToken = crypto.randomBytes(32).toString("hex");
  }
  next();
});

module.exports = (conn = mongoose) => conn.models.Transaction || conn.model("Transaction", transactionSchema);
