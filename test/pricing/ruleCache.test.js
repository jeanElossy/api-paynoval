"use strict";

/**
 * ── Déplacé depuis l'API Gateway le 2026-09-10 ──────────────────────────────
 *
 * Ce test suit le code qu'il protège. Le laisser dans la passerelle en aurait
 * fait un test de code MORT : il aurait continué à passer, en donnant
 * l'impression de couvrir la tarification, pendant que la tarification réelle
 * — celle de Tx-Core — n'aurait été couverte par rien.
 *
 * C'est exactement le défaut trouvé le 2026-09-09 sur le chemin de l'argent des
 * cagnottes : un garde-fou qui ne couvre qu'un dépôt sur deux protège la moitié
 * du chemin en donnant l'impression de le protéger entièrement.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getActiveRules,
  invalidateRuleCache,
  cacheStats,
} = require("../../src/services/pricing/ruleCache");

function makeLoader(rules) {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return rules;
  };
  loader.calls = () => calls;
  return loader;
}

test("le premier appel charge, le second sert le cache", async () => {
  invalidateRuleCache();
  const loader = makeLoader([{ _id: "a" }]);

  await getActiveRules({ loader });
  await getActiveRules({ loader });

  assert.equal(loader.calls(), 1);
});

test("l'invalidation force un rechargement", async () => {
  invalidateRuleCache();
  const loader = makeLoader([{ _id: "a" }]);

  await getActiveRules({ loader });
  invalidateRuleCache();
  await getActiveRules({ loader });

  assert.equal(loader.calls(), 2);
});

test("le TTL force un rechargement une fois expiré", async () => {
  invalidateRuleCache();
  const loader = makeLoader([{ _id: "a" }]);

  await getActiveRules({ loader, ttlMs: 0 });
  await getActiveRules({ loader, ttlMs: 0 });

  assert.equal(loader.calls(), 2);
});

test("deux appels simultanés ne déclenchent qu'un seul chargement", async () => {
  invalidateRuleCache();
  const loader = makeLoader([{ _id: "a" }]);

  await Promise.all([getActiveRules({ loader }), getActiveRules({ loader })]);

  assert.equal(loader.calls(), 1);
});

test("un échec de chargement ne fige pas un cache vide", async () => {
  invalidateRuleCache();

  let attempt = 0;
  const loader = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("base indisponible");
    return [{ _id: "a" }];
  };

  await assert.rejects(() => getActiveRules({ loader }), /base indisponible/);

  const rules = await getActiveRules({ loader });
  assert.equal(rules.length, 1);
});

test("cacheStats rend compte des lectures", async () => {
  invalidateRuleCache();
  const loader = makeLoader([{ _id: "a" }, { _id: "b" }]);

  const statsBefore = cacheStats();

  await getActiveRules({ loader });
  await getActiveRules({ loader });

  const stats = cacheStats();
  assert.equal(stats.size, 2);
  assert.equal(stats.hits - statsBefore.hits, 1);
  assert.equal(stats.misses - statsBefore.misses, 1);
});
