// File: models/Transaction.js
"use strict";

const mongoose = require("mongoose");
const crypto = require("crypto");

/**
 * ✅ Objectif:
 * - Garder tes TX "transfer" (sender/receiver/etc.) intactes
 * - Permettre des "TX importées" (cagnotte participation, fees, etc.)
 *   qui doivent apparaître dans la liste des transactions d’un user
 *
 * Stratégie:
 * - internalImported=true => on relâche les champs required
 * - userId = owner (pour list by user)
 * - index unique { userId, reference } pour idempotence
 */

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function normCurrency(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return null;
  if (s.length < 3 || s.length > 4) return null;
  return s;
}

const transactionSchema = new mongoose.Schema(
  {
    // ✅ Owner (pour listes)
    // Quand internalImported=true, c’est ce champ qui sert pour "mes transactions"
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },

    // ✅ Mode import interne (cagnotte, fees, mirror, etc.)
    internalImported: { type: Boolean, default: false, index: true },

    // -----------------------------
    // Champs “classiques” PNV↔PNV
    // -----------------------------
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: function () {
        return !this.internalImported;
      },
      default: null,
      index: true,
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: function () {
        return !this.internalImported;
      },
      default: null,
      index: true,
    },

    // ⚠️ On enlève unique global, on met l’unique sur {userId, reference}
    reference: { type: String, required: true, trim: true, index: true },

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
      required: function () {
        return !this.internalImported;
      },
      default: mongoose.Types.Decimal128.fromString("0.00"),
      validate: {
        validator: (v) => parseFloat(v.toString()) >= 0.0,
        message: (props) => `Les frais doivent être ≥ 0.00, reçus ${props.value}`,
      },
    },

    netAmount: {
      type: mongoose.Schema.Types.Decimal128,
      required: function () {
        return !this.internalImported;
      },
      default: mongoose.Types.Decimal128.fromString("0.00"),
      validate: {
        validator: (v) => parseFloat(v.toString()) >= 0.0,
        message: (props) => `Le net à créditer doit être ≥ 0.00, reçu ${props.value}`,
      },
    },

    senderName: {
      type: String,
      required: function () {
        return !this.internalImported;
      },
      trim: true,
      maxlength: 100,
      default: null,
    },
    senderEmail: {
      type: String,
      required: function () {
        return !this.internalImported;
      },
      trim: true,
      lowercase: true,
      maxlength: 100,
      match: /.+@.+\..+/,
      default: null,
    },

    // legacy (mais on force ISO dedans)
    senderCurrencySymbol: {
      type: String,
      required: function () {
        return !this.internalImported;
      },
      trim: true,
      maxlength: 4,
      default: null,
    },

    exchangeRate: {
      type: mongoose.Schema.Types.Decimal128,
      required: function () {
        return !this.internalImported;
      },
      default: mongoose.Types.Decimal128.fromString("1.00"),
    },

    localAmount: {
      type: mongoose.Schema.Types.Decimal128,
      required: function () {
        return !this.internalImported;
      },
      default: mongoose.Types.Decimal128.fromString("0.00"),
    },

    // legacy (mais on force ISO dedans)
    localCurrencySymbol: {
      type: String,
      required: function () {
        return !this.internalImported;
      },
      trim: true,
      maxlength: 4,
      default: null,
    },

    nameDestinataire: {
      type: String,
      required: function () {
        return !this.internalImported;
      },
      trim: true,
      maxlength: 100,
      default: null,
    },

    recipientEmail: {
      type: String,
      required: function () {
        return !this.internalImported;
      },
      trim: true,
      lowercase: true,
      match: /.+@.+\..+/,
      default: null,
    },

    country: {
      type: String,
      required: function () {
        return !this.internalImported;
      },
      trim: true,
      maxlength: 100,
      default: null,
    },

    // ✅ Question visible
    securityQuestion: {
      type: String,
      required: function () {
        return !this.internalImported;
      },
      trim: true,
      maxlength: 200,
      default: null,
    },

    // ✅ NEW: hash de la réponse (jamais exposé)
    securityAnswerHash: { type: String, select: false, default: null },

    // ✅ legacy (on garde pour compat; on le considère aussi comme hash)
    securityCode: {
      type: String,
      required: function () {
        return !this.internalImported;
      },
      select: false,
      default: null,
    },

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
      index: true,
    },

    initiatedBy: { type: String, enum: ["user", "system", "admin", "job", null], default: "user" },
    context: { type: String, default: null, index: true },
    contextId: { type: String, default: null, index: true },

    destination: {
      type: String,
      required: function () {
        return !this.internalImported;
      },
      enum: ["paynoval", "stripe", "bank", "mobilemoney", "visa_direct", "stripe2momo", "cashin", "cashout"],
      default: "paynoval",
    },
    funds: {
      type: String,
      required: function () {
        return !this.internalImported;
      },
      enum: ["paynoval", "stripe", "bank", "mobilemoney", "visa_direct", "stripe2momo", "cashin", "cashout"],
      default: "paynoval",
    },

    status: {
      type: String,
      enum: ["pending", "pending_review", "confirmed", "cancelled", "refunded", "relaunch", "locked"],
      default: "pending",
      index: true,
    },

    verificationToken: {
      type: String,
      unique: true,
      select: false,
      default: null,
      sparse: true,
    },

    confirmedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },

    description: { type: String, default: null },
    orderId: { type: String, default: null },

    // legacy field
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
    amlStatus: { type: String, default: null },

    referralSnapshot: { type: Object, default: null },

    // ✅ FORMAT STANDARD UNIQUE
    amountSource: { type: mongoose.Schema.Types.Decimal128, default: null },
    amountTarget: { type: mongoose.Schema.Types.Decimal128, default: null },
    feeSource: { type: mongoose.Schema.Types.Decimal128, default: null },
    fxRateSourceToTarget: { type: mongoose.Schema.Types.Decimal128, default: null },
    currencySource: { type: String, default: null, trim: true, maxlength: 4 },
    currencyTarget: { type: String, default: null, trim: true, maxlength: 4 },

    money: { type: mongoose.Schema.Types.Mixed, default: null },

    // -----------------------------
    // ✅ Champs utiles pour IMPORT
    // -----------------------------
    provider: { type: String, default: null, trim: true, index: true }, // ex: paynoval
    operator: { type: String, default: null, trim: true, index: true }, // ex: cagnotte / fees
    currency: { type: String, default: null, trim: true, maxlength: 4 }, // pour import simple
    meta: { type: mongoose.Schema.Types.Mixed, default: null }, // pour import simple
  },
  { versionKey: false, timestamps: true }
);

// ✅ Indexes list
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ sender: 1, createdAt: -1 });
transactionSchema.index({ receiver: 1, status: 1 });
transactionSchema.index({ verificationToken: 1 });

// ✅ Idempotency keys (PNV classique)
transactionSchema.index({ sender: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

// ✅ IMPORTANT: Idempotence import (owner + reference)
transactionSchema.index({ userId: 1, reference: 1 }, { unique: true, sparse: true });

// ✅ Optionnel : idempotencyKey aussi par owner si tu l’utilises côté import
transactionSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

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
  // token
  if (this.isNew && !this.verificationToken) {
    this.verificationToken = crypto.randomBytes(32).toString("hex");
  }

  // normalize currency (import)
  if (this.currency != null) {
    const c = normCurrency(this.currency);
    this.currency = c;
  }

  // si import: harmoniser quelques champs legacy pour l’affichage
  if (this.internalImported) {
    // owner fallback
    if (!this.userId && this.sender) this.userId = this.sender;

    const cur = normCurrency(this.currency) || normCurrency(this.currencySource) || normCurrency(this.senderCurrencySymbol);
    if (cur) {
      if (!this.senderCurrencySymbol) this.senderCurrencySymbol = cur;
      if (!this.localCurrencySymbol) this.localCurrencySymbol = cur;
      if (!this.currencySource) this.currencySource = cur;
      if (!this.currencyTarget) this.currencyTarget = cur;
    }

    // netAmount par défaut = amount si pas fourni
    if (this.netAmount == null) {
      try {
        this.netAmount = mongoose.Types.Decimal128.fromString(String(this.amount || "0.00"));
      } catch (_) {}
    }
  }

  // garantir meta object si fourni
  if (this.meta != null && !isPlainObject(this.meta)) this.meta = null;

  next();
});

module.exports = (conn = mongoose) => conn.models.Transaction || conn.model("Transaction", transactionSchema);
