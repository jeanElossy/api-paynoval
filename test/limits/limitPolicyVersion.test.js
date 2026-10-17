"use strict";

/**
 * Plafonds — une version ne se réécrit ni ne s'efface (2026-10-17),
 * `models/LimitPolicyVersion.js`. Les gardes jouent AVANT tout accès réseau :
 * aucune base n'est ouverte ici.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const conn = mongoose.createConnection();
conn.set("bufferCommands", false);
const LimitPolicyVersion = require("../../src/models/LimitPolicyVersion")(conn);

const immutable = (e) => e && e.code === "LIMIT_POLICY_IMMUTABLE";

test("the content of a version cannot be rewritten by an update", async () => {
  for (const update of [{ $set: { limits: {} } }, { reason: "autre" }, { $set: { "limits.WITHDRAW": 1 } }, { $set: { proposedBy: {} } }]) {
    await assert.rejects(LimitPolicyVersion.updateOne({ version: 1 }, update).exec(), immutable);
    await assert.rejects(LimitPolicyVersion.findOneAndUpdate({ version: 1 }, update).exec(), immutable);
  }
});

test("a version is never replaced nor deleted", async () => {
  await assert.rejects(LimitPolicyVersion.deleteOne({ version: 1 }).exec(), immutable);
  await assert.rejects(LimitPolicyVersion.deleteMany({}).exec(), immutable);
  await assert.rejects(LimitPolicyVersion.replaceOne({ version: 1 }, {}).exec(), immutable);
});

test("the lifecycle fields are not blocked by the guard", async () => {
  await assert.rejects(
    LimitPolicyVersion.updateOne({ version: 1 }, { $set: { status: "superseded", supersededAt: new Date() } }).exec(),
    (e) => !immutable(e)
  );
});

test("one active version at most, enforced by a unique partial index", () => {
  const idx = LimitPolicyVersion.schema.indexes().find(([, opts]) => opts.name === "uniq_active_limit_policy");
  assert.ok(idx);
  assert.equal(idx[1].unique, true);
  assert.deepEqual(idx[1].partialFilterExpression, { status: "active" });
});
