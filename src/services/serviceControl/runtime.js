"use strict";

/**
 * Tx-Core's in-process view of the service-control state (contract §7).
 * Read on the Users connection, cached 5 s, reloaded only when the backend
 * bumps the revision. No HTTP dependency on the backend: the money controls
 * keep working when the backend is down.
 */

const { createServiceControlStore } = require("./store");
const { readModels } = require("./readModels");

let logger = console;
try {
  logger = require("../../utils/logger");
} catch {
  /* console fallback */
}

function models() {
  const { getUsersConn } = require("../../config/db");
  return readModels(getUsersConn());
}

async function loadRevision() {
  const { ServiceControlMetaRO } = models();
  const doc = await ServiceControlMetaRO.findById("revision").select("revision").lean();
  return doc ? Number(doc.revision) || 0 : 0;
}

async function loadSnapshot() {
  const m = models();
  const now = new Date();

  const [states, windows, bypasses, policies] = await Promise.all([
    m.ServiceControlStateRO.find({ level: { $ne: "OPERATIONAL" } }).select("scopeType scopeKey level userMessage estimatedEndAt").lean(),
    m.MaintenanceWindowRO.find({ cancelledAt: null, endsAt: { $gt: now } }).select("scopes level startsAt endsAt userMessage cancelledAt").sort({ startsAt: 1 }).limit(200).lean(),
    m.ServiceControlBypassRO.find({ revokedAt: null, expiresAt: { $gt: now } }).select("userId expiresAt allowLockdown").lean(),
    m.AppVersionPolicyRO.find({}).select("platform minimumVersion recommendedVersion blockedVersions blockedUpdateIds storeUrl message").lean(),
  ]);

  const bypassByUser = {};
  for (const b of bypasses) {
    const key = String(b.userId);
    if (!bypassByUser[key] || new Date(b.expiresAt) > new Date(bypassByUser[key].expiresAt)) {
      bypassByUser[key] = { expiresAt: b.expiresAt, allowLockdown: b.allowLockdown === true, revokedAt: null };
    }
  }

  return {
    states: states.map((s) => ({ ...s, id: String(s._id) })),
    windows: windows.map((w) => ({ ...w, id: String(w._id) })),
    bypassByUser,
    versionPolicies: Object.fromEntries(policies.map((p) => [p.platform, p])),
  };
}

let store = null;

function getStore() {
  if (!store) {
    store = createServiceControlStore({
      loadRevision,
      loadSnapshot,
      ttlMs: process.env.SERVICE_CONTROL_CACHE_TTL_MS,
      lkgMaxMs: process.env.SERVICE_CONTROL_LKG_MAX_MS,
      logger,
    });
  }
  return store;
}

module.exports = { getStore, loadSnapshot, loadRevision };
