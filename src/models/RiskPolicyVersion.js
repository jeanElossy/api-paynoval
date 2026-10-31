"use strict";

const mongoose = require("mongoose");

const actor = new mongoose.Schema(
  { staffId: String, email: String, role: String, at: Date },
  { _id: false }
);

/**
 * One version of the tunable risk rules. Content never changes after creation:
 * a past decision stays explainable by the version that produced it, like
 * `LimitPolicyVersion`.
 */
const schema = new mongoose.Schema(
  {
    version: { type: Number, required: true, immutable: true },
    status: {
      type: String,
      enum: ["proposed", "active", "superseded", "rejected"],
      required: true,
    },
    review: { type: Number, required: true, immutable: true },
    weights: { type: mongoose.Schema.Types.Mixed, default: {}, immutable: true },
    reason: { type: String, required: true, maxlength: 1000, immutable: true },
    proposedBy: { type: actor, required: true, immutable: true },
    approvedBy: { type: actor, default: null },
    rejectedBy: { type: actor, default: null },
    rejectionReason: { type: String, default: null, maxlength: 1000 },
    activatedAt: { type: Date, default: null },
    supersededAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "risk_policy_versions" }
);

schema.index({ version: 1 }, { unique: true });
schema.index(
  { status: 1 },
  { unique: true, partialFilterExpression: { status: "active" }, name: "uniq_active_risk_policy" }
);

module.exports = (conn = mongoose) =>
  conn.models.RiskPolicyVersion || conn.model("RiskPolicyVersion", schema);
