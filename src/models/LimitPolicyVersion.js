"use strict";

/**
 * Version de la politique de plafonds (2026-10-08) — `services/limits/`.
 *
 * Chaque changement est une NOUVELLE version, immuable dans son contenu :
 * proposée par un membre de la conformité, approuvée par un AUTRE (quatre
 * yeux), puis active. L'ancienne active passe `superseded` ; rien n'est
 * effacé, l'historique répond à « quel plafond s'appliquait le 3 mars ? ».
 *
 * Gardes (même motif que `LedgerEntry`) :
 *   - le CONTENU (`version`, `limits`, `reason`, `proposedBy`) ne se réécrit
 *     jamais, ni par `save` ni par une mise à jour ;
 *   - aucune suppression : une version rejetée ou remplacée reste au registre ;
 *   - un seul document `active` à la fois : index unique partiel.
 * Seul le CYCLE DE VIE (`status`, `approvedBy`, `rejectedBy`,
 * `rejectionReason`, `supersededAt`, `activatedAt`) évolue, par les
 * transitions conditionnelles de `limitPolicyService`.
 */

const mongoose = require("mongoose");

const actorSchema = new mongoose.Schema(
  {
    staffId: { type: String, required: true },
    email: { type: String, default: "" },
    role: { type: String, default: "" },
    at: { type: Date, required: true },
  },
  { _id: false }
);

const LIMIT_POLICY_STATUSES = Object.freeze(["proposed", "active", "superseded", "rejected"]);
const IMMUTABLE_FIELDS = Object.freeze(["version", "limits", "reason", "proposedBy"]);

const limitPolicyVersionSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, min: 1, immutable: true },
    status: { type: String, enum: LIMIT_POLICY_STATUSES, required: true },
    // `{ [operation]: { [rail]: { [ISO]: { perTransaction, rolling24h, rolling30d } } } }`
    limits: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
    reason: { type: String, required: true, trim: true, maxlength: 1000, immutable: true },
    proposedBy: { type: actorSchema, required: true, immutable: true },
    approvedBy: { type: actorSchema, default: null },
    rejectedBy: { type: actorSchema, default: null },
    rejectionReason: { type: String, default: null, maxlength: 1000 },
    activatedAt: { type: Date, default: null },
    supersededAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "limit_policy_versions" }
);

limitPolicyVersionSchema.index({ version: 1 }, { unique: true });
limitPolicyVersionSchema.index(
  { status: 1 },
  { unique: true, partialFilterExpression: { status: "active" }, name: "uniq_active_limit_policy" }
);

/* ── Gardes d'immuabilité ───────────────────────────────────────────────── */

function immutableError(field) {
  const err = new Error(`LimitPolicyVersion : le champ « ${field} » est immuable.`);
  err.code = "LIMIT_POLICY_IMMUTABLE";
  err.status = 409;
  return err;
}

function touchedFields(update = {}) {
  const fields = new Set();
  for (const [key, value] of Object.entries(update || {})) {
    if (key.startsWith("$") && value && typeof value === "object") {
      for (const path of Object.keys(value)) fields.add(path.split(".")[0]);
    } else {
      fields.add(key.split(".")[0]);
    }
  }
  return fields;
}

limitPolicyVersionSchema.pre("save", function guardSave(next) {
  if (this.isNew) return next();
  const changed = IMMUTABLE_FIELDS.find((field) => this.isModified(field));
  return next(changed ? immutableError(changed) : undefined);
});

for (const op of ["updateOne", "updateMany", "findOneAndUpdate"]) {
  limitPolicyVersionSchema.pre(op, function guardUpdate(next) {
    const fields = touchedFields(this.getUpdate());
    const changed = IMMUTABLE_FIELDS.find((field) => fields.has(field));
    return next(changed ? immutableError(changed) : undefined);
  });
}

for (const op of ["replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"]) {
  limitPolicyVersionSchema.pre(op, function guardDestructive(next) {
    const err = new Error(`LimitPolicyVersion : « ${op} » interdit — une version ne se remplace ni ne s'efface.`);
    err.code = "LIMIT_POLICY_IMMUTABLE";
    err.status = 409;
    next(err);
  });
}

limitPolicyVersionSchema.pre("deleteOne", { document: true, query: false }, function guardDocDelete(next) {
  const err = new Error("LimitPolicyVersion : suppression interdite.");
  err.code = "LIMIT_POLICY_IMMUTABLE";
  err.status = 409;
  next(err);
});

module.exports = (conn) =>
  conn.models.LimitPolicyVersion || conn.model("LimitPolicyVersion", limitPolicyVersionSchema);

module.exports.LIMIT_POLICY_STATUSES = LIMIT_POLICY_STATUSES;
module.exports.IMMUTABLE_FIELDS = IMMUTABLE_FIELDS;
module.exports.schema = limitPolicyVersionSchema;
