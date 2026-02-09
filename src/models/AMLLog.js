// File: models/AMLLog.js
"use strict";

const mongoose = require("mongoose");

const AMLLogSchema = new mongoose.Schema(
  {
    userId:        { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
    type:          { type: String, enum: ["initiate", "confirm", "cancel"], required: true },
    provider:      { type: String, required: true },
    amount:        { type: Number, required: true },
    currency:      { type: String, default: null }, // ISO recommandé (XOF, EUR, USD...)
    toEmail:       { type: String, default: "" },
    details:       { type: Object, default: null },

    flagged:       { type: Boolean, default: false },
    flagReason:    { type: String, default: "" },

    reviewed:      { type: Boolean, default: false },
    reviewedBy:    { type: String, default: null },
    reviewComment: { type: String, default: null },

    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null },
    ip:            { type: String, default: null },

    loggedAt:      { type: Date, default: Date.now },
  },
  { timestamps: true }
);

AMLLogSchema.index({ userId: 1, createdAt: -1 });
AMLLogSchema.index({ flagged: 1, createdAt: -1 });
AMLLogSchema.index({ provider: 1, createdAt: -1 });

module.exports = mongoose.models.AMLLog || mongoose.model("AMLLog", AMLLogSchema);
