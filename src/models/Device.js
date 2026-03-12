"use strict";

const mongoose = require("mongoose");

const osSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 64, default: "" },
    version: { type: String, trim: true, maxlength: 64, default: "" },
  },
  { _id: false }
);

const deviceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      required: true,
    },

    pushToken: {
      type: String,
      trim: true,
      maxlength: 512,
      default: null,
    },

    type: {
      type: String,
      trim: true,
      maxlength: 32,
      default: "phone",
    },

    platform: {
      type: String,
      enum: ["ios", "android", "web", "other"],
      default: "other",
      index: true,
    },

    brand: { type: String, trim: true, maxlength: 64, default: "" },
    model: { type: String, trim: true, maxlength: 128, default: "" },
    os: { type: osSchema, default: () => ({}) },
    appVersion: { type: String, trim: true, maxlength: 64, default: "" },

    status: {
      type: String,
      enum: ["active", "blocked"],
      default: "active",
      index: true,
    },

    trustLevel: {
      type: String,
      enum: ["trusted", "normal", "suspect", "blocked"],
      default: "normal",
      index: true,
    },

    riskScore: { type: Number, min: 0, max: 100, default: 0, index: true },
    riskFlags: [{ type: String, trim: true, maxlength: 64 }],

    lastActive: { type: Date, index: true, default: Date.now },
    lastIP: { type: String, trim: true, maxlength: 128, default: "" },
    lastCountry: { type: String, trim: true, maxlength: 8, default: "" },

    fingerprintHash: {
      type: String,
      trim: true,
      maxlength: 256,
      default: null,
      index: true,
    },

    sessionInvalidBefore: { type: Date, default: null },
    notes: { type: String, trim: true, default: "", maxlength: 2000 },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret.__v;
        return ret;
      },
    },
  }
);

deviceSchema.index(
  { user: 1, fingerprintHash: 1 },
  {
    unique: true,
    partialFilterExpression: {
      fingerprintHash: { $type: "string", $ne: "" },
    },
    name: "uniq_user_fingerprint",
  }
);

deviceSchema.index(
  {
    brand: "text",
    model: "text",
    type: "text",
    "os.name": "text",
    appVersion: "text",
    fingerprintHash: "text",
  },
  { name: "device_text_search" }
);

deviceSchema.index(
  { pushToken: 1 },
  {
    unique: true,
    partialFilterExpression: {
      pushToken: { $type: "string", $ne: "" },
    },
    name: "uniq_push_token_string",
  }
);

module.exports = (conn = mongoose) =>
  conn.models.Device || conn.model("Device", deviceSchema);