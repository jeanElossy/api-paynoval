"use strict";

/**
 * Plafonds — gouvernance à quatre yeux (2026-10-17),
 * `services/limits/limitPolicyService.js`. Modèle en mémoire, aucune base.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLimitPolicyService } = require("../../src/services/limits/limitPolicyService");
const { DEFAULT_LIMITS } = require("../../src/services/limits/limitCatalog");

function memoryModel() {
  const docs = [];
  const matches = (doc, q) => Object.entries(q).every(([k, v]) => doc[k] === v);
  const chain = (result) => ({
    sort: () => chain(result),
    select: () => chain(result),
    limit: (n) => chain(Array.isArray(result) ? result.slice(0, n) : result),
    lean: async () => (result ? JSON.parse(JSON.stringify(result)) : result),
  });
  return {
    docs,
    findOne(q = {}) {
      const found = docs.filter((d) => matches(d, q)).sort((a, b) => b.version - a.version)[0] || null;
      return chain(found);
    },
    find() {
      return chain([...docs].sort((a, b) => b.version - a.version));
    },
    async countDocuments(q) {
      return docs.filter((d) => matches(d, q)).length;
    },
    async create(doc) {
      const stored = { ...doc, createdAt: new Date() };
      docs.push(stored);
      return stored;
    },
    async findOneAndUpdate(q, update, opts = {}) {
      const doc = docs.find((d) => matches(d, q));
      if (!doc) return null;
      const before = { ...doc };
      Object.assign(doc, update.$set);
      return opts.new ? { ...doc } : before;
    },
    async updateOne(q, update) {
      const doc = docs.find((d) => matches(d, q));
      if (doc) Object.assign(doc, update.$set);
    },
  };
}

// Staff 2FA is mandatory since 2026-10-25: these fixtures must carry it.
const alice = { _id: "staff-alice", role: "compliance", email: "a@x", twoFaEnabled: true };
const bob = { _id: "staff-bob", role: "admin", email: "b@x", twoFaEnabled: true };
const eve = { _id: "user-eve", role: "user" };
const policy = () => JSON.parse(JSON.stringify(DEFAULT_LIMITS));

const setup = () => {
  const model = memoryModel();
  const service = createLimitPolicyService({ getModel: () => model, logger: { info() {}, error() {} } });
  return { model, service };
};

test("without an approved version, the code's defaults apply — and say so", async () => {
  const { service } = setup();
  const active = await service.getActivePolicy();
  assert.equal(active.source, "default");
  assert.equal(active.version, 0);
});

test("propose → another person approves → active", async () => {
  const { service } = setup();
  const limits = policy();
  limits.WITHDRAW.mobilemoney.XOF.perTransaction = 500_000;

  const proposed = await service.propose({ limits, reason: "Abaissement retrait MM (avis conformité)", user: alice });
  assert.equal(proposed.status, "proposed");
  assert.equal((await service.getActivePolicy()).source, "default");

  const approved = await service.approve({ version: proposed.version, user: bob });
  assert.equal(approved.status, "active");
  const active = await service.getActivePolicy();
  assert.equal(active.source, "policy");
  assert.equal(active.limits.WITHDRAW.mobilemoney.XOF.perTransaction, 500_000);
});

test("four eyes: the author can neither approve nor reject their own proposal", async () => {
  const { service } = setup();
  const p = await service.propose({ limits: policy(), reason: "Première politique validée", user: alice });
  await assert.rejects(service.approve({ version: p.version, user: alice }), (e) => e.code === "FOUR_EYES_REQUIRED" && e.status === 403);
  await assert.rejects(service.reject({ version: p.version, user: alice, reason: "Je retire ma proposition" }), (e) => e.code === "FOUR_EYES_REQUIRED");
});

test("a valid internal token is not enough: the staff role is checked", async () => {
  const { service } = setup();
  await assert.rejects(service.propose({ limits: policy(), reason: "Tentative sans rôle", user: eve }), (e) => e.status === 403);
  await assert.rejects(service.propose({ limits: policy(), reason: "Tentative anonyme", user: { _id: null, role: "internal" } }), (e) => e.status === 401);
});

test("an invalid policy, a missing reason or a second pending proposal are refused", async () => {
  const { service } = setup();
  const bad = policy();
  bad.TRANSFER.card.EUR.rolling30d = 1;
  await assert.rejects(service.propose({ limits: bad, reason: "Politique incohérente", user: alice }), (e) => e.code === "LIMIT_POLICY_INVALID");
  await assert.rejects(service.propose({ limits: policy(), reason: "court", user: alice }), (e) => e.code === "LIMIT_POLICY_REASON_REQUIRED");
  await service.propose({ limits: policy(), reason: "Proposition numéro un", user: alice });
  await assert.rejects(service.propose({ limits: policy(), reason: "Proposition numéro deux", user: bob }), (e) => e.code === "LIMIT_POLICY_PENDING_EXISTS");
});

test("approving supersedes the previous version; history keeps everything", async () => {
  const { service, model } = setup();
  const v1 = await service.propose({ limits: policy(), reason: "Version initiale validée", user: alice });
  await service.approve({ version: v1.version, user: bob });
  const v2 = await service.propose({ limits: policy(), reason: "Deuxième version validée", user: bob });
  await service.approve({ version: v2.version, user: alice });

  assert.deepEqual(model.docs.map((d) => d.status), ["superseded", "active"]);
  const history = await service.history({ user: alice });
  assert.equal(history.versions.length, 2);
  assert.equal(history.active.version, 2);
});

test("a rejected or already-active version cannot be approved", async () => {
  const { service } = setup();
  const p = await service.propose({ limits: policy(), reason: "Version à rejeter", user: alice });
  await service.reject({ version: p.version, user: bob, reason: "Montants non justifiés" });
  await assert.rejects(service.approve({ version: p.version, user: bob }), (e) => e.code === "LIMIT_POLICY_NOT_PROPOSED");
});

test("an active policy that no longer validates refuses every operation", async () => {
  const { service, model } = setup();
  model.docs.push({ version: 1, status: "active", limits: { WITHDRAW: {} } });
  await assert.rejects(service.getActivePolicy(), (e) => e.code === "LIMIT_UNDEFINED");
});
