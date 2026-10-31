"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { aggregateMoney } = require("../src/controllers/internalDashboardStats.controller");

test("la période précédente s'arrête où commence la période courante", async () => {
  const since = new Date("2026-10-01T00:00:00Z");
  const until = new Date("2026-10-08T00:00:00Z");
  let pipeline;

  await aggregateMoney(since, async (stages) => {
    pipeline = stages;
    return [];
  }, until);

  assert.deepEqual(pipeline[0].$match.createdAt, { $gte: since, $lt: until });
});

test("la période courante reste ouverte", async () => {
  const since = new Date("2026-10-08T00:00:00Z");
  let pipeline;

  await aggregateMoney(since, async (stages) => {
    pipeline = stages;
    return [];
  });

  assert.deepEqual(pipeline[0].$match.createdAt, { $gte: since });
});
