"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeRiskScore, BANDS } = require("../src/services/risk/riskScore");
const {
  DEFAULT_POLICY,
  TUNABLE_WEIGHTS,
  createRiskPolicyService,
  validateRiskPolicy,
} = require("../src/services/risk/riskPolicy");

const newcomer = { amount: 95, singleTxLimit: 100, accountAgeDays: 1, kycLevel: 0, velocity: { countLastHour: 0 } };

test("le seuil de revue se règle dans ses bornes seulement", () => {
  assert.deepEqual(validateRiskPolicy({ review: 0.5 }), []);
  assert.equal(validateRiskPolicy({ review: 0.1 }).length, 1);
  assert.equal(validateRiskPolicy({ review: 0.84 }).length, 1);
  assert.equal(validateRiskPolicy({ review: NaN }).length, 1);
});

test("un signal dur n'est pas réglable, ni un poids hors bornes", () => {
  assert.equal(TUNABLE_WEIGHTS.includes("BLACKLIST"), false);
  assert.equal(validateRiskPolicy({ review: 0.5, weights: { BLACKLIST: 0 } }).length, 1);
  assert.equal(validateRiskPolicy({ review: 0.5, weights: { NEW_ACCOUNT: 0.9 } }).length, 1);
});

test("une liste noire bloque quelle que soit la politique", () => {
  const verdict = computeRiskScore({
    blacklistHit: { code: "X" },
    policy: { version: 3, review: 0.75, weights: { NEW_ACCOUNT: 0 } },
  });
  assert.equal(verdict.band, "block");
});

test("aucune politique ne fait bloquer sur des signaux mous", () => {
  const weights = Object.fromEntries(TUNABLE_WEIGHTS.map((key) => [key, 0.5]));
  const verdict = computeRiskScore({ ...newcomer, policy: { version: 1, review: 0.35, weights } });
  assert.notEqual(verdict.band, "block");
  assert.equal(verdict.score < BANDS.BLOCK, true);
});

test("le seuil de la politique décide de la revue et la version est tracée", () => {
  const base = computeRiskScore(newcomer);
  const stricter = computeRiskScore({ ...newcomer, policy: { version: 7, review: 0.35, weights: {} } });
  assert.equal(stricter.policyVersion, 7);
  assert.equal(base.policyVersion, 0);
  assert.equal(stricter.band === "review" || base.score < 0.35, true);
});

function fakeModel(docs) {
  const lean = (value) => ({ lean: async () => value, select: () => ({ lean: async () => value }) });
  return {
    findOne: (filter) => {
      if (filter.status) return lean(docs.find((d) => d.status === filter.status) || null);
      return { sort: () => lean(docs[docs.length - 1] || null) };
    },
    exists: async (filter) => docs.some((d) => d.status === filter.status),
    updateOne: async (filter, { $set }) => Object.assign(docs.find((d) => d._id === filter._id), $set),
    findOneAndUpdate: async (filter, { $set }) => {
      const doc = docs.find(
        (d) =>
          d.version === filter.version &&
          d.status === filter.status &&
          d.proposedBy.staffId !== filter["proposedBy.staffId"].$ne
      );
      return doc ? Object.assign(doc, $set) : null;
    },
    create: async (doc) => {
      docs.push({ _id: docs.length + 1, ...doc });
      return docs[docs.length - 1];
    },
  };
}

test("l'auteur ne peut pas approuver sa version", async () => {
  const docs = [];
  const service = createRiskPolicyService({ getModel: () => fakeModel(docs), logger: {} });
  const author = { staffId: "a", email: "a@x" };

  await service.propose({ review: 0.5, reason: "ajustement du seuil", actor: author });
  await assert.rejects(
    service.decide({ version: 1, decision: "approve", actor: author }),
    /autre personne/
  );

  await service.decide({ version: 1, decision: "approve", actor: { staffId: "b" } });
  assert.equal(docs[0].status, "active");
});

test("un refus laisse la version active en place", async () => {
  const docs = [{ _id: 1, version: 1, status: "active", review: 0.5, proposedBy: { staffId: "a" } }];
  const service = createRiskPolicyService({ getModel: () => fakeModel(docs), logger: {} });

  await service.propose({ review: 0.6, reason: "nouveau réglage proposé", actor: { staffId: "b" } });
  await assert.rejects(service.decide({ version: 2, decision: "approve", actor: { staffId: "b" } }));

  assert.equal(docs[0].status, "active");
});

test("une politique illisible n'arrête pas les paiements et revient aux valeurs d'origine", async () => {
  const service = createRiskPolicyService({
    getModel: () => ({ findOne: () => ({ lean: async () => { throw new Error("down"); } }) }),
    logger: {},
  });
  assert.deepEqual(await service.getActive(), DEFAULT_POLICY);
});
