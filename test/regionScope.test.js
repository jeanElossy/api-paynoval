"use strict";

/**
 * V1 capabilities by region: mobile money deposits and withdrawals are for
 * African accounts; Europe / America deposit and withdraw by card; transfers
 * (PayNoval → PayNoval / mobile money / card) are open from any region.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateRegionScope } = require("../src/services/transactions/shared/railPolicy");
const { getCountryRegion } = require("../src/services/transactions/handlers/corridorValidation");
const requireAllowedRail = require("../src/middleware/requireAllowedRail");

const run = (user, body) =>
  new Promise((resolve) => requireAllowedRail({ user, body }, {}, (err) => resolve(err || null)));

test("every served country has a region", () => {
  for (const c of ["Côte d'Ivoire", "CI", "Mali", "Burkina Faso"]) {
    assert.equal(getCountryRegion(c), "africa", c);
  }
  for (const c of ["France", "Belgique", "Allemagne", "Espagne", "Angleterre", "GB"]) {
    assert.equal(getCountryRegion(c), "europe", c);
  }
  for (const c of ["Canada", "USA"]) assert.equal(getCountryRegion(c), "america", c);
  // Out of the V1 perimeter.
  for (const c of ["Sénégal", "Cameroun", "Atlantide"]) assert.equal(getCountryRegion(c), null, c);
});

test("the V1 matrix", () => {
  const cases = [
    // [region, action, funds, destination, allowed]
    ["africa", "deposit", "mobilemoney", "paynoval", true],
    ["africa", "withdraw", "paynoval", "mobilemoney", true],
    ["europe", "deposit", "mobilemoney", "paynoval", false],
    ["america", "withdraw", "paynoval", "mobilemoney", false],
    [null, "deposit", "mobilemoney", "paynoval", false],
    ["europe", "deposit", "visa_direct", "paynoval", true],
    ["europe", "withdraw", "paynoval", "visa_direct", true],
    // Transfers are open from any region (remittance to a Wave / Orange wallet).
    ["europe", "send", "paynoval", "mobilemoney", true],
    ["america", "send", "paynoval", "paynoval", true],
    ["europe", "send", "paynoval", "visa_direct", true],
  ];
  for (const [region, action, funds, destination, allowed] of cases) {
    assert.equal(evaluateRegionScope({ region, action, funds, destination }).allowed, allowed, JSON.stringify({ region, action, funds, destination }));
  }
});

test("the middleware refuses a French mobile money deposit, lets an Ivorian one through", async () => {
  const refused = await run({ _id: "u1", country: "France" }, { action: "deposit", funds: "mobilemoney", destination: "paynoval" });
  assert.equal(refused?.status, 403);
  assert.equal(refused?.code, "MOBILE_MONEY_NOT_AVAILABLE_IN_REGION");

  const ok = await run({ _id: "u2", country: "Côte d'Ivoire" }, { action: "deposit", funds: "mobilemoney", destination: "paynoval" });
  assert.equal(ok, null);

  const card = await run({ _id: "u1", country: "France" }, { action: "deposit", funds: "visa_direct", destination: "paynoval" });
  assert.equal(card, null);
});
