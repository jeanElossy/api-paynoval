"use strict";

const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    type: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    title: {
      type: String,
      trim: true,
      maxlength: 160,
      default: "",
    },

    message: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },

    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    channels: {
      type: [String],
      default: ["in_app"],
    },

    read: {
      type: Boolean,
      default: false,
      index: true,
    },

    readAt: {
      type: Date,
      default: null,
    },

    date: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

notificationSchema.index({ recipient: 1, createdAt: -1 }, { name: "notif_recipient_createdAt" });
notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 }, { name: "notif_recipient_read_createdAt" });
notificationSchema.index({ type: 1, createdAt: -1 }, { name: "notif_type_createdAt" });

module.exports = (conn = mongoose) =>
  conn.models.Notification || conn.model("Notification", notificationSchema);