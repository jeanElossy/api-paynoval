"use strict";

/**
 * Tx-Core service-control guard (contract §2, §5, §8, §9, §13).
 *
 *   · the decision on real describers (initiate, internal payments, cagnottes);
 *   · FAIL CLOSED: a broken guard refuses money, it never lets it through;
 *   · WIRING: the routes that finish or repair (provider webhooks, settlement
 *     of a guest who already paid, cancel, refund, replay) carry NO guard, and
 *     every route that starts a money movement carries one.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sc = require("../../src/middleware/serviceControl");
const { summarize, INFLIGHT_STATUSES } = require("../../src/services/serviceControl/inflight");
const { readModels } = require("../../src/services/serviceControl/readModels");

const NOW = Date.parse("2026-10-17T12:00:00Z");
const H = 3600 * 1000;

const view = (states = [], extra = {}, status = "fresh") => ({
  status,
  snapshot: { states, windows: [], bypassByUser: {}, versionPolicies: {}, ...extra },
});

function req(body = {}, headers = {}, user = { _id: "u1", country: "Côte d'Ivoire" }) {
  return { body, headers, user };
}

/* ------------------------------------------------------------- describers */

test("initiate: an Orange withdrawal is described with its feature, operator, country and currency", () => {
  const d = sc.describeInitiate(
    req({ funds: "paynoval", destination: "mobilemoney", txType: "WITHDRAW", metadata: { provider: "orange_money" }, destinationCountry: "Côte d'Ivoire", senderCurrencyCode: "XOF" })
  );
  assert.deepEqual(d.features, ["money.withdraw"]);
  assert.deepEqual(d.providers, ["orange"]);
  assert.ok(d.countries.includes("CI"));
  assert.ok(d.currencies.includes("XOF"));
  assert.equal(d.userId, "u1");
});

test("country names and codes resolve through COUNTRY_RULES", () => {
  assert.equal(sc.toCountryIso("Côte d'Ivoire"), "CI");
  assert.equal(sc.toCountryIso("canada"), "CA");
  // Un code ISO passe tel quel (normaliseur générique, partagé avec le backend) ;
  // un NOM passe par COUNTRY_RULES — « royaume uni » n'y est plus (V1 = deux pays, 2026-11-10).
  assert.equal(sc.toCountryIso("BF"), "BF");
  assert.equal(sc.toCountryIso("royaume uni"), null);
  assert.equal(sc.toCountryIso("Atlantis"), null);
});

test("internal payments: admin adjustments are never controlled, bonuses are", () => {
  assert.equal(sc.describeInternalPayment(req({ kind: "adjustment_credit" })), null);
  assert.deepEqual(sc.describeInternalPayment(req({ kind: "bonus", currencySymbol: "XOF" })).features, ["referral.payout"]);
});

test("participation replay is never controlled", () => {
  const describe = sc.describeFixed(["cagnotte.participate"], { skipIf: (b) => b.replayOnly === true });
  assert.equal(describe(req({ replayOnly: true })), null);
  assert.deepEqual(describe(req({ userId: "u9" })).features, ["cagnotte.participate"]);
});

/* --------------------------------------------------------------- decision */

function evalInitiate(states, body, headers = {}, extra = {}, status = "fresh") {
  const r = req(body, headers);
  return sc.evaluate({ described: sc.describeInitiate(r), phase: "initiate", view: view(states, extra, status), req: r, now: NOW });
}

test("provider kill switch: Orange refused, Wave accepted", () => {
  const states = [{ scopeType: "provider", scopeKey: "orange", level: "MAINTENANCE" }];
  const orange = evalInitiate(states, { funds: "mobilemoney", destination: "paynoval", txType: "DEPOSIT", metadata: { provider: "orange" } });
  const wave = evalInitiate(states, { funds: "mobilemoney", destination: "paynoval", txType: "DEPOSIT", metadata: { provider: "wave" } });
  assert.equal(orange.pass, false);
  assert.equal(orange.refusal.body.code, "PROVIDER_UNAVAILABLE");
  assert.equal(orange.refusal.headers["X-PayNoval-Service-Control"], "PROVIDER_UNAVAILABLE");
  assert.equal(wave.pass, true);
});

test("an untyped card payout is judged as BOTH withdraw and transfer (never under-controlled)", () => {
  const out = evalInitiate([{ scopeType: "feature", scopeKey: "money.transfer.card", level: "MAINTENANCE" }], { funds: "paynoval", destination: "card" });
  assert.equal(out.pass, false);
});

test("a bypass tester passes a global maintenance; nobody passes a lockdown", () => {
  const bypass = { bypassByUser: { u1: { expiresAt: NOW + H } } };
  const body = { funds: "paynoval", destination: "paynoval" };
  assert.equal(evalInitiate([{ scopeType: "global", scopeKey: "all", level: "MAINTENANCE" }], body, {}, bypass).pass, true);
  assert.equal(evalInitiate([{ scopeType: "global", scopeKey: "all", level: "EMERGENCY_LOCKDOWN" }], body, {}, bypass).refusal.body.code, "SERVICE_LOCKDOWN");
});

test("blocked app version ⇒ 426 on initiate", () => {
  const out = evalInitiate([], { funds: "paynoval", destination: "paynoval" }, { "x-app-platform": "android", "x-app-version": "1.0.0" }, {
    versionPolicies: { android: { minimumVersion: "1.2.0", storeUrl: "https://play.google.com/store/apps/details?id=x" } },
  });
  assert.equal(out.refusal.status, 426);
  assert.equal(out.refusal.body.code, "UPDATE_REQUIRED");
});

test("state unreadable: money refused, retryable 503", () => {
  const out = evalInitiate([], { funds: "paynoval", destination: "paynoval" }, {}, {}, "unavailable");
  assert.equal(out.refusal.status, 503);
  assert.equal(out.refusal.body.code, "SERVICE_STATUS_UNAVAILABLE");
});

/* ------------------------------------------------------------ fail closed */

test("a broken guard REFUSES the money operation (fail closed)", async () => {
  const guard = sc.serviceControlGuard({
    phase: "initiate",
    describe: () => ({ features: ["money.withdraw"], providers: [], countries: [], currencies: [] }),
    label: "test",
    store: { ready: async () => { throw new Error("boom"); } },
  });

  const res = { headers: {}, statusCode: 0, body: null, setHeader(k, v) { this.headers[k] = v; }, status(s) { this.statusCode = s; return this; }, json(b) { this.body = b; return this; } };
  let nextCalled = false;
  await guard({ headers: {}, body: {} }, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false, "the money operation went through a broken guard");
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "SERVICE_STATUS_UNAVAILABLE");
});

test("an exempt description (null) passes without reading the state", async () => {
  let read = false;
  const guard = sc.serviceControlGuard({ phase: "initiate", describe: () => null, label: "t", store: { ready: async () => { read = true; } } });
  let nextCalled = false;
  await guard({ headers: {}, body: {} }, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(read, false);
});

/* ---------------------------------------------------------------- wiring */

const ROUTES = path.join(__dirname, "..", "..", "src", "routes");
const src = (f) => fs.readFileSync(path.join(ROUTES, f), "utf8");

/**
 * Source of the LIVE router call that declares `routePath` (commented copies
 * of old implementations are skipped), up to its closing `);`.
 */
function declaration(file, routePath) {
  const s = src(file);
  const escaped = routePath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const re = new RegExp(`^router\\.(post|get|put|patch|delete)\\(\\s*["']${escaped}["']`, "gm");
  const m = re.exec(s);
  assert.ok(m, `${routePath} not declared in ${file}`);
  const end = s.indexOf("\n);", m.index);
  return s.slice(m.index, end >= 0 ? end : undefined);
}

test("money-starting routes carry the guard", () => {
  assert.match(declaration("transactionsRoutes.js", "/initiate"), /serviceControlGuard\(\{ phase: "initiate"/);
  assert.match(declaration("transactionsRoutes.js", "/confirm"), /serviceControlGuard\(\{ phase: "confirm"/);
  assert.match(declaration("cagnotteSettlementRoutes.js", "/participation/settle"), /serviceControlGuard/);
  assert.match(declaration("cagnotteVaultSettlementRoutes.js", "/vault-withdrawals/settle"), /serviceControlGuard/);
  assert.match(declaration("cagnotteClosureFeesRoutes.js", "/closure-fees/settle"), /serviceControlGuard/);
  assert.match(declaration("collectionRoutes.js", "/initiate"), /serviceControlGuard/);
  assert.match(declaration("internalReferralRoutes.js", "/transfer-bonus"), /serviceControlGuard/);
  assert.match(src("internalPaymentsRoutes.js"), /serviceControlGuard\(\{ phase: "initiate", describe: describeInternalPayment/);
});

test("the guard sits BEFORE the AML check on initiate (no AML log for a maintenance refusal)", () => {
  const d = declaration("transactionsRoutes.js", "/initiate");
  assert.ok(d.indexOf("serviceControlGuard") < d.indexOf("amlMiddleware"));
});

test("what finishes or repairs carries NO guard", () => {
  for (const [file, route] of [
    ["transactionsRoutes.js", "/cancel"],
    ["transactionsRoutes.js", "/refund"],
    ["transactionsRoutes.js", "/webhooks/:provider"],
    ["cagnotteExternalSettlementRoutes.js", "/external-participation/settle"],
    ["cagnotteExternalSettlementRoutes.js", "/external-participation/refund"],
    ["cagnotteSettlementRoutes.js", "/participation/refund"],
  ]) {
    assert.doesNotMatch(declaration(file, route), /serviceControlGuard/, `${file} ${route} must never be blocked by maintenance`);
  }
  assert.doesNotMatch(src("providerWebhookRoutes.js"), /serviceControl/, "provider webhooks must never be blocked");
  assert.doesNotMatch(declaration("internalReferralRoutes.js", "/clawback"), /serviceControlGuard/);
});

/* --------------------------------------------------------------- inflight */

test("in-flight summary: numbers only, by flow and provider", () => {
  const out = summarize(
    [
      { _id: { flow: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT", provider: "orange" }, count: 3, oldest: new Date(NOW - 120_000) },
      { _id: { flow: "PAYNOVAL_INTERNAL_TRANSFER", provider: "" }, count: 2, oldest: new Date(NOW - 10_000) },
    ],
    NOW
  );
  assert.deepEqual(out, { total: 5, byFlow: { PAYNOVAL_TO_MOBILEMONEY_PAYOUT: 3, PAYNOVAL_INTERNAL_TRANSFER: 2 }, byProvider: { orange: 3 }, oldestAgeSec: 120 });
  assert.deepEqual(INFLIGHT_STATUSES, ["created", "pending", "pending_review", "processing", "relaunch"]);
});

test("empty: zero, oldest unknown", () => {
  assert.deepEqual(summarize([], NOW), { total: 0, byFlow: {}, byProvider: {}, oldestAgeSec: null });
});

/* -------------------------------------------------------------- read only */

test("Tx-Core cannot write the service-control state", async () => {
  const mongoose = require("mongoose");
  const conn = new mongoose.Mongoose();
  conn.set("bufferCommands", false);
  const m = readModels(conn.connection);

  for (const run of [
    () => m.ServiceControlStateRO.updateOne({}, { $set: { level: "OPERATIONAL" } }),
    () => m.ServiceControlStateRO.deleteMany({}),
    () => new m.ServiceControlBypassRO({ userId: new mongoose.Types.ObjectId() }).save(),
  ]) {
    await assert.rejects(run(), (err) => err.code === "SERVICE_CONTROL_READ_ONLY");
  }
});
