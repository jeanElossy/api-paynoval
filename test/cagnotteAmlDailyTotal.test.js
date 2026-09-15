"use strict";

/**
 * Plafonds AML — les participations de cagnotte comptent dans le cumul
 * journalier et dans le compte horaire (2026-09-15).
 *
 * Avant, `getUserTransactionsStats` ne lisait que la collection `transactions` :
 * une participation (réglée dans `tx_cagnotte_settlements`) débitait le solde
 * sans jamais entrer dans le cumul. Vingt participations juste sous le plafond
 * par envoi passaient toutes.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  appliesToCagnotteParticipations,
  cagnotteParticipationMatch,
  getCagnotteParticipationStats,
} = require("../src/services/aml");

const since24h = new Date("2026-09-14T12:00:00Z");
const since1h = new Date("2026-09-15T11:00:00Z");

test("seul le rail PayNoval (ou aucun rail précisé) compte les participations", () => {
  assert.equal(appliesToCagnotteParticipations(""), true);
  assert.equal(appliesToCagnotteParticipations(null), true);
  assert.equal(appliesToCagnotteParticipations("paynoval"), true);
  assert.equal(appliesToCagnotteParticipations("PayNoval"), true);
  assert.equal(appliesToCagnotteParticipations("mobilemoney"), false);
  assert.equal(appliesToCagnotteParticipations("wave"), false);
});

test("le filtre vise le participant, les règlements confirmés v2, la devise SOURCE et 24 h", () => {
  assert.deepEqual(cagnotteParticipationMatch({ userId: "u1", currency: "CAD", since: since24h }), {
    userId: "u1",
    status: "confirmed",
    schemaVersion: { $gte: 2 },
    createdAt: { $gte: since24h },
    "source.currency": "CAD",
  });
});

test("cumul et compte horaire lus sur les règlements", async () => {
  let pipeline = null;
  const Model = {
    aggregate: async (p) => {
      pipeline = p;
      return [{ _id: null, total: 750.5, lastHour: 2 }];
    },
  };

  const out = await getCagnotteParticipationStats({ userId: "u1", currency: "CAD", provider: "paynoval", since24h, since1h, Model });

  assert.deepEqual(out, { dailyTotal: 750.5, lastHour: 2 });
  assert.equal(pipeline[0].$match.userId, "u1");
  assert.deepEqual(pipeline[1].$group.total, { $sum: "$source.amount" });
});

test("aucun règlement : zéro, sans inventer de montant", async () => {
  const Model = { aggregate: async () => [] };
  assert.deepEqual(
    await getCagnotteParticipationStats({ userId: "u1", currency: "XOF", provider: "", since24h, since1h, Model }),
    { dailyTotal: 0, lastHour: 0 }
  );
});

test("autre rail : aucune lecture, aucune participation comptée", async () => {
  const Model = {
    aggregate: async () => assert.fail("un transfert mobile money ne lit pas les participations"),
  };
  assert.deepEqual(
    await getCagnotteParticipationStats({ userId: "u1", currency: "XOF", provider: "wave", since24h, since1h, Model }),
    { dailyTotal: 0, lastHour: 0 }
  );
});

test("lecture impossible : l'erreur REMONTE, jamais un zéro silencieux", async () => {
  const Model = {
    aggregate: async () => {
      throw new Error("mongo down");
    },
  };

  await assert.rejects(
    getCagnotteParticipationStats({ userId: "u1", currency: "XOF", provider: "paynoval", since24h, since1h, Model }),
    /mongo down/
  );
});

test("getUserTransactionsStats ajoute les participations au cumul ET au compte horaire", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "aml.js"), "utf8");
  const start = source.indexOf("async function getUserTransactionsStats(");
  const body = source.slice(start, source.indexOf("\n}\n", start));

  assert.match(body, /await getCagnotteParticipationStats\(/);
  assert.match(body, /dailyTotal: safeNumber\(dailyTotal\) \+ cagnotte\.dailyTotal/);
  assert.match(body, /lastHour: Number\(lastHour \|\| 0\) \+ cagnotte\.lastHour/);
});
