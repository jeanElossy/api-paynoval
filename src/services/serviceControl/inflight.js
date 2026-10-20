"use strict";

/**
 * Operations still in flight — the "drain" measure of the service-control
 * center (contract §8). NUMBERS ONLY: no transaction, user, amount or
 * reference leaves Tx-Core through this.
 *
 * Live mode only: simulation traffic never delays a real maintenance.
 */

const INFLIGHT_STATUSES = Object.freeze(["created", "pending", "pending_review", "processing", "relaunch"]);

/** Pure: aggregation rows → the public summary. */
function summarize(rows, now = Date.now()) {
  const byFlow = {};
  const byProvider = {};
  let total = 0;
  let oldest = null;

  for (const r of rows || []) {
    const n = Number(r.count) || 0;
    total += n;
    const flow = String((r._id && r._id.flow) || "UNKNOWN_FLOW");
    byFlow[flow] = (byFlow[flow] || 0) + n;

    const provider = String((r._id && r._id.provider) || "").toLowerCase();
    if (provider) byProvider[provider] = (byProvider[provider] || 0) + n;

    const t = r.oldest ? new Date(r.oldest).getTime() : null;
    if (t !== null && Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
  }

  return {
    total,
    byFlow,
    byProvider,
    oldestAgeSec: oldest === null ? null : Math.max(0, Math.round((now - oldest) / 1000)),
  };
}

/** Uses the status index `{ status, createdAt }`. */
async function countInflight({ Transaction, now = Date.now() }) {
  const { normalizeProvider } = require("./policy");

  const rows = await Transaction.aggregate([
    { $match: { status: { $in: [...INFLIGHT_STATUSES] }, mode: "live" } },
    {
      $group: {
        _id: { flow: "$flow", provider: { $ifNull: ["$metadata.provider", "$provider"] } },
        count: { $sum: 1 },
        oldest: { $min: "$createdAt" },
      },
    },
  ]);

  // Operator names → catalogue provider keys (wave, orange, mtn, moov, card).
  const normalized = rows.map((r) => ({
    ...r,
    _id: { flow: r._id && r._id.flow, provider: normalizeProvider(r._id && r._id.provider) || "" },
  }));

  return summarize(normalized, now);
}

module.exports = { INFLIGHT_STATUSES, summarize, countInflight };
