"use strict";

/**
 * READ-ONLY view of the service-control state, on the Users connection — the
 * SAME database the backend writes (contract §2). Tx-Core never writes it:
 * every write path is refused at the Mongoose level, so a mistaken `save()`
 * here fails loudly instead of forking the state.
 *
 * Field names are a cross-repository contract with
 * paynoval-backend/models/serviceControl/*.js (collections below).
 */

const mongoose = require("mongoose");

function readOnly(schema, label) {
  const refuse = function refuse(next) {
    const err = new Error(`${label} : lecture seule dans Tx-Core (le backend est le seul écrivain).`);
    err.code = "SERVICE_CONTROL_READ_ONLY";
    return next(err);
  };
  schema.pre("save", refuse);
  for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteMany", "findOneAndDelete"]) {
    schema.pre(op, refuse);
  }
  schema.pre("deleteOne", { document: true, query: true }, refuse);
  return schema;
}

const message = { fr: String, en: String };
const opts = (collection) => ({ collection, strict: false, versionKey: false });

const DEFS = {
  ServiceControlStateRO: {
    collection: "service_control_states",
    fields: { scopeType: String, scopeKey: String, level: String, userMessage: message, estimatedEndAt: Date },
  },
  ServiceControlMetaRO: {
    collection: "service_control_meta",
    fields: { _id: String, revision: Number },
  },
  MaintenanceWindowRO: {
    collection: "service_maintenance_windows",
    fields: { scopes: [{ _id: false, scopeType: String, scopeKey: String }], level: String, startsAt: Date, endsAt: Date, userMessage: message, cancelledAt: Date },
  },
  ServiceControlBypassRO: {
    collection: "service_control_bypasses",
    fields: { userId: mongoose.Schema.Types.ObjectId, expiresAt: Date, allowLockdown: Boolean, revokedAt: Date },
  },
  AppVersionPolicyRO: {
    collection: "app_version_policies",
    fields: { platform: String, minimumVersion: String, recommendedVersion: String, blockedVersions: [String], blockedUpdateIds: [String], storeUrl: String, message },
  },
};

/** Models bound to `conn` (the Users connection), registered once. */
function readModels(conn) {
  const out = {};
  for (const [name, def] of Object.entries(DEFS)) {
    out[name] = conn.models[name] || conn.model(name, readOnly(new mongoose.Schema(def.fields, opts(def.collection)), name));
  }
  return out;
}

module.exports = { readModels, DEFS, readOnly };
