"use strict";

/**
 * Frontière entre production et simulation (2026-10-31).
 * Modèle : sandbox séparée de Wise, PayPal, Revolut et sandboxes de Stripe.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  auditEnvironment,
  assertEnvironmentBoundary,
  evaluateTokenEnvironment,
  assertRealRailAllowed,
  realCredentialsIn,
} = require("../src/services/sandboxEnvironment");
const { normalizeEnv } = require("../src/services/appEnv");
const { isSandboxEnabled } = require("../src/utils/accountMode");
const { evaluateModeBoundary } = require("../src/middleware/modeBoundary");
const { getProviderAdapter } = require("../src/providers/providerSelector");

const SANDBOX_OK = {
  APP_ENV: "sandbox",
  NODE_ENV: "production",
  SANDBOX_MODE_ENABLED: "true",
  JWT_ISSUER: "paynoval-sandbox",
};

const codes = (env) => auditEnvironment(env).violations.map((v) => v.code);

test("`sandbox`, `simulation` et `demo` désignent le même environnement", () => {
  for (const raw of ["sandbox", "SIMULATION", "demo"]) assert.equal(normalizeEnv(raw), "sandbox");
});

test("production : la simulation ne peut pas démarrer", () => {
  assert.deepEqual(codes({ APP_ENV: "production", SANDBOX_MODE_ENABLED: "true" }), [
    "SANDBOX_IN_PRODUCTION",
  ]);
  // Sans APP_ENV, NODE_ENV=production vaut production : pas d'échappatoire par omission.
  assert.deepEqual(codes({ NODE_ENV: "production", SANDBOX_MODE_ENABLED: "1" }), [
    "SANDBOX_IN_PRODUCTION",
  ]);
  assert.deepEqual(codes({ APP_ENV: "production", ALLOW_PROVIDER_MOCK_IN_PRODUCTION: "true" }), [
    "PROVIDER_MOCK_IN_PRODUCTION",
  ]);
  assert.deepEqual(codes({ APP_ENV: "production" }), []);
});

test("production : l'interrupteur est sans effet, même posé", () => {
  assert.equal(isSandboxEnabled({ APP_ENV: "production", SANDBOX_MODE_ENABLED: "true" }), false);
  assert.equal(isSandboxEnabled({ NODE_ENV: "production", SANDBOX_MODE_ENABLED: "true" }), false);
  assert.equal(isSandboxEnabled({ APP_ENV: "staging", SANDBOX_MODE_ENABLED: "true" }), true);
  assert.equal(isSandboxEnabled({ ...SANDBOX_OK }), true);
});

test("simulation : configuration propre acceptée", () => {
  assert.deepEqual(codes(SANDBOX_OK), []);
});

test("simulation : toute clé d'un service réel empêche de démarrer", () => {
  const env = {
    ...SANDBOX_OK,
    TWILIO_AUTH_TOKEN: "x",
    SENDGRID_API_KEY: "x",
    WAVE_API_KEY: "x",
    ORANGE_BASE_URL: "https://x",
    VISA_DIRECT_WEBHOOK_SECRET: "x",
  };

  assert.deepEqual(realCredentialsIn(env), [
    "ORANGE_BASE_URL",
    "SENDGRID_API_KEY",
    "TWILIO_AUTH_TOKEN",
    "VISA_DIRECT_WEBHOOK_SECRET",
    "WAVE_API_KEY",
  ]);
  assert.equal(codes(env).filter((c) => c === "REAL_CREDENTIAL_IN_SANDBOX").length, 5);
});

test("simulation : les réglages sans secret restent permis, une valeur vide aussi", () => {
  assert.deepEqual(
    realCredentialsIn({ ORANGE_MOCK: "true", WAVE_TIMEOUT_MS: "100", SUMSUB_MODE: "mock", TWILIO_SID: " " }),
    []
  );
});

test("simulation : l'émetteur propre et l'interrupteur sont exigés", () => {
  assert.deepEqual(codes({ APP_ENV: "sandbox" }), ["SANDBOX_SWITCH_OFF", "SANDBOX_ISSUER_REQUIRED"]);
});

test("le rapport de violation ne contient jamais une valeur", () => {
  const report = auditEnvironment({ ...SANDBOX_OK, WAVE_API_KEY: "valeur-tres-secrete" });
  assert.ok(!JSON.stringify(report).includes("valeur-tres-secrete"));
});

test("une violation empêche le démarrage, avec un code explicite", () => {
  const logger = { error() {}, warn() {} };
  assert.throws(
    () => assertEnvironmentBoundary({ env: { APP_ENV: "production", SANDBOX_MODE_ENABLED: "true" }, logger }),
    { code: "ENVIRONMENT_BOUNDARY_VIOLATION" }
  );
});

test("le démarrage annonce la simulation, et le partage de bases hors simulation", () => {
  const seen = [];
  const logger = { error() {}, warn: (m) => seen.push(m) };
  assertEnvironmentBoundary({ env: SANDBOX_OK, logger });
  assertEnvironmentBoundary({ env: { APP_ENV: "staging", SANDBOX_MODE_ENABLED: "true" }, logger });
  assert.match(seen[0], /ENVIRONNEMENT DE SIMULATION/);
  assert.match(seen[1], /partagent les mêmes bases/);
});

test("un jeton de simulation est refusé hors simulation, et inversement", () => {
  for (const appEnv of ["production", "staging", "development"]) {
    assert.equal(evaluateTokenEnvironment({ appEnv, claimedEnv: "sandbox" }).code, "ENV_TOKEN_MISMATCH");
    assert.equal(evaluateTokenEnvironment({ appEnv, claimedEnv: appEnv }).ok, true);
    assert.equal(evaluateTokenEnvironment({ appEnv, claimedEnv: undefined }).ok, true);
  }

  assert.equal(evaluateTokenEnvironment({ appEnv: "sandbox", claimedEnv: "production" }).ok, false);
  // Fermé par défaut : un jeton sans monde n'est pas de la simulation.
  assert.equal(evaluateTokenEnvironment({ appEnv: "sandbox", claimedEnv: undefined }).ok, false);
  assert.equal(evaluateTokenEnvironment({ appEnv: "sandbox", claimedEnv: "sandbox" }).ok, true);
});

test("la frontière des modes applique le contrôle du monde au jeton", () => {
  const user = { mode: "sandbox", role: "user" };
  const verdict = evaluateModeBoundary({
    user,
    decoded: { mode: "sandbox", env: "sandbox" },
    sandboxEnabled: true,
    appEnv: "production",
  });
  assert.equal(verdict.code, "ENV_TOKEN_MISMATCH");

  assert.equal(
    evaluateModeBoundary({
      user,
      decoded: { mode: "sandbox", env: "sandbox" },
      sandboxEnabled: true,
      appEnv: "sandbox",
    }).ok,
    true
  );
});

test("l'environnement de simulation ne sert aucun compte client réel", () => {
  const client = evaluateModeBoundary({
    user: { mode: "live", role: "user" },
    decoded: { mode: "live", env: "sandbox" },
    sandboxEnabled: true,
    appEnv: "sandbox",
  });
  assert.equal(client.code, "LIVE_ACCOUNT_IN_SANDBOX_ENV");

  // Le personnel du back-office de simulation n'est pas un client.
  const staff = evaluateModeBoundary({
    user: { mode: "live", role: "superadmin" },
    decoded: { mode: "live", env: "sandbox" },
    sandboxEnabled: true,
    appEnv: "sandbox",
  });
  assert.equal(staff.ok, true);
});

test("en simulation, aucun rail réel ne s'ouvre", () => {
  assert.throws(() => assertRealRailAllowed({ appEnv: "sandbox", rail: "card", provider: "visa_direct" }), {
    code: "REAL_RAIL_FORBIDDEN_IN_SANDBOX",
  });
  assert.throws(
    () => getProviderAdapter({ rail: "mobilemoney", provider: "wave", mode: "live", appEnv: "sandbox" }),
    { code: "REAL_RAIL_FORBIDDEN_IN_SANDBOX" }
  );
  // L'homologue simulé reste servi.
  const adapter = getProviderAdapter({ rail: "mobilemoney", provider: "wave", mode: "sandbox", appEnv: "sandbox" });
  assert.equal(adapter.sandbox, true);
  // Hors simulation, le vrai rail reste résolu.
  const real = getProviderAdapter({ rail: "mobilemoney", provider: "wave", mode: "live", appEnv: "production" });
  assert.notEqual(real.sandbox, true);
});

test("le module est identique dans les trois services", () => {
  const hash = (rel) =>
    crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "..", rel))).digest("hex");

  const reference = hash("api-paynoval/src/services/sandboxEnvironment.js");
  for (const copy of [
    "paynoval-backend/services/sandboxEnvironment.js",
    "api-gateway/api-gateway/src/services/sandboxEnvironment.js",
  ]) {
    if (!fs.existsSync(path.join(__dirname, "..", "..", copy))) continue; // dépôt seul en CI
    assert.equal(hash(copy), reference, `${copy} a divergé`);
  }
});

/* -------------------------------------------------------------------------- */
/* Scénarios de démonstration (2026-10-31)                                    */
/* -------------------------------------------------------------------------- */

const {
  normalizeScenario,
  planProviderOutcome,
  FAILURE_CODES,
} = require("../src/providers/sandbox/sandboxScenario");

test("délai dépassé : échec après le délai, code explicite", () => {
  const plan = planProviderOutcome({
    scenario: { outcome: "timeout", confirmationDelaySeconds: 30 },
    kind: "payout",
    rail: "mobilemoney",
  });
  assert.equal(plan.settle, "failure");
  assert.equal(plan.failureCode, FAILURE_CODES.TIMEOUT);
  assert.equal(plan.delaySeconds, 30);
});

test("numéro invalide : refus du prestataire, code explicite", () => {
  const plan = planProviderOutcome({
    scenario: { outcome: "invalid_destination", confirmationDelaySeconds: 2 },
    kind: "payout",
    rail: "mobilemoney",
  });
  assert.equal(plan.failureCode, FAILURE_CODES.INVALID_DESTINATION);
});

test("portée : toutes les opérations par défaut, la prochaine sur demande", () => {
  assert.equal(normalizeScenario({ outcome: "failure", confirmationDelaySeconds: 1 }).applyTo, "all");
  assert.equal(
    normalizeScenario({ outcome: "failure", confirmationDelaySeconds: 1, applyTo: "next" }).applyTo,
    "next"
  );
  assert.throws(
    () => normalizeScenario({ outcome: "failure", confirmationDelaySeconds: 1, applyTo: "souvent" }),
    { code: "INVALID_SANDBOX_SCENARIO" }
  );
});

test("les ordres simulés consomment le scénario, atomiquement", () => {
  const adapters = fs.readFileSync(path.join(__dirname, "../src/providers/sandbox/sandboxAdapters.js"), "utf8");
  const store = fs.readFileSync(path.join(__dirname, "../src/services/sandbox/sandboxScenarioStore.js"), "utf8");
  assert.match(adapters, /loadScenario: scenarios\.takeScenario/);
  assert.match(store, /findOneAndUpdate\(\s*\{ userId: toObjectId\(userId\), applyTo: SCENARIO_SCOPES\.NEXT \}/);
});

test("le back-office agit sur un compte relu en base, jamais sur sa parole", () => {
  const tools = fs.readFileSync(path.join(__dirname, "../src/services/sandbox/sandboxToolsService.js"), "utf8");
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/internalSandboxRoutes.js"), "utf8");
  assert.match(tools, /async function loadSandboxOwner/);
  assert.match(tools, /assertSandboxUser\(owner\)/);
  assert.match(routes, /router\.use\(internalProtect\)/);
});

/* -------------------------------------------------------------------------- */
/* Jeux de départ (2026-10-31)                                                */
/* -------------------------------------------------------------------------- */

const mongoose = require("mongoose");
const { buildSeedTransactions, DATASET_NAMES } = require("../src/services/sandbox/demoDatasets");
const { applyHistoryWindow, resolveHistoryWindow } = require("../src/services/sandbox/historyWindow");

const SEED_INPUT = {
  dataset: "active",
  userId: "64b000000000000000000001",
  counterpartyId: "64b000000000000000000002",
  ownerName: "Awa Démo",
  counterpartyName: "Koffi Démo (bénéficiaire)",
  generation: 1,
  currency: "XOF",
  now: new Date("2026-10-31T12:00:00Z"),
};

test("chaque ligne de chaque jeu passe la validation du vrai modèle", () => {
  const Transaction = require("../src/models/Transaction")(mongoose.createConnection());

  for (const dataset of DATASET_NAMES) {
    for (const line of buildSeedTransactions({ ...SEED_INPUT, dataset })) {
      const doc = new Transaction(line);
      // `validateSync` rend null ou undefined sans erreur, selon les versions.
      assert.ok(!doc.validateSync(), line.reference);
      assert.equal(doc.mode, "sandbox");
      assert.equal(doc.status, "confirmed");
      assert.equal(doc.internalImported, true);
      assert.ok(!("verificationToken" in line));
    }
  }
});

test("le jeu « compte neuf » est vide, un jeu inconnu est refusé", () => {
  assert.deepEqual(buildSeedTransactions({ ...SEED_INPUT, dataset: "fresh" }), []);
  assert.throws(() => buildSeedTransactions({ ...SEED_INPUT, dataset: "riche" }), {
    code: "INVALID_DEMO_DATASET",
  });
});

test("une contrepartie manquante arrête le jeu, sans valeur inventée", () => {
  assert.throws(() => buildSeedTransactions({ ...SEED_INPUT, counterpartyId: null }), {
    code: "INVALID_DEMO_DATASET",
  });
});

test("les références sont uniques et stables par génération, l'historique est passé", () => {
  const a = buildSeedTransactions(SEED_INPUT);
  const b = buildSeedTransactions(SEED_INPUT);
  const refs = a.map((l) => l.reference);
  assert.equal(new Set(refs).size, refs.length);
  assert.deepEqual(refs, b.map((l) => l.reference));
  assert.notDeepEqual(refs, buildSeedTransactions({ ...SEED_INPUT, generation: 2 }).map((l) => l.reference));
  assert.ok(a.every((l) => l.createdAt < SEED_INPUT.now));
});

test("le jeu couvre dépôts, retraits et transferts dans les deux sens", () => {
  const lines = buildSeedTransactions(SEED_INPUT);
  assert.deepEqual(
    [...new Set(lines.map((l) => l.operationType))].sort(),
    ["DEPOSIT", "TRANSFER", "WITHDRAW"]
  );
  assert.ok(lines.some((l) => l.operationType === "TRANSFER" && l.sender === SEED_INPUT.userId));
  assert.ok(lines.some((l) => l.operationType === "TRANSFER" && l.receiver === SEED_INPUT.userId));
});

test("après une réinitialisation, l'historique montre le jeu en cours et rien d'autre", () => {
  const start = new Date("2026-10-31T00:00:00Z");
  assert.deepEqual(applyHistoryWindow({ userId: "u" }, { start, seedId: "u:2" }), {
    $and: [
      { userId: "u" },
      {
        $or: [
          { createdAt: { $gte: start } },
          { context: "sandbox_seed", contextId: "u:2" },
        ],
      },
    ],
  });
  assert.deepEqual(applyHistoryWindow({ userId: "u" }, null), { userId: "u" });
});

test("un compte réel n'a jamais de fenêtre", async () => {
  const getProfile = async () => {
    throw new Error("ne doit pas être lu");
  };
  assert.equal(await resolveHistoryWindow({ user: { _id: "u", mode: "live" } }, { getProfile }), null);
});

test("l'historique de départ sort des plafonds", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/services/limits/limitUsage.js"), "utf8");
  assert.match(src, /context: \{ \$ne: "sandbox_seed" \}/);
});

test("la réinitialisation rejoue le jeu, et aucune écriture du grand livre n'en dépend", () => {
  const tools = fs.readFileSync(path.join(__dirname, "../src/services/sandbox/sandboxToolsService.js"), "utf8");
  const seed = tools.slice(tools.indexOf("async function seedDataset"), tools.indexOf("async function applyDataset"));
  assert.match(tools, /const seeded = await seedDataset\(userId, \{ now: at \}\)/);
  assert.doesNotMatch(seed, /applySandboxFunding|postFunding|LedgerEntry/);
});
