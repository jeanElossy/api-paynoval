// File: src/services/transactions/shared/autoCancelPolicy.js
"use strict";

const DEFAULT_AUTO_CANCEL_DAYS = 7;

const FINAL_STATUSES = new Set([
  "confirmed",
  "completed",
  "success",
  "successful",
  "validated",
  "cancelled",
  "canceled",
  "failed",
  "refunded",
  "reversed",
]);

const AUTO_CANCELLABLE_STATUSES = new Set([
  "pending",
  "pendingreview",
  "pending_review",
  "pendingvalidation",
  "pending_validation",
  "initiated",
  "awaiting_validation",
  "awaiting_confirmation",
  "processing",
]);

function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .replace(/\s+/g, "_")
    .toLowerCase();
}

function getAutoCancelAfterDays() {
  const raw = Number(
    process.env.TX_AUTO_CANCEL_AFTER_DAYS || DEFAULT_AUTO_CANCEL_DAYS
  );

  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_AUTO_CANCEL_DAYS;
  }

  return Math.max(1, Math.floor(raw));
}

function buildAutoCancelAt(fromDate = new Date()) {
  const base = fromDate instanceof Date ? fromDate : new Date();
  const days = getAutoCancelAfterDays();

  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

function isFinalTransactionStatus(status) {
  return FINAL_STATUSES.has(normalizeStatus(status));
}

function isAutoCancellableStatus(status) {
  return AUTO_CANCELLABLE_STATUSES.has(normalizeStatus(status));
}

function buildAutoCancelFields(status = "pending") {
  if (!isAutoCancellableStatus(status)) {
    return {
      autoCancelAt: null,
      autoCancelledAt: null,
      autoCancelReason: "",
      autoCancelLockAt: null,
      autoCancelWorkerId: "",
      lastAutoCancelError: "",
    };
  }

  return {
    autoCancelAt: buildAutoCancelAt(),
    autoCancelledAt: null,
    autoCancelReason: "",
    autoCancelLockAt: null,
    autoCancelWorkerId: "",
    lastAutoCancelError: "",
  };
}

function getAutoCancelReason() {
  return `Transaction annulée automatiquement après ${String(
    getAutoCancelAfterDays()
  ).padStart(2, "0")} jours sans validation.`;
}

module.exports = {
  FINAL_STATUSES,
  AUTO_CANCELLABLE_STATUSES,
  normalizeStatus,
  getAutoCancelAfterDays,
  buildAutoCancelAt,
  buildAutoCancelFields,
  isFinalTransactionStatus,
  isAutoCancellableStatus,
  getAutoCancelReason,
};