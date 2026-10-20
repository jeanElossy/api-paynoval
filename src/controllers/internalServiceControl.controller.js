"use strict";

/**
 * GET /api/v1/internal/service-control/inflight — HTTP translation only.
 * Logic: services/serviceControl/inflight.js. Contract §8.
 */

const runtime = require("../services/transactions/shared/runtime");
const { countInflight } = require("../services/serviceControl/inflight");

async function getInflight(_req, res, next) {
  try {
    const data = await countInflight({ Transaction: runtime.Transaction });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getInflight };
