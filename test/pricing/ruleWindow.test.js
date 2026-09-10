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

const { pickBestRule } = require("../../src/services/pricing/pricingEngine");

const NOW = Date.parse("2026-08-15T12:00:00Z");

function rule(overrides = {}) {
  return {
    _id: "r1",
    name: "Règle",
    active: true,
    priority: 0,
    scope: {
      txType: "TRANSFER",
      method: "INTERNAL",
      provider: "paynoval",
      country: "ALL",
      fromCountry: "ALL",
      toCountry: "ALL",
      fromCurrency: "XOF",
      toCurrency: "XOF",
    },
    amountRange: { min: 0, max: null },
    fee: { mode: "PERCENT", percent: 1 },
    fx: { mode: "PASS_THROUGH" },
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

const request = {
  txType: "TRANSFER",
  method: "INTERNAL",
  provider: "paynoval",
  fromCurrency: "XOF",
  toCurrency: "XOF",
  amount: 10000,
  now: NOW,
};

test("retient une règle sans fenêtre de dates", () => {
  assert.equal(pickBestRule([rule()], request)?._id, "r1");
});

test("ignore une règle dont la date de début est dans le futur", () => {
  const future = rule({ _id: "r2", startsAt: "2026-09-01T00:00:00Z" });
  assert.equal(pickBestRule([future], request), null);
});

test("ignore une règle dont la date de fin est passée", () => {
  const expired = rule({ _id: "r3", endsAt: "2026-08-01T00:00:00Z" });
  assert.equal(pickBestRule([expired], request), null);
});

test("retient une règle dont la fenêtre englobe l'instant demandé", () => {
  const live = rule({
    _id: "r4",
    startsAt: "2026-08-01T00:00:00Z",
    endsAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(pickBestRule([live], request)?._id, "r4");
});

test("une promo datée l'emporte pendant sa fenêtre, puis s'efface", () => {
  const permanent = rule({ _id: "perm", priority: 0 });
  const promo = rule({
    _id: "promo",
    priority: 10,
    startsAt: "2026-08-01T00:00:00Z",
    endsAt: "2026-08-31T23:59:59Z",
  });

  assert.equal(pickBestRule([permanent, promo], request)?._id, "promo");

  const afterPromo = { ...request, now: Date.parse("2026-09-05T00:00:00Z") };
  assert.equal(pickBestRule([permanent, promo], afterPromo)?._id, "perm");
});

test("sans `now` fourni, la fenêtre est évaluée à l'instant courant", () => {
  const longGone = rule({ _id: "old", endsAt: "2020-01-01T00:00:00Z" });
  const { now, ...withoutNow } = request;
  assert.equal(pickBestRule([longGone], withoutNow), null);
});
