"use strict";

/**
 * ============================================================================
 * MODE SIMULATION — LES FRONTIÈRES QUI DOIVENT TENIR
 * ============================================================================
 *
 * Chaque test ici échoue si l'on réintroduit la faute qu'il garde (règle B.5) :
 * un mode deviné, un adapter réel servi à un compte sandbox, une écriture sans
 * mode, des frais fictifs versés à une vraie trésorerie, un rappel venu d'un
 * monde qui règle l'autre, le retour de l'ancien raccourci Apple Review.
 *
 * Logique pure et doublures seulement : aucune connexion, aucun serveur.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

const accountMode = require("../src/utils/accountMode");
const { evaluateModeBoundary } = require("../src/middleware/modeBoundary");
const scenario = require("../src/providers/sandbox/sandboxScenario");
const { makeSandboxAdapter } = require("../src/providers/sandbox/sandboxAdapters");
const {
  treasurySystemTypeForMode,
  buildRegistry,
  loadTreasuryRegistry,
  resetTreasuryRegistry,
} = require("../src/services/treasuryRegistry");
const {
  computeTrialBalanceByMode,
  sandboxFundingClearingAccountId,
} = require("../src/services/ledger/doubleEntry");
const { sanitizeNextAction } = require("../src/services/transactions/providers/nextAction");
const { applyHistoryStart, resolveHistoryStart } = require("../src/services/sandbox/historyWindow");
const { buildSandboxSettlementPayload } = require("../src/services/sandbox/sandboxSettlementWorker");

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), "utf8");
}

/* ========================================================================== */
/* 1. Le mode — une seule définition, aucun repli deviné                       */
/* ========================================================================== */

test("requireMode refuse un mode absent ou inconnu — jamais « live » par défaut", () => {
  for (const bad of [undefined, null, "", "LIVE", "test", 0]) {
    assert.throws(() => accountMode.requireMode(bad, "x"), { code: "MODE_REQUIRED" });
  }
  assert.equal(accountMode.requireMode("sandbox"), "sandbox");
  assert.equal(accountMode.requireMode("live"), "live");
});

test("un compte portant un ancien drapeau de démo est sandbox, même sans champ mode", () => {
  // La direction sûre : un compte de démonstration non migré ne retombe
  // jamais sur un vrai prestataire.
  assert.equal(accountMode.resolveUserMode({ isSandbox: true }), "sandbox");
  assert.equal(accountMode.resolveUserMode({ isReviewerAccount: true }), "sandbox");
  assert.equal(accountMode.resolveUserMode({}), "live");
  assert.equal(accountMode.resolveUserMode({ mode: "sandbox" }), "sandbox");
  // Le champ fait foi sur l'ancien drapeau.
  assert.equal(accountMode.resolveUserMode({ mode: "live", isSandbox: true }), "live");
  assert.throws(() => accountMode.resolveUserMode({ mode: "bogus" }), { code: "MODE_REQUIRED" });
});

test("assertSameMode refuse de franchir la frontière", () => {
  assert.throws(() => accountMode.assertSameMode("live", "sandbox", "portefeuille"), {
    code: "MODE_MISMATCH",
  });
  assert.equal(accountMode.assertSameMode("sandbox", "sandbox"), "sandbox");
});

test("une contrepartie d'un autre mode, ou d'un autre jeu de démo, est hors portée", () => {
  const live = { mode: "live" };
  const liveB = { mode: "live" };
  const sbxA1 = { mode: "sandbox", sandboxGroupId: "g1" };
  const sbxA2 = { mode: "sandbox", sandboxGroupId: "g1" };
  const sbxB = { mode: "sandbox", sandboxGroupId: "g2" };
  const sbxOrphan = { mode: "sandbox" };

  assert.equal(accountMode.isCounterpartyInScope(live, liveB), true);
  assert.equal(accountMode.isCounterpartyInScope(live, sbxA1), false);
  assert.equal(accountMode.isCounterpartyInScope(sbxA1, live), false);
  assert.equal(accountMode.isCounterpartyInScope(sbxA1, sbxA2), true);
  assert.equal(accountMode.isCounterpartyInScope(sbxA1, sbxB), false);
  assert.equal(accountMode.isCounterpartyInScope(sbxOrphan, { mode: "sandbox" }), false);
});

test("le filtre de production garde les documents antérieurs à la migration", () => {
  assert.deepEqual(accountMode.liveOnlyFilter(), { mode: { $ne: "sandbox" } });
  assert.deepEqual(accountMode.modeScopeFilter(undefined), { mode: { $ne: "sandbox" } });
  assert.deepEqual(accountMode.modeScopeFilter("sandbox"), { mode: "sandbox" });
  assert.deepEqual(accountMode.modeScopeFilter("all"), {});
  assert.throws(() => accountMode.modeScopeFilter("everything"), { code: "INVALID_MODE_SCOPE" });
});

test("la simulation est FERMÉE tant que rien ne l'ouvre", () => {
  assert.equal(accountMode.isSandboxEnabled({}), false);
  assert.equal(accountMode.isSandboxEnabled({ SANDBOX_MODE_ENABLED: "false" }), false);
  assert.equal(accountMode.isSandboxEnabled({ SANDBOX_MODE_ENABLED: "true" }), true);
});

/* ========================================================================== */
/* 2. Frontière à l'authentification                                          */
/* ========================================================================== */

test("un jeton sandbox présenté pour un compte live est refusé, et l'inverse", () => {
  const r1 = evaluateModeBoundary({
    user: { mode: "live" },
    decoded: { mode: "sandbox" },
    sandboxEnabled: true,
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "MODE_TOKEN_MISMATCH");

  const r2 = evaluateModeBoundary({
    user: { mode: "sandbox" },
    decoded: { mode: "live" },
    sandboxEnabled: true,
  });
  assert.equal(r2.code, "MODE_TOKEN_MISMATCH");

  // Ancien jeton : jugé sur son drapeau.
  const r3 = evaluateModeBoundary({
    user: { mode: "live" },
    decoded: { isSandbox: true },
    sandboxEnabled: true,
  });
  assert.equal(r3.code, "MODE_TOKEN_MISMATCH");
});

test("simulation fermée ou compte désactivé : un compte sandbox n'est pas servi", () => {
  assert.equal(
    evaluateModeBoundary({ user: { mode: "sandbox" }, decoded: { mode: "sandbox" }, sandboxEnabled: false })
      .code,
    "SANDBOX_DISABLED"
  );
  assert.equal(
    evaluateModeBoundary({
      user: { mode: "sandbox", sandboxDisabledAt: new Date() },
      decoded: { mode: "sandbox" },
      sandboxEnabled: true,
    }).code,
    "SANDBOX_ACCOUNT_DISABLED"
  );
  assert.equal(
    evaluateModeBoundary({ user: { mode: "live" }, decoded: { mode: "live" }, sandboxEnabled: false }).ok,
    true
  );
});

test("le middleware applique la frontière à CHAQUE identité qu'il résout", () => {
  const src = stripComments(read("middleware/authMiddleware.js"));
  // internalProtect (x-user-id), identité assertée, identité prouvée par JWT.
  const calls = src.match(/assertModeBoundary\(req\.user/g) || [];
  assert.ok(calls.length >= 3, `attendu 3 contrôles, trouvé ${calls.length}`);
  assert.match(src, /assertModeBoundary\(req\.user, decoded\)/);
});

/* ========================================================================== */
/* 3. La fabrique d'adapters — seul aiguillage réel / simulation              */
/* ========================================================================== */

function loadSelector() {
  return require("../src/providers/providerSelector");
}

test("la fabrique REFUSE un appel sans mode", () => {
  const { getProviderAdapter } = loadSelector();
  assert.throws(() => getProviderAdapter({ rail: "mobilemoney", provider: "orange" }), {
    code: "MODE_REQUIRED",
  });
});

test("en mode sandbox, la fabrique ne rend JAMAIS un adapter réel", () => {
  const { getProviderAdapter } = loadSelector();
  const cases = [
    ["mobilemoney", "wave"],
    ["mobilemoney", "orange"],
    ["mobilemoney", "mtn"],
    ["mobilemoney", "moov"],
    ["card", "visa_direct"],
  ];

  for (const [rail, provider] of cases) {
    const sandbox = getProviderAdapter({ rail, provider, mode: "sandbox" });
    const live = getProviderAdapter({ rail, provider, mode: "live" });

    assert.equal(sandbox.sandbox, true, `${rail}/${provider} : adapter de simulation attendu`);
    assert.notEqual(live.sandbox, true, `${rail}/${provider} : adapter réel attendu en live`);
    // Même nom canonique : l'écran et l'historique sont identiques au réel.
    assert.equal(sandbox.provider, live.provider);
  }
});

test("en mode sandbox, les rails retirés et les prestataires inconnus restent refusés", () => {
  const { getProviderAdapter } = loadSelector();
  assert.throws(() => getProviderAdapter({ rail: "bank", provider: "x", mode: "sandbox" }));
  assert.throws(() => getProviderAdapter({ rail: "card", provider: "stripe", mode: "sandbox" }));
  assert.throws(() => getProviderAdapter({ rail: "mobilemoney", provider: "nope", mode: "sandbox" }));
});

test("chaque appel de la fabrique dans le code passe un mode explicite", () => {
  const files = [
    "services/transactions/providers/mobilemoneyExecutor.js",
    "services/transactions/providers/cardExecutor.js",
    "services/collections/collectionService.js",
    "services/cagnotte/guestRefundRepo.js",
    "controllers/providerWebhookController.js",
  ];

  for (const rel of files) {
    const src = stripComments(read(rel));
    const calls = src.match(/getProviderAdapter\(\{[^}]*\}\)/g) || [];
    assert.ok(calls.length > 0, `${rel} : appel attendu`);
    for (const call of calls) {
      assert.match(call, /mode/, `${rel} : appel sans mode — ${call}`);
    }
  }
});

test("plus aucun repli silencieux sur l'opérateur « wave »", () => {
  const src = stripComments(read("services/transactions/providers/mobilemoneyExecutor.js"));
  assert.doesNotMatch(src, /\|\|\s*["']wave["']/);
});

/* ========================================================================== */
/* 4. Les adapters de simulation — même interface, aucun réseau               */
/* ========================================================================== */

const REAL_ADAPTERS = {
  wave: require("../src/providers/mobilemoney/waveAdapter"),
  orange: require("../src/providers/mobilemoney/orangeAdapter"),
  mtn: require("../src/providers/mobilemoney/mtnAdapter"),
  moov: require("../src/providers/mobilemoney/moovAdapter"),
  visa_direct: require("../src/providers/card/visaDirectAdapter"),
};

function fakeDeps(scenarioValue = scenario.DEFAULT_SCENARIO) {
  const calls = [];
  return {
    calls,
    deps: {
      loadScenario: async () => scenarioValue,
      scheduleProviderEvent: async (args) => {
        calls.push(args);
        return args.plan.requiresThreeDS
          ? {
              providerReference: args.providerReference,
              requiresAction: true,
              nextAction: {
                type: "redirect_to_url",
                redirectToUrl: { path: "/api/v1/sandbox/3ds/abcdefghijklmnopqrstuvwxyz" },
              },
            }
          : { providerReference: args.providerReference, requiresAction: false, nextAction: null };
      },
    },
  };
}

test("parité de surface : chaque adapter de simulation expose l'interface du réel", () => {
  for (const [name, real] of Object.entries(REAL_ADAPTERS)) {
    const rail = name === "visa_direct" ? "card" : "mobilemoney";
    const sbx = makeSandboxAdapter({ rail, realAdapter: real, deps: fakeDeps().deps });

    for (const key of Object.keys(real)) {
      assert.ok(key in sbx, `${name} : clé « ${key} » absente de l'adapter de simulation`);
      assert.equal(typeof sbx[key], typeof real[key], `${name}.${key} : type différent`);
    }
  }
});

test("un adapter de simulation refuse une transaction live", async () => {
  const sbx = makeSandboxAdapter({
    rail: "mobilemoney",
    realAdapter: REAL_ADAPTERS.orange,
    deps: fakeDeps().deps,
  });

  await assert.rejects(
    () => sbx.payout({ tx: { _id: "t1", mode: "live", userId: "u1" } }),
    { code: "MODE_MISMATCH" }
  );
});

test("l'ordre de simulation est accepté, planifié avec le scénario, et marqué fabriqué", async () => {
  const { deps, calls } = fakeDeps({ outcome: "failure", confirmationDelaySeconds: 7 });
  const sbx = makeSandboxAdapter({ rail: "mobilemoney", realAdapter: REAL_ADAPTERS.mtn, deps });

  const result = await sbx.payout({ tx: { _id: "t1", mode: "sandbox", userId: "u1" } });

  assert.equal(result.ok, true);
  assert.equal(result.externalStatus, "PENDING");
  assert.equal(result.raw.mock, true);
  assert.match(result.providerReference, /^SBX_MOBILEMONEY_PAYOUT_/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plan.settle, "failure");
  assert.equal(calls[0].plan.delaySeconds, 7);
  assert.equal(calls[0].kind, "payout");
});

test("un dépôt par carte rend une authentification 3-D Secure à effectuer", async () => {
  const { deps } = fakeDeps();
  const sbx = makeSandboxAdapter({ rail: "card", realAdapter: REAL_ADAPTERS.visa_direct, deps });

  const result = await sbx.collect({ tx: { _id: "t2", mode: "sandbox", userId: "u1" } });

  assert.equal(result.externalStatus, "REQUIRES_ACTION");
  assert.equal(result.nextAction.type, "redirect_to_url");
});

test("un rappel HTTP ne peut pas viser un prestataire de simulation", async () => {
  const sbx = makeSandboxAdapter({
    rail: "mobilemoney",
    realAdapter: REAL_ADAPTERS.wave,
    deps: fakeDeps().deps,
  });
  await assert.rejects(() => sbx.parseWebhook({ body: {} }), {
    code: "SANDBOX_WEBHOOK_FORBIDDEN",
  });
});

/* ========================================================================== */
/* 5. Scénarios                                                               */
/* ========================================================================== */

test("un scénario invalide est refusé, jamais ramené au défaut", () => {
  assert.throws(() => scenario.normalizeScenario({ outcome: "maybe", confirmationDelaySeconds: 3 }), {
    code: "INVALID_SANDBOX_SCENARIO",
  });
  assert.throws(() => scenario.normalizeScenario({ outcome: "success", confirmationDelaySeconds: 500 }), {
    code: "INVALID_SANDBOX_SCENARIO",
  });
  assert.throws(() => scenario.normalizeScenario({ outcome: "success", confirmationDelaySeconds: 1.5 }), {
    code: "INVALID_SANDBOX_SCENARIO",
  });
});

test("chaque issue produit le plan attendu", () => {
  const plan = (outcome, kind, rail) =>
    scenario.planProviderOutcome({ scenario: { outcome, confirmationDelaySeconds: 2 }, kind, rail });

  assert.equal(plan("success", "payout", "mobilemoney").settle, "success");
  assert.equal(plan("pending", "payout", "mobilemoney").settle, null);
  assert.equal(plan("failure", "collect", "mobilemoney").failureCode, "PROVIDER_DECLINED");
  assert.equal(
    plan("insufficient_funds", "collect", "mobilemoney").failureCode,
    "PAYER_INSUFFICIENT_FUNDS"
  );
  assert.equal(
    plan("insufficient_funds", "collect", "card").failureCode,
    "CARD_DECLINED_INSUFFICIENT_FUNDS"
  );
  assert.equal(plan("success", "collect", "card").requiresThreeDS, true);
  assert.equal(plan("success", "payout", "card").requiresThreeDS, false);
  assert.equal(scenario.planThreeDSDecline().failureCode, "THREE_DS_AUTHENTICATION_FAILED");
});

/* ========================================================================== */
/* 6. Trésoreries et grand livre                                              */
/* ========================================================================== */

test("une opération sandbox ne vise JAMAIS une vraie trésorerie", () => {
  assert.equal(treasurySystemTypeForMode("FEES_TREASURY", "sandbox"), "SANDBOX_FEES_TREASURY");
  assert.equal(treasurySystemTypeForMode("FX_MARGIN_TREASURY", "sandbox"), "SANDBOX_FX_MARGIN_TREASURY");
  assert.equal(treasurySystemTypeForMode("FEES_TREASURY", "live"), "FEES_TREASURY");

  // Rôles non ouverts à la simulation : refus, pas de repli sur le réel.
  assert.throws(() => treasurySystemTypeForMode("REFERRAL_TREASURY", "sandbox"), {
    code: "SANDBOX_TREASURY_UNSUPPORTED",
  });
  assert.equal(
    treasurySystemTypeForMode("CAGNOTTE_FEES_TREASURY", "sandbox"),
    "SANDBOX_CAGNOTTE_FEES_TREASURY"
  );
  // Et une opération live ne vise jamais une trésorerie de simulation.
  assert.throws(() => treasurySystemTypeForMode("SANDBOX_FEES_TREASURY", "live"), {
    code: "MODE_MISMATCH",
  });
  assert.throws(() => treasurySystemTypeForMode("FEES_TREASURY", undefined), {
    code: "MODE_REQUIRED",
  });
});

test("le registre connaît les trésoreries de simulation sans les mêler aux vraies", () => {
  const { registry } = buildRegistry([
    { systemType: "FEES_TREASURY", userId: "live-fees", isActive: true },
    { systemType: "SANDBOX_FEES_TREASURY", userId: "sbx-fees", isActive: true },
  ]);
  assert.equal(registry.get("FEES_TREASURY"), "live-fees");
  assert.equal(registry.get("SANDBOX_FEES_TREASURY"), "sbx-fees");
});

test("la balance de vérification s'équilibre PAR MODE — un transfert entre mondes se voit", () => {
  const leg = (mode, direction) => ({
    mode,
    direction,
    currency: "XOF",
    amount: 100,
    metadata: { ledgerVersion: 99 },
  });

  // Débit en simulation, crédit en production : la somme globale s'équilibre,
  // chaque mode pris seul ne s'équilibre pas.
  const byMode = computeTrialBalanceByMode([leg("sandbox", "DEBIT"), leg("live", "CREDIT")]);
  assert.equal(byMode.sandbox.balanced, false);
  assert.equal(byMode.live.balanced, false);

  const ok = computeTrialBalanceByMode([leg("sandbox", "DEBIT"), leg("sandbox", "CREDIT")]);
  assert.equal(ok.sandbox.balanced, true);

  assert.equal(sandboxFundingClearingAccountId("xof"), "system_clearing:SANDBOX_FUNDING:XOF");
});

/* ── ledgerService avec doublures ────────────────────────────────────────── */

function loadLedgerWithFakes() {
  const written = [];
  const walletCalls = [];
  const systemCalls = [];

  const wallet = {};
  for (const op of ["reserve", "captureReserve", "releaseReserve", "credit", "debit"]) {
    wallet[op] = async (...args) => {
      walletCalls.push({ op, opts: args[3] });
      return { ok: true };
    };
  }

  const system = {
    async credit(...args) {
      systemCalls.push({ op: "credit", args });
      return { ok: true };
    },
    async debit(...args) {
      systemCalls.push({ op: "debit", args });
      return { ok: true };
    },
  };

  const LedgerEntry = {
    async insertMany(docs) {
      written.push(docs);
      return docs;
    },
    async create(docs) {
      written.push(docs);
      return docs;
    },
  };

  const models = { LedgerEntry, TxWalletBalance: wallet, TxSystemBalance: system };
  const conn = {
    models,
    getClient: () => ({ id: "client" }),
    model: (name) => models[name],
  };

  const dbPath = require.resolve("../src/config/db");
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { getTxConn: () => conn, getUsersConn: () => conn },
  };

  const svcPath = require.resolve("../src/services/ledgerService");
  delete require.cache[svcPath];
  delete require.cache[require.resolve("../src/models/LedgerEntry")];
  delete require.cache[require.resolve("../src/models/TxWalletBalance")];
  delete require.cache[require.resolve("../src/models/TxSystemBalance")];

  return { ledger: require("../src/services/ledgerService"), written, walletCalls, systemCalls };
}

const BALANCED = [
  { accountType: "USER_WALLET", accountId: "user_wallet:a:XOF", direction: "DEBIT", amount: 10, currency: "XOF" },
  { accountType: "SYSTEM_CLEARING", accountId: "system_clearing:XOF", direction: "CREDIT", amount: 10, currency: "XOF" },
];

test("postDoubleEntry REFUSE un lot sans mode — et le pose sur chaque jambe sinon", async () => {
  const { ledger, written } = loadLedgerWithFakes();

  await assert.rejects(
    () => ledger.postDoubleEntry({ transactionId: "t", entryType: "RESERVE", legs: BALANCED }),
    { code: "MODE_REQUIRED" }
  );
  assert.equal(written.length, 0, "rien ne doit être écrit");

  await ledger.postDoubleEntry({ mode: "sandbox", transactionId: "t", entryType: "RESERVE", legs: BALANCED });
  assert.ok(written[0].every((d) => d.mode === "sandbox"));
});

test("les primitives propagent le mode de la transaction au portefeuille et aux écritures", async () => {
  const { ledger, written, walletCalls } = loadLedgerWithFakes();
  const tx = { _id: "1a1a1a1a1a1a1a1a1a1a1a1a", reference: "R", mode: "sandbox", flow: "X" };

  await ledger.reserveSenderFunds({ transaction: tx, senderId: "u1", amount: 100, currency: "XOF" });

  assert.equal(walletCalls[0].opts.mode, "sandbox");
  assert.ok(written[0].every((d) => d.mode === "sandbox"));

  await assert.rejects(
    () =>
      ledger.reserveSenderFunds({
        transaction: { ...tx, mode: undefined },
        senderId: "u1",
        amount: 100,
        currency: "XOF",
      }),
    { code: "MODE_REQUIRED" }
  );
});

test("les frais d'une transaction sandbox vont à la trésorerie de SIMULATION, jamais à la vraie", async () => {
  const { ledger, written, systemCalls } = loadLedgerWithFakes();

  await loadTreasuryRegistry({
    collection: () => ({
      find: () => ({
        toArray: async () => [
          { systemType: "FEES_TREASURY", userId: "bbbbbbbbbbbbbbbbbbbbbbbb", isActive: true },
          { systemType: "SANDBOX_FEES_TREASURY", userId: "cccccccccccccccccccccccc", isActive: true },
        ],
      }),
    }),
  });

  try {
    await ledger.chargeCancellationFee({
      transaction: { _id: "1a1a1a1a1a1a1a1a1a1a1a1a", reference: "R", mode: "sandbox" },
      senderId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      senderCurrency: "XOF",
      feeSourceAmount: 100,
      // Un identifiant explicite de VRAIE trésorerie, comme en porteraient les
      // métadonnées d'une transaction : il doit être ignoré en simulation.
      treasuryUserId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      treasurySystemType: "FEES_TREASURY",
      treasuryFeeAmount: 100,
      treasuryFeeCurrency: "XOF",
    });

    assert.equal(systemCalls[0].args[0], "cccccccccccccccccccccccc");
    assert.equal(systemCalls[0].args[1], "SANDBOX_FEES_TREASURY");

    const treasuryLeg = written.flat().find((d) => d.accountType === "TREASURY");
    assert.match(treasuryLeg.accountId, /^treasury:SANDBOX_FEES_TREASURY:cccc/);
    assert.ok(written.flat().every((d) => d.mode === "sandbox"));
  } finally {
    resetTreasuryRegistry();
  }
});

test("le robinet de simulation refuse une opération live", async () => {
  const { ledger, written } = loadLedgerWithFakes();

  await assert.rejects(
    () =>
      ledger.applySandboxFunding({
        operation: { _id: "1a1a1a1a1a1a1a1a1a1a1a1a", mode: "live", kind: "FAUCET" },
        userId: "aaaaaaaaaaaaaaaaaaaaaaaa",
        currency: "XOF",
        amount: 1000,
        direction: "credit",
      }),
    { code: "MODE_MISMATCH" }
  );
  assert.equal(written.length, 0);
});

test("le robinet crédite DEPUIS le compte d'argent fictif, en mode sandbox", async () => {
  const { ledger, written, walletCalls } = loadLedgerWithFakes();

  await ledger.applySandboxFunding({
    operation: { _id: "1a1a1a1a1a1a1a1a1a1a1a1a", mode: "sandbox", kind: "FAUCET", reference: "SBX" },
    userId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    currency: "XOF",
    amount: 1000,
    direction: "credit",
  });

  assert.equal(walletCalls[0].op, "credit");
  assert.equal(walletCalls[0].opts.mode, "sandbox");
  const legs = written[0];
  assert.equal(legs.find((l) => l.direction === "DEBIT").accountId, "system_clearing:SANDBOX_FUNDING:XOF");
  assert.equal(legs.find((l) => l.direction === "CREDIT").accountId, "user_wallet:aaaaaaaaaaaaaaaaaaaaaaaa:XOF");
});

/* ========================================================================== */
/* 7. Modèles : le mode est requis, sans défaut, immuable                     */
/* ========================================================================== */

test("Transaction, LedgerEntry et TxWalletBalance exigent un mode immuable, sans défaut", () => {
  const mongoose = require("mongoose");
  const conn = mongoose.createConnection();

  for (const name of ["Transaction", "LedgerEntry", "TxWalletBalance"]) {
    const Model = require(`../src/models/${name}`)(conn);
    const p = Model.schema.path("mode");
    assert.ok(p, `${name}.mode absent`);
    assert.equal(p.isRequired, true, `${name}.mode doit être requis`);
    assert.equal(p.options.immutable, true, `${name}.mode doit être immuable`);
    assert.equal(p.options.default, undefined, `${name}.mode ne doit avoir aucun défaut`);
  }
});

test("chaque mouvement de portefeuille exige le mode", () => {
  const src = stripComments(read("models/TxWalletBalance.js"));
  for (const op of ["ensureWallet", "credit", "debit", "reserve", "releaseReserve", "captureReserve", "cancelReservedWithFee"]) {
    const start = src.indexOf(`balanceSchema.statics.${op} = async function`);
    assert.ok(start > -1, `${op} introuvable`);
    const next = src.indexOf("balanceSchema.statics.", start + 10);
    const body = src.slice(start, next === -1 ? undefined : next);
    assert.match(body, /splitModeOpts\(/, `${op} ne vérifie pas le mode`);
  }
});

/* ========================================================================== */
/* 8. Règlement, rappels simulés et 3DS                                       */
/* ========================================================================== */

test("un rappel simulé porte son mode et ne peut naître que du worker", () => {
  const payload = buildSandboxSettlementPayload({
    _id: "e1",
    transactionId: "t1",
    providerReference: "SBX_X",
    provider: "orange",
    rail: "mobilemoney",
    settle: "failure",
    failureCode: "PROVIDER_DECLINED",
  });

  assert.equal(payload.sourceMode, "sandbox");
  assert.equal(payload.status, "failed");
  assert.equal(payload.eventId, "sbx_e1");

  // Le contrôleur HTTP reconstruit la charge depuis des champs nommés : un
  // `sourceMode` envoyé par un tiers n'y passe pas.
  const controller = stripComments(read("controllers/providerWebhookController.js"));
  assert.doesNotMatch(controller, /sourceMode/);
});

test("le moteur de règlement refuse un rappel venu de l'autre monde, AVANT tout mouvement", () => {
  const src = stripComments(read("controllers/externalSettlementController.js"));
  const guard = src.indexOf('payload.sourceMode === "sandbox"');
  const firstMove = src.indexOf("hasWebhookEventBeenSeen(tx, payload)", guard);
  assert.ok(guard > -1, "garde de mode absente du règlement");
  assert.ok(firstMove > guard, "la garde doit précéder le traitement du rappel");
});

test("l'action suivante n'est jamais un redirecteur ouvert", () => {
  const ok = { type: "redirect_to_url", redirectToUrl: { path: "/api/v1/sandbox/3ds/abcdefghijklmnopqrstuvwx" } };
  assert.deepEqual(sanitizeNextAction(ok), ok);

  for (const path of [
    "https://evil.example/3ds",
    "//evil.example/api/v1/sandbox/3ds/abcdefghijklmnop",
    "/api/v1/transactions/abc",
    "/api/v1/sandbox/3ds/short",
    "/api/v1/sandbox/3ds/abcdefghijklmnopqrst?x=1",
  ]) {
    assert.equal(sanitizeNextAction({ type: "redirect_to_url", redirectToUrl: { path } }), null, path);
  }
  assert.equal(sanitizeNextAction({ type: "other" }), null);
});

/* ========================================================================== */
/* 9. Historique et ancien raccourci                                          */
/* ========================================================================== */

test("la fenêtre d'historique ne concerne que les comptes sandbox réinitialisés", async () => {
  const start = new Date("2026-10-06T10:00:00Z");
  assert.deepEqual(applyHistoryStart({ userId: "u" }, null), { userId: "u" });
  assert.deepEqual(applyHistoryStart({ userId: "u" }, start), {
    $and: [{ userId: "u" }, { createdAt: { $gte: start } }],
  });

  let reads = 0;
  const getProfile = async () => {
    reads += 1;
    return { historyStartsAt: start };
  };

  assert.equal(await resolveHistoryStart({ user: { _id: "u", mode: "live" } }, { getProfile }), null);
  assert.equal(reads, 0, "un compte live ne déclenche aucune lecture");
  assert.deepEqual(
    await resolveHistoryStart({ user: { _id: "u", mode: "sandbox" } }, { getProfile }),
    start
  );
});

test("l'ancien raccourci Apple Review a disparu du moteur", () => {
  for (const gone of [
    "services/sandboxTransaction.service.js",
    "utils/sandboxProviderGuard.js",
    "utils/sandboxUser.js",
  ]) {
    assert.equal(fs.existsSync(path.join(SRC, gone)), false, `${gone} existe encore`);
  }

  const handlers = [
    "services/transactions/handlers/initiateByFlow.js",
    "services/transactions/handlers/submitExternalExecution.js",
    "services/transactions/handlers/confirmTransaction.js",
    "services/transactions/handlers/cancelTransaction.js",
  ];

  for (const rel of handlers) {
    const src = stripComments(read(rel));
    assert.doesNotMatch(src, /isSandbox(User|Tx|Transaction)\(/, `${rel} : branche sandbox`);
    assert.doesNotMatch(src, /apple_review_sandbox/, `${rel} : raccourci Apple Review`);
  }
});

test("les tableaux de bord de trésorerie et la réconciliation écartent la simulation", () => {
  assert.match(
    stripComments(read("controllers/internalTreasuryAnalytics.controller.js")),
    /\$match: liveOnlyFilter\(\)/
  );
  assert.match(
    stripComments(read("services/reconciliation/transactionReconciliationService.js")),
    /mode: \{ \$ne: "sandbox" \}/
  );
});

test("le parrainage n'est jamais déclenché par une transaction sandbox", () => {
  assert.equal(accountMode.isReferralEligibleMode("sandbox"), false);
  assert.equal(accountMode.isReferralEligibleMode("live"), true);
  for (const rel of [
    "controllers/externalSettlementController.js",
    "services/transactions/handlers/confirmTransaction.js",
  ]) {
    assert.match(stripComments(read(rel)), /isReferralEligibleMode\(tx\?\.mode\)/, rel);
  }
});

/* ========================================================================== */
/* 10. Cagnottes de simulation                                                */
/* ========================================================================== */

const { scopeOfCagnotte, assertUserInCagnotteScope } = require("../src/services/cagnotte/cagnotteScope");
const { openPosition, assertPositionIdentity } = require("../src/services/cagnotte/vaultPosition");

test("une cagnotte prend le mode de son créateur ; un document ancien hérite du propriétaire", () => {
  assert.deepEqual(scopeOfCagnotte({ mode: "sandbox", sandboxGroupId: "g1" }), {
    mode: "sandbox",
    sandboxGroupId: "g1",
  });
  assert.equal(scopeOfCagnotte({}, { isSandbox: true }).mode, "sandbox");
  assert.equal(scopeOfCagnotte({}, { mode: "live" }).mode, "live");
});

test("une cagnotte de simulation est INTROUVABLE hors de son monde et de son groupe", () => {
  const scope = { mode: "sandbox", sandboxGroupId: "g1" };

  assert.equal(assertUserInCagnotteScope({ mode: "sandbox", sandboxGroupId: "g1" }, scope), "sandbox");
  assert.throws(() => assertUserInCagnotteScope({ mode: "live" }, scope), { code: "CAGNOTTE_NOT_FOUND" });
  assert.throws(() => assertUserInCagnotteScope({ mode: "sandbox", sandboxGroupId: "g2" }, scope), {
    code: "CAGNOTTE_NOT_FOUND",
  });
  // Et une cagnotte réelle n'est pas atteignable par un compte de simulation.
  assert.throws(() => assertUserInCagnotteScope({ mode: "sandbox", sandboxGroupId: "g1" }, { mode: "live" }), {
    code: "CAGNOTTE_NOT_FOUND",
  });
});

test("le coffre ne s'ouvre pas sans mode, et refuse une opération de l'autre monde", async () => {
  await assert.rejects(
    () => openPosition({ Model: {}, vaultId: "v", cagnotteId: "c", currency: "XOF" }),
    { code: "MODE_REQUIRED" }
  );

  assert.throws(
    () => assertPositionIdentity({ mode: "sandbox", currency: "XOF", cagnotteId: "c" }, { mode: "live" }),
    { code: "VAULT_MODE_MISMATCH" }
  );
  // Position antérieure à la migration : production.
  assert.throws(
    () => assertPositionIdentity({ currency: "XOF", cagnotteId: "c" }, { mode: "sandbox" }),
    { code: "VAULT_MODE_MISMATCH" }
  );
});

test("les écritures de cagnotte exigent le mode ; les frais de simulation vont à la trésorerie fictive", async () => {
  const { ledger, written } = loadLedgerWithFakes();

  await assert.rejects(
    () =>
      ledger.postCagnotteVaultWithdrawalEntries({
        settlementId: "1a1a1a1a1a1a1a1a1a1a1a1a",
        reference: "R",
        beneficiary: { userId: "aaaaaaaaaaaaaaaaaaaaaaaa", amount: 100, currency: "XOF" },
      }),
    { code: "MODE_REQUIRED" }
  );
  assert.equal(written.length, 0);

  await loadTreasuryRegistry({
    collection: () => ({
      find: () => ({
        toArray: async () => [
          { systemType: "CAGNOTTE_FEES_TREASURY", userId: "bbbbbbbbbbbbbbbbbbbbbbbb", isActive: true },
          { systemType: "SANDBOX_CAGNOTTE_FEES_TREASURY", userId: "cccccccccccccccccccccccc", isActive: true },
        ],
      }),
    }),
  });

  try {
    await ledger.postCagnotteClosureFeeEntries({
      mode: "sandbox",
      settlementId: "1a1a1a1a1a1a1a1a1a1a1a1a",
      reference: "R",
      // Identifiant de la VRAIE trésorerie passé par l'appelant : ignoré en simulation.
      feeCredit: {
        treasuryUserId: "bbbbbbbbbbbbbbbbbbbbbbbb",
        treasurySystemType: "CAGNOTTE_FEES_TREASURY",
        amount: 500,
        currency: "XOF",
      },
    });

    const legs = written.flat();
    assert.ok(legs.every((d) => d.mode === "sandbox"));
    assert.match(
      legs.find((d) => d.accountType === "TREASURY").accountId,
      /^treasury:SANDBOX_CAGNOTTE_FEES_TREASURY:cccc/
    );
  } finally {
    resetTreasuryRegistry();
  }
});

test("chaque règlement de cagnotte relit le mode de la cagnotte et filtre le portefeuille", () => {
  const controllers = [
    "controllers/cagnotteSettlementController.js",
    "controllers/cagnotteVaultWithdrawalSettlementController.js",
    "controllers/cagnotteClosureFeesSettlementController.js",
    "controllers/cagnotteExternalSettlementController.js",
  ];

  for (const rel of controllers) {
    const src = stripComments(read(rel));
    assert.match(src, /loadCagnotteScope\(/, `${rel} : mode de la cagnotte non relu`);
    assert.doesNotMatch(src, /mode: \{ \$ne: "sandbox" \}/, `${rel} : filtre de mode figé`);
  }
});

test("un invité ne peut pas payer une cagnotte de simulation", () => {
  const src = stripComments(read("services/collections/collectionService.js"));
  assert.match(src, /SANDBOX_GUEST_PAYMENT_DISABLED/);
});
