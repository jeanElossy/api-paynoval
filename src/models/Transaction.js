// "use strict";

// const mongoose = require("mongoose");
// const crypto = require("crypto");

// function isPlainObject(v) {
//   return v && typeof v === "object" && !Array.isArray(v);
// }

// function normCurrency(v) {
//   const s = String(v || "").trim().toUpperCase();
//   if (!s) return null;
//   if (s.length < 3 || s.length > 4) return null;
//   return s;
// }

// function decToNumber(v) {
//   if (v == null) return v;
//   try {
//     return parseFloat(v.toString());
//   } catch {
//     return v;
//   }
// }

// function normalizeMixedObject(v) {
//   return isPlainObject(v) ? v : null;
// }

// const FLOWS = [
//   "PAYNOVAL_INTERNAL_TRANSFER",
//   "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
//   "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
//   "BANK_TRANSFER_TO_PAYNOVAL",
//   "PAYNOVAL_TO_BANK_PAYOUT",
//   "CARD_TOPUP_TO_PAYNOVAL",
//   "PAYNOVAL_TO_CARD_PAYOUT",
//   "UNKNOWN_FLOW",
//   null,
// ];

// const RAILS = [
//   "paynoval",
//   "stripe",
//   "bank",
//   "mobilemoney",
//   "visa_direct",
//   "stripe2momo",
//   "cashin",
//   "cashout",
//   null,
// ];

// const STATUSES = [
//   "created",
//   "pending",
//   "pending_review",
//   "processing",
//   "confirmed",
//   "cancelled",
//   "refunded",
//   "relaunch",
//   "locked",
//   "failed",
// ];

// const OPERATION_KINDS = [
//   "transfer",
//   "bonus",
//   "cashback",
//   "purchase",
//   "adjustment_credit",
//   "adjustment_debit",
//   "cagnotte_participation",
//   "cagnotte_withdrawal",
//   "generic",
//   null,
// ];

// function isInternalFlow(flow) {
//   return flow === "PAYNOVAL_INTERNAL_TRANSFER";
// }

// function isOutboundPayoutFlow(flow) {
//   return [
//     "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
//     "PAYNOVAL_TO_BANK_PAYOUT",
//     "PAYNOVAL_TO_CARD_PAYOUT",
//   ].includes(flow);
// }

// function isInboundCollectionFlow(flow) {
//   return [
//     "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
//     "BANK_TRANSFER_TO_PAYNOVAL",
//     "CARD_TOPUP_TO_PAYNOVAL",
//   ].includes(flow);
// }

// function requiresLocalSender(flow) {
//   return isInternalFlow(flow) || isOutboundPayoutFlow(flow);
// }

// function requiresLocalReceiver(flow) {
//   return isInternalFlow(flow) || isInboundCollectionFlow(flow);
// }

// function requiresSecurityChallenge(flow) {
//   return isInternalFlow(flow) || isOutboundPayoutFlow(flow);
// }

// const transactionSchema = new mongoose.Schema(
//   {
//     userId: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "User",
//       default: null,
//       index: true,
//     },

//     internalImported: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     reference: {
//       type: String,
//       required: true,
//       trim: true,
//       index: true,
//     },

//     idempotencyKey: {
//       type: String,
//       default: undefined,
//       trim: true,
//     },

//     verificationToken: {
//       type: String,
//       unique: true,
//       select: false,
//       default: null,
//       sparse: true,
//     },

//     flow: {
//       type: String,
//       enum: FLOWS,
//       default: "PAYNOVAL_INTERNAL_TRANSFER",
//       index: true,
//     },

//     operationKind: {
//       type: String,
//       enum: OPERATION_KINDS,
//       default: "transfer",
//       index: true,
//     },

//     initiatedBy: {
//       type: String,
//       enum: ["user", "system", "admin", "job", null],
//       default: "user",
//       index: true,
//     },

//     context: {
//       type: String,
//       default: null,
//       index: true,
//     },

//     contextId: {
//       type: String,
//       default: null,
//       index: true,
//     },

//     sender: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "User",
//       required: function () {
//         return !this.internalImported && requiresLocalSender(this.flow);
//       },
//       default: null,
//       index: true,
//     },

//     receiver: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "User",
//       required: function () {
//         return !this.internalImported && requiresLocalReceiver(this.flow);
//       },
//       default: null,
//       index: true,
//     },

//     senderName: {
//       type: String,
//       trim: true,
//       maxlength: 100,
//       default: null,
//     },

//     senderEmail: {
//       type: String,
//       trim: true,
//       lowercase: true,
//       maxlength: 100,
//       match: /.+@.+\..+/,
//       default: null,
//     },

//     nameDestinataire: {
//       type: String,
//       trim: true,
//       maxlength: 100,
//       default: null,
//     },

//     recipientEmail: {
//       type: String,
//       trim: true,
//       lowercase: true,
//       match: /.+@.+\..+/,
//       default: null,
//     },

//     destination: {
//       type: String,
//       enum: RAILS,
//       default: "paynoval",
//       index: true,
//     },

//     funds: {
//       type: String,
//       enum: RAILS,
//       default: "paynoval",
//       index: true,
//     },

//     provider: {
//       type: String,
//       default: null,
//       trim: true,
//       index: true,
//     },

//     operator: {
//       type: String,
//       default: null,
//       trim: true,
//       index: true,
//     },

//     country: {
//       type: String,
//       trim: true,
//       maxlength: 100,
//       default: null,
//       index: true,
//     },

//     amount: {
//       type: mongoose.Schema.Types.Decimal128,
//       required: true,
//       validate: {
//         validator: (v) => parseFloat(v.toString()) >= 0.01,
//         message: (props) => `Le montant doit être ≥ 0.01, reçu ${props.value}`,
//       },
//     },

//     transactionFees: {
//       type: mongoose.Schema.Types.Decimal128,
//       default: mongoose.Types.Decimal128.fromString("0.00"),
//       validate: {
//         validator: (v) => parseFloat(v.toString()) >= 0,
//         message: (props) => `Les frais doivent être ≥ 0.00, reçus ${props.value}`,
//       },
//     },

//     netAmount: {
//       type: mongoose.Schema.Types.Decimal128,
//       default: mongoose.Types.Decimal128.fromString("0.00"),
//       validate: {
//         validator: (v) => parseFloat(v.toString()) >= 0,
//         message: (props) => `Le net doit être ≥ 0.00, reçu ${props.value}`,
//       },
//     },

//     exchangeRate: {
//       type: mongoose.Schema.Types.Decimal128,
//       default: mongoose.Types.Decimal128.fromString("1.00"),
//     },

//     localAmount: {
//       type: mongoose.Schema.Types.Decimal128,
//       default: mongoose.Types.Decimal128.fromString("0.00"),
//     },

//     senderCurrencySymbol: {
//       type: String,
//       trim: true,
//       maxlength: 4,
//       default: null,
//     },

//     localCurrencySymbol: {
//       type: String,
//       trim: true,
//       maxlength: 4,
//       default: null,
//     },

//     currency: {
//       type: String,
//       default: null,
//       trim: true,
//       maxlength: 4,
//       index: true,
//     },

//     amountSource: {
//       type: mongoose.Schema.Types.Decimal128,
//       default: null,
//     },

//     amountTarget: {
//       type: mongoose.Schema.Types.Decimal128,
//       default: null,
//     },

//     feeSource: {
//       type: mongoose.Schema.Types.Decimal128,
//       default: null,
//     },

//     fxRateSourceToTarget: {
//       type: mongoose.Schema.Types.Decimal128,
//       default: null,
//     },

//     currencySource: {
//       type: String,
//       default: null,
//       trim: true,
//       maxlength: 4,
//       index: true,
//     },

//     currencyTarget: {
//       type: String,
//       default: null,
//       trim: true,
//       maxlength: 4,
//       index: true,
//     },

//     money: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },

//     pricingSnapshot: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },

//     pricingRuleApplied: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },

//     pricingFxRuleApplied: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },

//     feeSnapshot: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },

//     feeActual: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },

//     feeId: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },

//     treasuryRevenue: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },

//     treasuryRevenueCredited: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     treasuryRevenueCreditedAt: {
//       type: Date,
//       default: null,
//     },

//     treasuryUserId: {
//       type: String,
//       default: null,
//       trim: true,
//       index: true,
//     },

//     treasurySystemType: {
//       type: String,
//       default: null,
//       trim: true,
//       index: true,
//     },

//     treasuryLabel: {
//       type: String,
//       default: null,
//       trim: true,
//     },

//     securityQuestion: {
//       type: String,
//       trim: true,
//       maxlength: 200,
//       default: null,
//     },

//     securityAnswerHash: {
//       type: String,
//       select: false,
//       default: null,
//     },

//     securityCode: {
//       type: String,
//       select: false,
//       default: null,
//     },

//     attemptCount: {
//       type: Number,
//       default: 0,
//     },

//     lastAttemptAt: {
//       type: Date,
//       default: null,
//     },

//     lockedUntil: {
//       type: Date,
//       default: null,
//     },

//     amlSnapshot: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },

//     amlStatus: {
//       type: String,
//       default: null,
//       index: true,
//     },

//     referralSnapshot: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },

//     metadata: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },

//     meta: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },

//     description: {
//       type: String,
//       default: null,
//     },

//     orderId: {
//       type: String,
//       default: null,
//       index: true,
//     },

//     status: {
//       type: String,
//       enum: STATUSES,
//       default: "pending",
//       index: true,
//     },

//     confirmedAt: {
//       type: Date,
//       default: null,
//     },

//     cancelledAt: {
//       type: Date,
//       default: null,
//     },

//     cancelReason: {
//       type: String,
//       default: null,
//     },

//     refundedAt: {
//       type: Date,
//       default: null,
//     },

//     refundReason: {
//       type: String,
//       default: null,
//     },

//     validatedAt: {
//       type: Date,
//       default: null,
//     },

//     adminNote: {
//       type: String,
//       default: null,
//     },

//     reassignedAt: {
//       type: Date,
//       default: null,
//     },

//     archived: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     archivedAt: {
//       type: Date,
//       default: null,
//     },

//     archivedBy: {
//       type: String,
//       default: null,
//     },

//     relaunchedAt: {
//       type: Date,
//       default: null,
//     },

//     relaunchedBy: {
//       type: String,
//       default: null,
//     },

//     relaunchCount: {
//       type: Number,
//       default: 0,
//     },

//     cancellationFee: {
//       type: Number,
//       default: 0,
//     },

//     cancellationFeeType: {
//       type: String,
//       enum: ["fixed", "percent"],
//       default: "fixed",
//     },

//     cancellationFeePercent: {
//       type: Number,
//       default: 0,
//     },

//     cancellationFeeId: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "Fee",
//       default: null,
//     },

//     fundsReserved: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     fundsReservedAt: {
//       type: Date,
//       default: null,
//     },

//     fundsCaptured: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     fundsCapturedAt: {
//       type: Date,
//       default: null,
//     },

//     beneficiaryCredited: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     beneficiaryCreditedAt: {
//       type: Date,
//       default: null,
//     },

//     reserveReleased: {
//       type: Boolean,
//       default: false,
//       index: true,
//     },

//     reserveReleasedAt: {
//       type: Date,
//       default: null,
//     },

//     reversedAt: {
//       type: Date,
//       default: null,
//     },

//     providerReference: {
//       type: String,
//       default: null,
//       trim: true,
//       index: true,
//     },

//     providerStatus: {
//       type: String,
//       default: null,
//       trim: true,
//       index: true,
//     },

//     executedAt: {
//       type: Date,
//       default: null,
//     },

//     webhookHistory: {
//       type: [mongoose.Schema.Types.Mixed],
//       default: [],
//     },

//     failure: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },

//     settlement: {
//       type: mongoose.Schema.Types.Mixed,
//       default: null,
//     },
//   },
//   {
//     versionKey: false,
//     timestamps: true,
//   }
// );

// transactionSchema.index({ userId: 1, createdAt: -1 });
// transactionSchema.index({ sender: 1, createdAt: -1 });
// transactionSchema.index({ receiver: 1, createdAt: -1 });
// transactionSchema.index({ receiver: 1, status: 1 });
// transactionSchema.index({ status: 1, createdAt: -1 });
// transactionSchema.index({ flow: 1, status: 1, createdAt: -1 });
// transactionSchema.index({ provider: 1, providerStatus: 1, createdAt: -1 });
// transactionSchema.index({ providerReference: 1 }, { sparse: true });
// transactionSchema.index({ treasuryRevenueCredited: 1, createdAt: -1 });
// transactionSchema.index(
//   { treasuryUserId: 1, treasurySystemType: 1, createdAt: -1 }
// );
// transactionSchema.index({ archived: 1, createdAt: -1 });

// transactionSchema.index(
//   { sender: 1, idempotencyKey: 1 },
//   {
//     unique: true,
//     partialFilterExpression: {
//       sender: { $exists: true, $ne: null },
//       idempotencyKey: { $exists: true, $type: "string" },
//     },
//   }
// );

// transactionSchema.index(
//   { userId: 1, reference: 1 },
//   {
//     unique: true,
//     partialFilterExpression: {
//       userId: { $exists: true, $ne: null },
//       reference: { $exists: true, $type: "string" },
//     },
//   }
// );

// transactionSchema.index(
//   { userId: 1, idempotencyKey: 1 },
//   {
//     unique: true,
//     partialFilterExpression: {
//       userId: { $exists: true, $ne: null },
//       idempotencyKey: { $exists: true, $type: "string" },
//     },
//   }
// );

// transactionSchema.index(
//   { verificationToken: 1 },
//   {
//     unique: true,
//     partialFilterExpression: {
//       verificationToken: { $exists: true, $type: "string" },
//     },
//   }
// );

// transactionSchema.set("toJSON", {
//   transform(_doc, ret) {
//     ret.id = ret._id;

//     ret.amount = decToNumber(ret.amount);
//     ret.transactionFees = decToNumber(ret.transactionFees);
//     ret.netAmount = decToNumber(ret.netAmount);
//     ret.exchangeRate = decToNumber(ret.exchangeRate);
//     ret.localAmount = decToNumber(ret.localAmount);

//     ret.amountSource = decToNumber(ret.amountSource);
//     ret.amountTarget = decToNumber(ret.amountTarget);
//     ret.feeSource = decToNumber(ret.feeSource);
//     ret.fxRateSourceToTarget = decToNumber(ret.fxRateSourceToTarget);

//     if (ret.money && typeof ret.money === "object") {
//       const m = { ...ret.money };
//       if (m.source?.amount != null) m.source.amount = Number(m.source.amount);
//       if (m.feeSource?.amount != null)
//         m.feeSource.amount = Number(m.feeSource.amount);
//       if (m.target?.amount != null) m.target.amount = Number(m.target.amount);
//       if (m.fxRateSourceToTarget != null) {
//         m.fxRateSourceToTarget = Number(m.fxRateSourceToTarget);
//       }
//       ret.money = m;
//     }

//     delete ret._id;
//     delete ret.securityCode;
//     delete ret.securityAnswerHash;
//     delete ret.verificationToken;
//     delete ret.attemptCount;
//     delete ret.lastAttemptAt;
//     delete ret.lockedUntil;

//     return ret;
//   },
// });

// transactionSchema.pre("validate", function (next) {
//   const systemReferralTx =
//     this.initiatedBy === "system" ||
//     this.context === "referral_bonus" ||
//     this.type === "referral_bonus" ||
//     this.operationKind === "bonus";

//   const mustHaveVerificationToken =
//     requiresSecurityChallenge(this.flow) &&
//     !this.internalImported &&
//     !systemReferralTx;

//   if (this.isNew) {
//     if (mustHaveVerificationToken) {
//       if (!this.verificationToken) {
//         this.verificationToken = crypto.randomBytes(32).toString("hex");
//       }
//     } else {
//       this.verificationToken = undefined;
//     }
//   } else if (!mustHaveVerificationToken) {
//     this.verificationToken = undefined;
//   }

//   if (typeof this.reference === "string") {
//     const trimmedRef = this.reference.trim();
//     if (trimmedRef) this.reference = trimmedRef;
//   }

//   if (typeof this.idempotencyKey === "string") {
//     const trimmed = this.idempotencyKey.trim();
//     this.idempotencyKey = trimmed || undefined;
//   } else if (this.idempotencyKey == null) {
//     this.idempotencyKey = undefined;
//   }

//   if (this.currency != null) this.currency = normCurrency(this.currency);
//   if (this.currencySource != null)
//     this.currencySource = normCurrency(this.currencySource);
//   if (this.currencyTarget != null)
//     this.currencyTarget = normCurrency(this.currencyTarget);
//   if (this.senderCurrencySymbol != null)
//     this.senderCurrencySymbol = normCurrency(this.senderCurrencySymbol);
//   if (this.localCurrencySymbol != null)
//     this.localCurrencySymbol = normCurrency(this.localCurrencySymbol);

//   if (typeof this.treasurySystemType === "string") {
//     const t = this.treasurySystemType.trim().toUpperCase();
//     this.treasurySystemType = t || null;
//   }

//   if (typeof this.treasuryUserId === "string") {
//     const t = this.treasuryUserId.trim();
//     this.treasuryUserId = t || null;
//   }

//   if (typeof this.treasuryLabel === "string") {
//     const t = this.treasuryLabel.trim();
//     this.treasuryLabel = t || null;
//   }

//   if (this.internalImported) {
//     if (!this.userId && this.sender) this.userId = this.sender;

//     const cur =
//       normCurrency(this.currency) ||
//       normCurrency(this.currencySource) ||
//       normCurrency(this.senderCurrencySymbol);

//     if (cur) {
//       if (!this.senderCurrencySymbol) this.senderCurrencySymbol = cur;
//       if (!this.localCurrencySymbol) this.localCurrencySymbol = cur;
//       if (!this.currencySource) this.currencySource = cur;
//       if (!this.currencyTarget) this.currencyTarget = cur;
//     }

//     if (this.netAmount == null) {
//       try {
//         this.netAmount = mongoose.Types.Decimal128.fromString(
//           String(this.amount || "0.00")
//         );
//       } catch {}
//     }
//   }

//   if (!requiresSecurityChallenge(this.flow) || systemReferralTx) {
//     this.securityQuestion = null;
//     this.securityAnswerHash = null;
//     this.securityCode = null;
//   }

//   this.metadata = normalizeMixedObject(this.metadata);
//   this.meta = normalizeMixedObject(this.meta);
//   this.pricingSnapshot = normalizeMixedObject(this.pricingSnapshot);
//   this.treasuryRevenue = normalizeMixedObject(this.treasuryRevenue);
//   this.amlSnapshot = normalizeMixedObject(this.amlSnapshot);
//   this.referralSnapshot = normalizeMixedObject(this.referralSnapshot);
//   this.feeSnapshot = normalizeMixedObject(this.feeSnapshot);
//   this.feeActual = normalizeMixedObject(this.feeActual);
//   this.money = isPlainObject(this.money) ? this.money : null;
//   this.failure = normalizeMixedObject(this.failure);
//   this.settlement = normalizeMixedObject(this.settlement);

//   next();
// });

// transactionSchema.virtual("isPending").get(function () {
//   return this.status === "pending" || this.status === "pending_review";
// });

// transactionSchema.virtual("isFinal").get(function () {
//   return ["confirmed", "cancelled", "refunded", "failed"].includes(this.status);
// });

// transactionSchema.virtual("hasPricingSnapshot").get(function () {
//   return !!this.pricingSnapshot && typeof this.pricingSnapshot === "object";
// });

// module.exports = (conn = mongoose) =>
//   conn.models.Transaction || conn.model("Transaction", transactionSchema);











"use strict";

const mongoose = require("mongoose");
const crypto = require("crypto");

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function normCurrency(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return null;
  if (s.length < 3 || s.length > 4) return null;
  return s;
}

function decToNumber(v) {
  if (v == null) return v;
  try {
    return parseFloat(v.toString());
  } catch {
    return v;
  }
}

function normalizeMixedObject(v) {
  return isPlainObject(v) ? v : null;
}

const FLOWS = [
  "PAYNOVAL_INTERNAL_TRANSFER",
  "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
  "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
  "BANK_TRANSFER_TO_PAYNOVAL",
  "PAYNOVAL_TO_BANK_PAYOUT",
  "CARD_TOPUP_TO_PAYNOVAL",
  "PAYNOVAL_TO_CARD_PAYOUT",
  "UNKNOWN_FLOW",
  null,
];

const RAILS = [
  "paynoval",
  "stripe",
  "bank",
  "mobilemoney",
  "visa_direct",
  "stripe2momo",
  "cashin",
  "cashout",
  null,
];

const STATUSES = [
  "created",
  "pending",
  "pending_review",
  "processing",
  "confirmed",
  "cancelled",
  "refunded",
  "relaunch",
  "locked",
  "failed",
];

const OPERATION_KINDS = [
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
];

function isInternalFlow(flow) {
  return flow === "PAYNOVAL_INTERNAL_TRANSFER";
}

function isOutboundPayoutFlow(flow) {
  return [
    "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",
    "PAYNOVAL_TO_BANK_PAYOUT",
    "PAYNOVAL_TO_CARD_PAYOUT",
  ].includes(flow);
}

function isInboundCollectionFlow(flow) {
  return [
    "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
    "BANK_TRANSFER_TO_PAYNOVAL",
    "CARD_TOPUP_TO_PAYNOVAL",
  ].includes(flow);
}

function requiresLocalSender(flow) {
  return isInternalFlow(flow) || isOutboundPayoutFlow(flow);
}

function requiresLocalReceiver(flow) {
  return isInternalFlow(flow) || isInboundCollectionFlow(flow);
}

function requiresSecurityChallenge(flow) {
  return isInternalFlow(flow) || isOutboundPayoutFlow(flow);
}

const transactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    internalImported: {
      type: Boolean,
      default: false,
      index: true,
    },

    reference: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    idempotencyKey: {
      type: String,
      default: undefined,
      trim: true,
    },

    verificationToken: {
      type: String,
      unique: true,
      select: false,
      default: null,
      sparse: true,
    },

    flow: {
      type: String,
      enum: FLOWS,
      default: "PAYNOVAL_INTERNAL_TRANSFER",
      index: true,
    },

    operationKind: {
      type: String,
      enum: OPERATION_KINDS,
      default: "transfer",
      index: true,
    },

    initiatedBy: {
      type: String,
      enum: ["user", "system", "admin", "job", null],
      default: "user",
      index: true,
    },

    context: {
      type: String,
      default: null,
      index: true,
    },

    contextId: {
      type: String,
      default: null,
      index: true,
    },

    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: function () {
        return !this.internalImported && requiresLocalSender(this.flow);
      },
      default: null,
      index: true,
    },

    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: function () {
        return !this.internalImported && requiresLocalReceiver(this.flow);
      },
      default: null,
      index: true,
    },

    senderName: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },

    senderEmail: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 100,
      match: /.+@.+\..+/,
      default: null,
    },

    nameDestinataire: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },

    recipientEmail: {
      type: String,
      trim: true,
      lowercase: true,
      match: /.+@.+\..+/,
      default: null,
    },

    destination: {
      type: String,
      enum: RAILS,
      default: "paynoval",
      index: true,
    },

    funds: {
      type: String,
      enum: RAILS,
      default: "paynoval",
      index: true,
    },

    provider: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    operator: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    country: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
      index: true,
    },

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
      default: mongoose.Types.Decimal128.fromString("0.00"),
      validate: {
        validator: (v) => parseFloat(v.toString()) >= 0,
        message: (props) =>
          `Les frais doivent être ≥ 0.00, reçus ${props.value}`,
      },
    },

    netAmount: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString("0.00"),
      validate: {
        validator: (v) => parseFloat(v.toString()) >= 0,
        message: (props) => `Le net doit être ≥ 0.00, reçu ${props.value}`,
      },
    },

    exchangeRate: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString("1.00"),
    },

    localAmount: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString("0.00"),
    },

    senderCurrencySymbol: {
      type: String,
      trim: true,
      maxlength: 4,
      default: null,
    },

    localCurrencySymbol: {
      type: String,
      trim: true,
      maxlength: 4,
      default: null,
    },

    currency: {
      type: String,
      default: null,
      trim: true,
      maxlength: 4,
      index: true,
    },

    amountSource: {
      type: mongoose.Schema.Types.Decimal128,
      default: null,
    },

    amountTarget: {
      type: mongoose.Schema.Types.Decimal128,
      default: null,
    },

    feeSource: {
      type: mongoose.Schema.Types.Decimal128,
      default: null,
    },

    fxRateSourceToTarget: {
      type: mongoose.Schema.Types.Decimal128,
      default: null,
    },

    currencySource: {
      type: String,
      default: null,
      trim: true,
      maxlength: 4,
      index: true,
    },

    currencyTarget: {
      type: String,
      default: null,
      trim: true,
      maxlength: 4,
      index: true,
    },

    money: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    pricingSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    pricingRuleApplied: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    pricingFxRuleApplied: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    feeSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    feeActual: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    feeId: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    treasuryRevenue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    treasuryRevenueCredited: {
      type: Boolean,
      default: false,
      index: true,
    },

    treasuryRevenueCreditedAt: {
      type: Date,
      default: null,
    },

    treasuryUserId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    treasurySystemType: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    treasuryLabel: {
      type: String,
      default: null,
      trim: true,
    },

    securityQuestion: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },

    securityAnswerHash: {
      type: String,
      select: false,
      default: null,
    },

    securityCode: {
      type: String,
      select: false,
      default: null,
    },

    attemptCount: {
      type: Number,
      default: 0,
    },

    lastAttemptAt: {
      type: Date,
      default: null,
    },

    lockedUntil: {
      type: Date,
      default: null,
    },

    autoCancelAt: {
      type: Date,
      default: null,
      index: true,
    },

    autoCancelledAt: {
      type: Date,
      default: null,
    },

    autoCancelReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    autoCancelLockAt: {
      type: Date,
      default: null,
      index: true,
    },

    autoCancelWorkerId: {
      type: String,
      default: "",
      trim: true,
      maxlength: 160,
    },

    lastAutoCancelError: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },

    amlSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    amlStatus: {
      type: String,
      default: null,
      index: true,
    },

    referralSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    description: {
      type: String,
      default: null,
    },

    orderId: {
      type: String,
      default: null,
      index: true,
    },

    status: {
      type: String,
      enum: STATUSES,
      default: "pending",
      index: true,
    },

    confirmedAt: {
      type: Date,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancelReason: {
      type: String,
      default: null,
    },

    refundedAt: {
      type: Date,
      default: null,
    },

    refundReason: {
      type: String,
      default: null,
    },

    validatedAt: {
      type: Date,
      default: null,
    },

    adminNote: {
      type: String,
      default: null,
    },

    reassignedAt: {
      type: Date,
      default: null,
    },

    archived: {
      type: Boolean,
      default: false,
      index: true,
    },

    archivedAt: {
      type: Date,
      default: null,
    },

    archivedBy: {
      type: String,
      default: null,
    },

    relaunchedAt: {
      type: Date,
      default: null,
    },

    relaunchedBy: {
      type: String,
      default: null,
    },

    relaunchCount: {
      type: Number,
      default: 0,
    },

    cancellationFee: {
      type: Number,
      default: 0,
    },

    cancellationFeeType: {
      type: String,
      enum: ["fixed", "percent"],
      default: "fixed",
    },

    cancellationFeePercent: {
      type: Number,
      default: 0,
    },

    cancellationFeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Fee",
      default: null,
    },

    fundsReserved: {
      type: Boolean,
      default: false,
      index: true,
    },

    fundsReservedAt: {
      type: Date,
      default: null,
    },

    fundsCaptured: {
      type: Boolean,
      default: false,
      index: true,
    },

    fundsCapturedAt: {
      type: Date,
      default: null,
    },

    beneficiaryCredited: {
      type: Boolean,
      default: false,
      index: true,
    },

    beneficiaryCreditedAt: {
      type: Date,
      default: null,
    },

    reserveReleased: {
      type: Boolean,
      default: false,
      index: true,
    },

    reserveReleasedAt: {
      type: Date,
      default: null,
    },

    reversedAt: {
      type: Date,
      default: null,
    },

    providerReference: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    providerStatus: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    executedAt: {
      type: Date,
      default: null,
    },

    webhookHistory: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },

    failure: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    settlement: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    versionKey: false,
    timestamps: true,
  }
);

transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ sender: 1, createdAt: -1 });
transactionSchema.index({ receiver: 1, createdAt: -1 });
transactionSchema.index({ receiver: 1, status: 1 });
transactionSchema.index({ status: 1, createdAt: -1 });
transactionSchema.index({ flow: 1, status: 1, createdAt: -1 });
transactionSchema.index({ provider: 1, providerStatus: 1, createdAt: -1 });
transactionSchema.index({ providerReference: 1 }, { sparse: true });
transactionSchema.index({ treasuryRevenueCredited: 1, createdAt: -1 });
transactionSchema.index(
  { treasuryUserId: 1, treasurySystemType: 1, createdAt: -1 }
);
transactionSchema.index({ archived: 1, createdAt: -1 });

transactionSchema.index({
  status: 1,
  autoCancelAt: 1,
  autoCancelLockAt: 1,
});

transactionSchema.index({
  autoCancelledAt: 1,
  status: 1,
});

transactionSchema.index(
  { sender: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sender: { $exists: true, $ne: null },
      idempotencyKey: { $exists: true, $type: "string" },
    },
  }
);

transactionSchema.index(
  { userId: 1, reference: 1 },
  {
    unique: true,
    partialFilterExpression: {
      userId: { $exists: true, $ne: null },
      reference: { $exists: true, $type: "string" },
    },
  }
);

transactionSchema.index(
  { userId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      userId: { $exists: true, $ne: null },
      idempotencyKey: { $exists: true, $type: "string" },
    },
  }
);

transactionSchema.index(
  { verificationToken: 1 },
  {
    unique: true,
    partialFilterExpression: {
      verificationToken: { $exists: true, $type: "string" },
    },
  }
);

transactionSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id;

    ret.amount = decToNumber(ret.amount);
    ret.transactionFees = decToNumber(ret.transactionFees);
    ret.netAmount = decToNumber(ret.netAmount);
    ret.exchangeRate = decToNumber(ret.exchangeRate);
    ret.localAmount = decToNumber(ret.localAmount);

    ret.amountSource = decToNumber(ret.amountSource);
    ret.amountTarget = decToNumber(ret.amountTarget);
    ret.feeSource = decToNumber(ret.feeSource);
    ret.fxRateSourceToTarget = decToNumber(ret.fxRateSourceToTarget);

    if (ret.money && typeof ret.money === "object") {
      const m = { ...ret.money };
      if (m.source?.amount != null) m.source.amount = Number(m.source.amount);
      if (m.feeSource?.amount != null) {
        m.feeSource.amount = Number(m.feeSource.amount);
      }
      if (m.target?.amount != null) m.target.amount = Number(m.target.amount);
      if (m.fxRateSourceToTarget != null) {
        m.fxRateSourceToTarget = Number(m.fxRateSourceToTarget);
      }
      ret.money = m;
    }

    delete ret._id;
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
  const systemReferralTx =
    this.initiatedBy === "system" ||
    this.context === "referral_bonus" ||
    this.type === "referral_bonus" ||
    this.operationKind === "bonus";

  const mustHaveVerificationToken =
    requiresSecurityChallenge(this.flow) &&
    !this.internalImported &&
    !systemReferralTx;

  if (this.isNew) {
    if (mustHaveVerificationToken) {
      if (!this.verificationToken) {
        this.verificationToken = crypto.randomBytes(32).toString("hex");
      }
    } else {
      this.verificationToken = undefined;
    }
  } else if (!mustHaveVerificationToken) {
    this.verificationToken = undefined;
  }

  if (typeof this.reference === "string") {
    const trimmedRef = this.reference.trim();
    if (trimmedRef) this.reference = trimmedRef;
  }

  if (typeof this.idempotencyKey === "string") {
    const trimmed = this.idempotencyKey.trim();
    this.idempotencyKey = trimmed || undefined;
  } else if (this.idempotencyKey == null) {
    this.idempotencyKey = undefined;
  }

  if (this.currency != null) this.currency = normCurrency(this.currency);
  if (this.currencySource != null) {
    this.currencySource = normCurrency(this.currencySource);
  }
  if (this.currencyTarget != null) {
    this.currencyTarget = normCurrency(this.currencyTarget);
  }
  if (this.senderCurrencySymbol != null) {
    this.senderCurrencySymbol = normCurrency(this.senderCurrencySymbol);
  }
  if (this.localCurrencySymbol != null) {
    this.localCurrencySymbol = normCurrency(this.localCurrencySymbol);
  }

  if (typeof this.treasurySystemType === "string") {
    const t = this.treasurySystemType.trim().toUpperCase();
    this.treasurySystemType = t || null;
  }

  if (typeof this.treasuryUserId === "string") {
    const t = this.treasuryUserId.trim();
    this.treasuryUserId = t || null;
  }

  if (typeof this.treasuryLabel === "string") {
    const t = this.treasuryLabel.trim();
    this.treasuryLabel = t || null;
  }

  if (this.internalImported) {
    if (!this.userId && this.sender) this.userId = this.sender;

    const cur =
      normCurrency(this.currency) ||
      normCurrency(this.currencySource) ||
      normCurrency(this.senderCurrencySymbol);

    if (cur) {
      if (!this.senderCurrencySymbol) this.senderCurrencySymbol = cur;
      if (!this.localCurrencySymbol) this.localCurrencySymbol = cur;
      if (!this.currencySource) this.currencySource = cur;
      if (!this.currencyTarget) this.currencyTarget = cur;
    }

    if (this.netAmount == null) {
      try {
        this.netAmount = mongoose.Types.Decimal128.fromString(
          String(this.amount || "0.00")
        );
      } catch {}
    }
  }

  if (!requiresSecurityChallenge(this.flow) || systemReferralTx) {
    this.securityQuestion = null;
    this.securityAnswerHash = null;
    this.securityCode = null;
  }

  this.metadata = normalizeMixedObject(this.metadata);
  this.meta = normalizeMixedObject(this.meta);
  this.pricingSnapshot = normalizeMixedObject(this.pricingSnapshot);
  this.treasuryRevenue = normalizeMixedObject(this.treasuryRevenue);
  this.amlSnapshot = normalizeMixedObject(this.amlSnapshot);
  this.referralSnapshot = normalizeMixedObject(this.referralSnapshot);
  this.feeSnapshot = normalizeMixedObject(this.feeSnapshot);
  this.feeActual = normalizeMixedObject(this.feeActual);
  this.money = isPlainObject(this.money) ? this.money : null;
  this.failure = normalizeMixedObject(this.failure);
  this.settlement = normalizeMixedObject(this.settlement);

  next();
});

transactionSchema.virtual("isPending").get(function () {
  return this.status === "pending" || this.status === "pending_review";
});

transactionSchema.virtual("isFinal").get(function () {
  return ["confirmed", "cancelled", "refunded", "failed"].includes(this.status);
});

transactionSchema.virtual("hasPricingSnapshot").get(function () {
  return !!this.pricingSnapshot && typeof this.pricingSnapshot === "object";
});

module.exports = (conn = mongoose) =>
  conn.models.Transaction || conn.model("Transaction", transactionSchema);