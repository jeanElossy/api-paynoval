"use strict";

/**
 * Remboursement d'un INVITÉ vers son opérateur mobile money (2026-09-15).
 *
 * Avant : 501 `REFUND_REQUIRES_PAYOUT` — un invité ne pouvait pas être
 * remboursé. Ces tests verrouillent l'ordre de l'argent : réserver (coffre
 * débité, grand livre écrit) PUIS verser ; un refus rend l'argent au coffre UNE
 * fois ; une absence de réponse ne contre-passe RIEN ; un rejeu ne débite pas
 * deux fois ; le numéro doit correspondre au payeur d'origine.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  STATUS,
  OPEN_STATUSES,
  normalizePayoutPhone,
  phoneLast4,
  payoutOutcome,
  refundToJSON,
  initiateGuestRefund,
  handleGuestRefundWebhook,
} = require("../src/services/cagnotte/guestRefund");
const { buildCagnotteGuestRefundLots } = require("../src/services/ledger/cagnotteLegs");

const PHONE = "+225 07 12 34 56 78";

function makeWorld({ original = {}, intent = { payerPhoneLast4: "5678" }, adapter } = {}) {
  const state = {
    original: {
      _id: "ext1",
      reference: "CAGEXT-0123456789",
      schemaVersion: 2,
      rail: "mobilemoney",
      provider: "wave",
      providerReference: "PNVIN_abc",
      cagnotteId: "c1",
      vaultId: "v1",
      collected: { amount: 10000, currency: "XOF" },
      netSource: 9975,
      netToVault: { amount: 9975, currency: "XOF" },
      refunded: { source: 0, target: 0 },
      ...original,
    },
    refunds: new Map(),
    position: { balance: 50000, refunded: 0 },
    lots: [],
    reserves: 0,
    reversals: 0,
    attempts: 0,
    payouts: [],
  };

  const byId = (id) => [...state.refunds.values()].find((r) => r._id === id);

  const repo = {
    findRefundByReference: async (ref) => state.refunds.get(ref) || null,
    findExternalSettlement: async (ref) => (ref === state.original.reference ? state.original : null),
    findCollectionIntent: async () => intent,
    findRefundForWebhook: async ({ reference, providerReference }) =>
      [...state.refunds.values()].find(
        (r) => r.reference === reference || (providerReference && r.payout.providerReference === providerReference)
      ) || null,
    reserve: async ({ amounts, doc, lots }) => {
      if (state.refunds.has(doc.reference)) return { replay: true, refund: state.refunds.get(doc.reference) };
      state.reserves += 1;
      state.position.balance -= amounts.refundTarget;
      state.position.refunded += amounts.refundTarget;
      state.original.refunded.source += amounts.refundSource;
      state.original.refunded.target += amounts.refundTarget;
      const refund = { _id: `r${state.reserves}`, ...doc, payout: { ...doc.payout } };
      state.refunds.set(doc.reference, refund);
      state.lots.push(...lots);
      return { replay: false, refund };
    },
    setStatus: async (id, from, to, set = {}) => {
      const r = byId(id);
      if (!r || !from.includes(r.status)) return null;
      r.status = to;
      for (const [key, value] of Object.entries(set)) {
        if (key.startsWith("payout.")) r.payout[key.slice(7)] = value;
        else r[key] = value;
      }
      return r;
    },
    incrementAttempts: async () => {
      state.attempts += 1;
    },
    compensate: async ({ refund, error, reversalLots }) => {
      const r = state.refunds.get(refund.reference);
      if (!OPEN_STATUSES.includes(r.status)) return false;
      r.status = STATUS.REVERSED;
      r.payout.lastError = error;
      state.position.balance += r.refundTarget.amount;
      state.position.refunded -= r.refundTarget.amount;
      state.original.refunded.source -= r.refundSource.amount;
      state.original.refunded.target -= r.refundTarget.amount;
      state.lots.push(...reversalLots);
      state.reversals += 1;
      return true;
    },
  };

  const theAdapter = adapter || {
    payout: async (payload) => {
      state.payouts.push(payload);
      return { ok: true, providerReference: "WAVE_PAYOUT_1", providerStatus: "PENDING" };
    },
  };

  const deps = { repo, getAdapter: () => theAdapter, now: () => new Date("2026-09-15T12:00:00Z") };
  return { state, deps };
}

const input = (over = {}) => ({
  reference: "CAGREF-guest-0001",
  idempotencyKey: "idem-guest-0001",
  participationReference: "CAGEXT-0123456789",
  initiatedByUserId: "admin1",
  payoutPhone: PHONE,
  reason: "Doublon de paiement",
  ...over,
});

test("numéro : normalisé, 4 derniers chiffres, illisible refusé", () => {
  assert.equal(normalizePayoutPhone(PHONE), "+2250712345678");
  assert.equal(normalizePayoutPhone("07-12-34-56-78"), "0712345678");
  assert.equal(normalizePayoutPhone("abc"), null);
  assert.equal(normalizePayoutPhone("1234"), null);
  assert.equal(phoneLast4(PHONE), "5678");
});

test("statut opérateur : succès, échec, et un inconnu ne tranche rien", () => {
  assert.equal(payoutOutcome("SUCCESSFUL"), "SUCCESS");
  assert.equal(payoutOutcome("rejected"), "FAILED");
  assert.equal(payoutOutcome("PENDING"), "PENDING");
  assert.equal(payoutOutcome("QUELQUE_CHOSE"), "PENDING");
});

test("lots : coffre → sortie prestataire, équilibrés ; la contre-écriture est l'inverse exact", () => {
  const out = buildCagnotteGuestRefundLots({ rail: "mobilemoney", sourceCurrency: "XOF", targetCurrency: "XOF", refundSource: 500, refundTarget: 500 });
  const back = buildCagnotteGuestRefundLots({ rail: "mobilemoney", sourceCurrency: "XOF", targetCurrency: "XOF", refundSource: 500, refundTarget: 500, reverse: true });

  assert.equal(out.length, 1);
  const accounts = JSON.stringify(out[0].legs);
  assert.match(accounts, /system_clearing:PROVIDER_OUTBOUND:MOBILEMONEY:XOF/);
  assert.match(accounts, /CAGNOTTE_VAULT:XOF/);
  assert.equal(back[0].entryType, "REVERSAL");
  assert.match(back[0].scope, /\.reversal$/);

  const fx = buildCagnotteGuestRefundLots({ rail: "mobilemoney", sourceCurrency: "CAD", targetCurrency: "XOF", refundSource: 9.75, refundTarget: 4000 });
  assert.equal(fx.length, 2);
  assert.match(JSON.stringify(fx[1].legs), /PROVIDER_OUTBOUND:MOBILEMONEY:CAD/);
});

test("numéro qui ne correspond pas au payeur : 422, rien n'est réservé", async () => {
  const { state, deps } = makeWorld({ intent: { payerPhoneLast4: "0000" } });
  await assert.rejects(initiateGuestRefund(input(), deps), (e) => e.code === "PAYOUT_PHONE_MISMATCH" && e.status === 422);
  assert.equal(state.reserves, 0);
  assert.equal(state.position.balance, 50000);
});

test("versement accepté : coffre débité UNE fois, grand livre écrit, versement au montant source", async () => {
  const { state, deps } = makeWorld();
  const out = await initiateGuestRefund(input(), deps);

  assert.equal(out.outcome, "SUBMITTED");
  assert.equal(out.refund.status, STATUS.SUBMITTED);
  assert.equal(state.position.balance, 50000 - 9975);
  assert.equal(state.reserves, 1);
  assert.ok(state.lots.length >= 1);
  assert.equal(state.payouts.length, 1);
  assert.equal(state.payouts[0].amount, 9975);
  assert.equal(state.payouts[0].currency, "XOF");
  assert.equal(state.payouts[0].reference, "CAGREF-guest-0001", "référence stable : l'opérateur déduplique");

  const view = refundToJSON(out.refund);
  assert.equal(view.payout.phoneLast4, "5678");
  assert.doesNotMatch(JSON.stringify(view), /0712345678/, "jamais le numéro complet");
});

test("refus explicite de l'opérateur : 409, coffre recrédité, contre-écriture passée", async () => {
  const { state, deps } = makeWorld({
    adapter: { payout: async () => ({ ok: false, errorCode: "INVALID_MSISDN" }) },
  });

  await assert.rejects(initiateGuestRefund(input(), deps), (e) => e.code === "PAYOUT_REFUSED");
  assert.equal(state.position.balance, 50000);
  assert.equal(state.original.refunded.target, 0);
  assert.equal(state.reversals, 1);
  assert.equal(state.refunds.get("CAGREF-guest-0001").status, STATUS.REVERSED);
  assert.ok(state.lots.some((l) => l.entryType === "REVERSAL" && /\.reversal$/.test(l.scope)));
});

test("aucune réponse de l'opérateur : INCERTAIN, rien n'est contre-passé", async () => {
  const { state, deps } = makeWorld({
    adapter: {
      payout: async () => {
        throw new Error("timeout");
      },
    },
  });

  const out = await initiateGuestRefund(input(), deps);
  assert.equal(out.outcome, "UNCERTAIN");
  assert.equal(state.refunds.get("CAGREF-guest-0001").status, STATUS.UNCERTAIN);
  assert.equal(state.reversals, 0, "l'argent a peut-être quitté l'opérateur : on ne le rend pas au coffre");
  assert.equal(state.position.balance, 50000 - 9975);
});

test("rejeu d'un remboursement incertain : resoumis avec la même référence, JAMAIS re-débité", async () => {
  let calls = 0;
  const { state, deps } = makeWorld({
    adapter: {
      payout: async (payload) => {
        calls += 1;
        if (calls === 1) throw new Error("timeout");
        return { ok: true, providerReference: "WAVE_PAYOUT_2", providerStatus: "PENDING", reference: payload.reference };
      },
    },
  });

  await initiateGuestRefund(input(), deps);
  const again = await initiateGuestRefund(input(), deps);

  assert.equal(again.alreadyProcessed, true);
  assert.equal(again.outcome, "SUBMITTED");
  assert.equal(state.reserves, 1);
  assert.equal(state.position.balance, 50000 - 9975);
  assert.equal(state.attempts, 2);
});

test("rejeu après soumission : aucun nouvel appel à l'opérateur", async () => {
  const { state, deps } = makeWorld();
  await initiateGuestRefund(input(), deps);
  const again = await initiateGuestRefund(input(), deps);
  assert.equal(again.alreadyProcessed, true);
  assert.equal(state.payouts.length, 1);
});

test("refus en amont : carte, participation v1, payeur invérifiable, numéro illisible", async () => {
  await assert.rejects(
    initiateGuestRefund(input(), makeWorld({ original: { rail: "card", provider: "visa_direct" } }).deps),
    (e) => e.code === "CARD_REFUND_UNSUPPORTED" && e.status === 501
  );
  await assert.rejects(
    initiateGuestRefund(input(), makeWorld({ original: { schemaVersion: 1 } }).deps),
    (e) => e.code === "LEGACY_SETTLEMENT_NOT_REFUNDABLE"
  );
  await assert.rejects(
    initiateGuestRefund(input(), makeWorld({ intent: null }).deps),
    (e) => e.code === "PAYER_UNVERIFIABLE"
  );
  await assert.rejects(
    initiateGuestRefund(input({ payoutPhone: "n/a" }), makeWorld().deps),
    (e) => e.code === "PAYOUT_PHONE_INVALID"
  );
});

test("rappel opérateur : échec → contre-écriture UNE seule fois ; succès → acquis ; inconnu → null", async () => {
  const failing = makeWorld();
  await initiateGuestRefund(input(), failing.deps);

  const first = await handleGuestRefundWebhook({ reference: "CAGREF-guest-0001", providerStatus: "FAILED" }, failing.deps);
  const second = await handleGuestRefundWebhook({ providerReference: "WAVE_PAYOUT_1", providerStatus: "FAILED" }, failing.deps);

  assert.equal(first.body.status, STATUS.REVERSED);
  assert.equal(second.statusCode, 200);
  assert.equal(failing.state.reversals, 1, "le rejeu du rappel ne rend pas l'argent deux fois");
  assert.equal(failing.state.position.balance, 50000);

  const ok = makeWorld();
  await initiateGuestRefund(input(), ok.deps);
  const done = await handleGuestRefundWebhook({ reference: "CAGREF-guest-0001", providerStatus: "SUCCESSFUL" }, ok.deps);
  assert.equal(done.body.status, STATUS.SUCCEEDED);
  assert.equal(ok.state.reversals, 0);

  assert.equal(await handleGuestRefundWebhook({ reference: "PNVIN_autre", providerStatus: "SUCCESS" }, ok.deps), null);
});

test("câblage : le rappel est examiné AVANT l'encaissement, et le dépôt garde ses écritures", () => {
  const ctrl = fs.readFileSync(path.join(__dirname, "..", "src", "controllers", "providerWebhookController.js"), "utf8");
  const refund = ctrl.indexOf("await handleGuestRefundWebhook(req.body, guestRefundDeps())");
  const collection = ctrl.indexOf("result = await traiterCommeEncaissement(req.body);");
  assert.ok(refund > 0 && refund < collection);

  const repo = fs.readFileSync(path.join(__dirname, "..", "src", "services", "cagnotte", "guestRefundRepo.js"), "utf8");
  assert.match(repo, /CONCURRENT_REFUND/);
  assert.match(repo, /debitPosition\(\{[\s\S]*?kind: "REFUND"/);
  assert.match(repo, /status: \{ \$in: OPEN_STATUSES \}/, "contre-passation gardée par l'état");
  assert.match(repo, /reverseRefundDebit\(/);

  const controller = fs.readFileSync(path.join(__dirname, "..", "src", "controllers", "cagnotteGuestRefundController.js"), "utf8");
  assert.doesNotMatch(controller, /logger\.[a-z]+\([^)]*payoutPhone/, "le numéro n'est jamais journalisé");
});
