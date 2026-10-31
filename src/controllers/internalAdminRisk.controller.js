"use strict";

const mongoose = require("mongoose");

const { getTxConn } = require("../config/db");
const { recordOperatorDecision } = require("../services/risk/stepUpReview");
const { TYPES, normalizeFor } = require("../services/risk/normalizeIdentifiers");

const runs = () => require("../models/ReconciliationRun")(getTxConn());
const reviewCases = () => require("../models/TransactionReviewCase")(getTxConn());
const blacklist = () => require("../models/AmlBlacklistEntry")(getTxConn());

const JOBS_LIMIT = 20;

/** Live screening reads a cached list: a change must reach it at once. */
const refreshScreening = () => require("../services/risk").invalidateBlacklist();

const page = (req) => Math.max(parseInt(req.query.page, 10) || 1, 1);
const limit = (req) => Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);

/**
 * Latest result of each reconciliation job. Failing closed: an unreadable store
 * answers 503, because an empty list would read as "no discrepancy".
 */
exports.latestReconciliation = async (_req, res) => {
  try {
    const items = await runs()
      .find({ status: { $ne: "running" } })
      .sort({ startedAt: -1 })
      .limit(JOBS_LIMIT)
      .lean();

    const latest = new Map();
    for (const run of items) if (!latest.has(run.job)) latest.set(run.job, run);

    res.json({ success: true, data: [...latest.values()], readAt: new Date() });
  } catch (err) {
    res.status(503).json({ success: false, code: "RECONCILIATION_UNAVAILABLE", error: err.message });
  }
};

exports.listReviewCases = async (req, res) => {
  const filter = { mode: "live" };
  if (req.query.status) filter.status = String(req.query.status);

  const skip = (page(req) - 1) * limit(req);
  const [items, total] = await Promise.all([
    reviewCases().find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit(req)).lean(),
    reviewCases().countDocuments(filter),
  ]);

  res.json({ success: true, data: items, total, page: page(req), limit: limit(req) });
};

exports.decideReviewCase = async (req, res) => {
  const { decision, operatorId, note } = req.body || {};
  const result = await recordOperatorDecision({
    transactionId: req.params.transactionId,
    decision,
    operatorId,
    note,
    ReviewCase: reviewCases(),
  });

  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  if (!result.changed) {
    return res.status(409).json({ success: false, error: "Ce dossier est déjà tranché." });
  }
  res.json({ success: true });
};

exports.listBlacklist = async (req, res) => {
  const filter = req.query.active === "false" ? {} : { active: true };
  const skip = (page(req) - 1) * limit(req);

  const [items, total] = await Promise.all([
    blacklist().find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit(req)).lean(),
    blacklist().countDocuments(filter),
  ]);

  res.json({ success: true, data: items, total, types: TYPES, page: page(req), limit: limit(req) });
};

exports.addBlacklistEntry = async (req, res) => {
  const { type, value, reason, addedBy, expiresAt } = req.body || {};

  if (!TYPES.includes(type)) return res.status(400).json({ success: false, error: "Type inconnu." });

  const normalized = normalizeFor(type, value);
  if (!normalized) return res.status(400).json({ success: false, error: "Valeur invalide." });
  if (String(reason || "").trim().length < 10 || !addedBy) {
    return res.status(400).json({ success: false, error: "Motif et auteur obligatoires." });
  }

  const entry = await blacklist().create({
    type,
    value: normalized,
    reason: String(reason).trim(),
    addedBy: String(addedBy),
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  });

  await refreshScreening();
  res.status(201).json({ success: true, data: entry });
};

/** Entries are deactivated, never deleted: past decisions stay explainable. */
exports.deactivateBlacklistEntry = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, error: "ID invalide." });
  }

  const entry = await blacklist().findByIdAndUpdate(req.params.id, { $set: { active: false } }, { new: true }).lean();
  if (!entry) return res.status(404).json({ success: false, error: "Entrée introuvable." });
  await refreshScreening();
  res.json({ success: true, data: entry });
};
