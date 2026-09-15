"use strict";

/**
 * ============================================================================
 * MODULE CAGNOTTE — LES INVARIANTS DU CHEMIN DE L'ARGENT (2026-09-10)
 * ============================================================================
 *
 * Chaque bloc verrouille un défaut réellement trouvé, et doit ÉCHOUER si on le
 * réintroduit :
 *
 *   R-14  un taux fourni par le client créait de la monnaie ;
 *   R-15  la devise d'une cagnotte alimentée pouvait être re-libellée ;
 *   R-16  la conversion n'existait pas au grand livre ;
 *   ENUM  le chemin invité écrivait un type d'écriture absent du modèle.
 *
 * La matrice des devises n'est PAS codée en dur : elle se dérive de la liste
 * configurée (`CAGNOTTE_SUPPORTED_CURRENCIES`), et chaque corridor A→A, A→B,
 * B→A y est exercé.
 *
 * Tests PURS : aucune connexion Mongo, aucun serveur.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  supportedCagnotteCurrencies,
  assertSupportedCagnotteCurrency,
  cagnotteCurrencyMatrix,
  DEFAULT_CAGNOTTE_CURRENCIES,
} = require("../src/services/cagnotte/currencies");
const {
  buildCagnotteCreditLots,
  buildCagnotteRefundLots,
  computeRefundAmounts,
} = require("../src/services/ledger/cagnotteLegs");
const {
  normalizeParticipationQuote,
  computeCagnottePricing,
  mapPricingError,
  TX_TYPES,
} = require("../src/services/cagnotte/participationPricing");
const {
  diagnoseCreditRefusal,
  diagnoseDebitRefusal,
  assertPositionIdentity,
} = require("../src/services/cagnotte/vaultPosition");
const { checkBalanced } = require("../src/services/ledger/doubleEntry");
const { computeQuote, roundMoney, decimalsForCurrency } = require("../src/services/pricing/pricingEngine");

const SRC = path.join(__dirname, "..", "src");

function sansCommentaires(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function code(rel) {
  return sansCommentaires(fs.readFileSync(path.join(SRC, rel), "utf8"));
}

const FEES = { userId: "cccccccccccccccccccccccc", systemType: "CAGNOTTE_FEES_TREASURY" };
const FX_MARGIN = { userId: "abababababababababababab", systemType: "FX_MARGIN_TREASURY" };
const PAYER = "dddddddddddddddddddddddd";

const MATRIX = cagnotteCurrencyMatrix(supportedCagnotteCurrencies({}));

/** Montants plausibles, à la bonne précision pour chaque devise. */
function amountsFor(from, to) {
  const gross = decimalsForCurrency(from) === 0 ? 100000 : 150;
  const fee = roundMoney(gross * 0.0025, from);
  const netSource = roundMoney(gross - fee, from);
  const netTarget = from === to ? netSource : decimalsForCurrency(to) === 0 ? 65432 : 98.76;
  const fxRevenue = from === to ? 0 : decimalsForCurrency(to) === 0 ? 321 : 0.48;
  return { gross, fee, netSource, netTarget, fxRevenue };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Devises                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

test("devises : la liste par défaut couvre les six devises du coffre, et la matrice est n²", () => {
  assert.deepEqual(supportedCagnotteCurrencies({}), [...DEFAULT_CAGNOTTE_CURRENCIES]);
  const n = DEFAULT_CAGNOTTE_CURRENCIES.length;
  assert.equal(MATRIX.length, n * n);
  assert.equal(MATRIX.filter((c) => !c.fxRequired).length, n, "exactement n corridors sans conversion (A→A)");

  for (const { from, to } of MATRIX) {
    assert.ok(
      MATRIX.some((c) => c.from === to && c.to === from),
      `corridor inverse ${to}→${from} absent : le FX doit être bidirectionnel`
    );
  }
});

test("devises : la liste se configure, et une configuration fausse ÉCHOUE au lieu d'être remplacée", () => {
  assert.deepEqual(supportedCagnotteCurrencies({ CAGNOTTE_SUPPORTED_CURRENCIES: "xof, cad,XOF" }), ["XOF", "CAD"]);
  assert.throws(
    () => supportedCagnotteCurrencies({ CAGNOTTE_SUPPORTED_CURRENCIES: "XOF,FCFA" }),
    (e) => e.code === "CAGNOTTE_CURRENCIES_MISCONFIGURED"
  );
});

test("devises : aucune normalisation « intelligente » — FCFA, USDT et vide sont REFUSÉS", () => {
  for (const bad of ["FCFA", "USDT", "", null, "US", "cad$"]) {
    assert.throws(
      () => assertSupportedCagnotteCurrency(bad, {}),
      (e) => e.code === "CURRENCY_NOT_SUPPORTED",
      `« ${bad} » ne doit pas devenir une devise valide`
    );
  }
  assert.equal(assertSupportedCagnotteCurrency(" xaf ", {}), "XAF");
});

/* ────────────────────────────────────────────────────────────────────────── */
/* R-16 — la forme des écritures, corridor par corridor                       */
/* ────────────────────────────────────────────────────────────────────────── */

for (const origin of [
  { kind: "USER_WALLET", userId: PAYER },
  { kind: "PROVIDER_INBOUND", rail: "mobilemoney" },
]) {
  for (const { from, to, fxRequired } of MATRIX) {
    test(`écritures ${origin.kind} ${from} → ${to} : équilibrées, coffre UNIQUEMENT en ${to}`, () => {
      const a = amountsFor(from, to);

      const lots = buildCagnotteCreditLots({
        origin,
        sourceCurrency: from,
        targetCurrency: to,
        ...a,
        feesTreasury: FEES,
        fxMarginTreasury: FX_MARGIN,
      });

      for (const lot of lots) {
        const v = checkBalanced(lot.legs);
        assert.equal(v.ok, true, `${lot.scope} : ${v.detail}`);
      }

      const legs = lots.flatMap((l) => l.legs);
      const vaultLegs = legs.filter((l) => l.accountId.startsWith("system_clearing:CAGNOTTE_VAULT:"));

      assert.ok(vaultLegs.length > 0, "le coffre doit être crédité");
      assert.ok(
        vaultLegs.every((l) => l.currency === to && l.accountId.endsWith(`:${to}`)),
        "le compte de coffre ne porte que la devise de la cagnotte (R-16)"
      );

      const vaultCredit = vaultLegs.filter((l) => l.direction === "CREDIT").reduce((s, l) => s + l.amount, 0);
      assert.equal(roundMoney(vaultCredit, to), a.netTarget, "le coffre reçoit exactement le net cible");

      const originDebit = legs
        .filter((l) => l.direction === "DEBIT" && l.currency === from && !l.accountId.startsWith("system_clearing:FX_CONVERSION:"))
        .reduce((s, l) => s + l.amount, 0);
      assert.equal(roundMoney(originDebit, from), a.gross, "l'origine est débitée du montant payé, frais inclus");

      const fxLegs = legs.filter((l) => l.accountId.startsWith("system_clearing:FX_CONVERSION:"));
      assert.equal(fxLegs.length > 0, fxRequired, fxRequired ? "conversion ⇒ position de change" : "même devise ⇒ AUCUNE conversion");
    });
  }
}

test("R-16 : même devise avec un net cible différent — REFUS, pas un frais caché", () => {
  assert.throws(
    () =>
      buildCagnotteCreditLots({
        origin: { kind: "USER_WALLET", userId: PAYER },
        sourceCurrency: "XOF",
        targetCurrency: "XOF",
        gross: 10000,
        fee: 25,
        netSource: 9975,
        netTarget: 9900,
        feesTreasury: FEES,
      }),
    (e) => e.code === "CAGNOTTE_LEGS_INCONSISTENT"
  );
});

test("R-16 : brut − frais ≠ net — REFUS (argent créé ou perdu à l'arrondi)", () => {
  assert.throws(
    () =>
      buildCagnotteCreditLots({
        origin: { kind: "USER_WALLET", userId: PAYER },
        sourceCurrency: "CAD",
        targetCurrency: "XOF",
        gross: 100,
        fee: 0.25,
        netSource: 100,
        netTarget: 43000,
        feesTreasury: FEES,
      }),
    (e) => e.code === "CAGNOTTE_LEGS_INCONSISTENT"
  );
});

test("des frais sans trésorerie configurée LÈVENT", () => {
  assert.throws(
    () =>
      buildCagnotteCreditLots({
        origin: { kind: "USER_WALLET", userId: PAYER },
        sourceCurrency: "XOF",
        targetCurrency: "XOF",
        gross: 10000,
        fee: 25,
        netSource: 9975,
        netTarget: 9975,
        feesTreasury: null,
      }),
    (e) => e.code === "TREASURY_UNCONFIGURED"
  );
});

/* ────────────────────────────────────────────────────────────────────────── */
/* ENUM — tout type d'écriture produit existe dans le modèle                  */
/* ────────────────────────────────────────────────────────────────────────── */

test("chaque type d'écriture produit pour une cagnotte est déclaré dans LedgerEntry", () => {
  const src = fs.readFileSync(path.join(SRC, "models", "LedgerEntry.js"), "utf8");
  const bloc = src.slice(src.indexOf("const ENTRY_TYPES = ["), src.indexOf("];", src.indexOf("const ENTRY_TYPES = [")));
  const declares = new Set([...sansCommentaires(bloc).matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]));

  const produits = new Set();
  for (const origin of [
    { kind: "USER_WALLET", userId: PAYER },
    { kind: "PROVIDER_INBOUND", rail: "card" },
  ]) {
    for (const lot of buildCagnotteCreditLots({
      origin,
      sourceCurrency: "CAD",
      targetCurrency: "XOF",
      gross: 100,
      fee: 0.25,
      netSource: 99.75,
      netTarget: 43000,
      fxRevenue: 200,
      feesTreasury: FEES,
      fxMarginTreasury: FX_MARGIN,
    })) {
      produits.add(lot.entryType);
      lot.legs.forEach((l) => l.entryType && produits.add(l.entryType));
    }
  }
  for (const lot of buildCagnotteRefundLots({
    payerUserId: PAYER,
    sourceCurrency: "CAD",
    targetCurrency: "XOF",
    refundSource: 10,
    refundTarget: 4300,
  })) {
    produits.add(lot.entryType);
  }

  for (const t of produits) {
    assert.ok(
      declares.has(t),
      `« ${t} » est écrit mais absent de ENTRY_TYPES : l'insertion serait refusée à chaque règlement`
    );
  }
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Remboursement — au taux d'origine, sans dérive d'arrondi                   */
/* ────────────────────────────────────────────────────────────────────────── */

test("remboursements partiels successifs : la somme source vaut EXACTEMENT le net source", () => {
  const base = { sourceCurrency: "CAD", targetCurrency: "XOF", netSource: 99.75, netTarget: 43703 };
  let refundedSource = 0;
  let refundedTarget = 0;

  for (const part of [10001, 10001, 10001, null]) {
    const r = computeRefundAmounts({ ...base, refundedSource, refundedTarget, requestedTarget: part });
    refundedSource = roundMoney(refundedSource + r.refundSource, "CAD");
    refundedTarget = roundMoney(refundedTarget + r.refundTarget, "XOF");
  }

  assert.equal(refundedTarget, 43703);
  assert.equal(refundedSource, 99.75, "aucun centime bloqué ni versé deux fois");

  assert.throws(
    () => computeRefundAmounts({ ...base, refundedSource, refundedTarget }),
    (e) => e.code === "NOTHING_TO_REFUND"
  );
});

test("un remboursement au-delà du restant est REFUSÉ", () => {
  assert.throws(
    () =>
      computeRefundAmounts({
        sourceCurrency: "XOF",
        targetCurrency: "XOF",
        netSource: 5000,
        netTarget: 5000,
        refundedTarget: 4000,
        refundedSource: 4000,
        requestedTarget: 1001,
      }),
    (e) => e.code === "REFUND_EXCEEDS_REMAINING"
  );
});

test("les lots de remboursement sont équilibrés et reviennent par la position de change", () => {
  const lots = buildCagnotteRefundLots({
    payerUserId: PAYER,
    sourceCurrency: "EUR",
    targetCurrency: "XOF",
    refundSource: 15.2,
    refundTarget: 9970,
  });

  for (const lot of lots) assert.equal(checkBalanced(lot.legs).ok, true, lot.scope);

  const legs = lots.flatMap((l) => l.legs);
  assert.ok(legs.some((l) => l.accountId === "system_clearing:CAGNOTTE_VAULT:XOF" && l.direction === "DEBIT"));
  assert.ok(legs.some((l) => l.accountType === "USER_WALLET" && l.currency === "EUR" && l.direction === "CREDIT"));
});

/* ────────────────────────────────────────────────────────────────────────── */
/* R-14 — le prix vient du moteur, pour tous les corridors                    */
/* ────────────────────────────────────────────────────────────────────────── */

const RULE = {
  _id: "rule-cagnotte",
  active: true,
  version: 1,
  priority: 0,
  scope: { txType: TX_TYPES.PARTICIPATION, method: "ALL", provider: "all", fromCurrency: "ALL", toCurrency: "ALL" },
  fee: { mode: "PERCENT", percent: 0.25 },
  fx: { mode: "MARKUP_PERCENT", markupPercent: 1 },
  amountRange: { min: 0, max: null },
};

/** Taux déterministes via un pivot USD : r(A→B) = usd[B] / usd[A]. */
const USD_PER = { USD: 1, EUR: 0.92, CAD: 1.36, GBP: 0.79, XOF: 603.5, XAF: 603.5 };

function fakeDeps() {
  return {
    getActiveRules: async () => [RULE],
    computeQuote,
    getExchangeRate: async (from, to) => ({
      rate: USD_PER[to] / USD_PER[from],
      provider: "test-market",
      source: "test",
      asOfDate: "2026-09-10T00:00:00.000Z",
    }),
  };
}

for (const { from, to, fxRequired } of MATRIX) {
  test(`prix ${from} → ${to} : calculé par le moteur, ${fxRequired ? "conversion appliquée" : "aucune conversion"}`, async () => {
    const amount = decimalsForCurrency(from) === 0 ? 50000 : 100;

    const q = await computeCagnottePricing({
      txType: TX_TYPES.PARTICIPATION,
      method: "INTERNAL",
      provider: "paynoval",
      amount,
      sourceCurrency: from,
      targetCurrency: to,
      deps: fakeDeps(),
    });

    assert.equal(q.source.amount, amount);
    assert.equal(q.source.currency, from);
    assert.equal(q.fee.currency, from, "les frais sont dans la devise payée");
    assert.equal(q.fee.amount, roundMoney(amount * 0.0025, from), "frais appliqués avec ou sans conversion (D3)");
    assert.equal(q.destination.currency, to);
    assert.equal(q.fx.required, fxRequired);

    if (!fxRequired) {
      assert.equal(q.destination.amount, q.netSource, "même devise ⇒ la cagnotte reçoit le net, sans taux");
      assert.equal(q.fx.revenue.amount, 0);
    } else {
      const market = USD_PER[to] / USD_PER[from];
      assert.ok(Math.abs(q.fx.marketRate - market) < 1e-12);
      assert.ok(q.fx.appliedRate < market, "la marge est prise sur le taux, jamais au-dessus du marché");
      assert.equal(q.fx.provider, "test-market", "le fournisseur du taux est historisé");
    }

    // Le devis nourrit les écritures SANS aucune retouche.
    const lots = buildCagnotteCreditLots({
      origin: { kind: "USER_WALLET", userId: PAYER },
      sourceCurrency: from,
      targetCurrency: to,
      gross: q.source.amount,
      fee: q.fee.amount,
      netSource: q.netSource,
      netTarget: q.destination.amount,
      fxRevenue: q.fx.revenue.amount,
      feesTreasury: FEES,
      fxMarginTreasury: FX_MARGIN,
    });
    for (const lot of lots) assert.equal(checkBalanced(lot.legs).ok, true, lot.scope);
  });
}

test("même devise : une règle qui déclare un taux ≠ 1 ne peut PAS produire de frais caché", () => {
  const q = normalizeParticipationQuote({
    engineQuote: {
      result: { grossFrom: 10000, fee: 25, netFrom: 9975, appliedRate: 0.97, netTo: 9676, fxRevenue: { amount: 299 } },
      ruleApplied: { ruleId: "r", version: 1 },
    },
    sourceCurrency: "XOF",
    targetCurrency: "XOF",
    requestedAmount: 10000,
  });

  assert.equal(q.destination.amount, 9975);
  assert.equal(q.fx.required, false);
  assert.equal(q.fx.revenue.amount, 0);
});

test("un devis qui ne porte pas le montant demandé est REFUSÉ", () => {
  assert.throws(
    () =>
      normalizeParticipationQuote({
        engineQuote: { result: { grossFrom: 1, fee: 0, netFrom: 1, appliedRate: 1, netTo: 1 } },
        sourceCurrency: "CAD",
        targetCurrency: "CAD",
        requestedAmount: 100,
      }),
    (e) => e.code === "PRICING_INCONSISTENT"
  );
});

test("aucune règle applicable ⇒ PRICING_UNAVAILABLE, jamais une participation gratuite", async () => {
  await assert.rejects(
    () =>
      computeCagnottePricing({
        txType: TX_TYPES.PARTICIPATION,
        method: "INTERNAL",
        amount: 100,
        sourceCurrency: "CAD",
        targetCurrency: "XOF",
        deps: { ...fakeDeps(), getActiveRules: async () => [] },
      }),
    (e) => e.code === "PRICING_UNAVAILABLE" && e.status === 503
  );
});

test("taux indisponible ⇒ FX_UNAVAILABLE, jamais un taux deviné", async () => {
  await assert.rejects(
    () =>
      computeCagnottePricing({
        txType: TX_TYPES.PARTICIPATION,
        method: "INTERNAL",
        amount: 100,
        sourceCurrency: "CAD",
        targetCurrency: "USD",
        deps: {
          ...fakeDeps(),
          getExchangeRate: async () => {
            throw new Error("fournisseur hors ligne");
          },
        },
      }),
    (e) => e.code === "FX_UNAVAILABLE"
  );

  assert.equal(mapPricingError({ status: 404, message: "No pricing rule matched" }).code, "PRICING_UNAVAILABLE");
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Position du coffre — les refus sont NOMMÉS                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const dec = (n) => ({ toString: () => String(n) });

test("position absente ⇒ VAULT_POSITION_MISSING ; devise divergente ⇒ VAULT_CURRENCY_MISMATCH (R-15)", () => {
  assert.throws(() => assertPositionIdentity(null), (e) => e.code === "VAULT_POSITION_MISSING");
  assert.throws(
    () => assertPositionIdentity({ currency: "XOF", cagnotteId: "c1" }, { currency: "EUR" }),
    (e) => e.code === "VAULT_CURRENCY_MISMATCH" && e.status === 409
  );
});

test("crédit refusé : objectif dépassé rend le restant ; coffre clos rend VAULT_CLOSED", () => {
  const doc = { currency: "XOF", collected: dec(95000), balance: dec(95000), closedAt: null };
  const e = diagnoseCreditRefusal(doc, { currency: "XOF", amount: 10000, goalCap: 100000 });
  assert.equal(e.code, "GOAL_EXCEEDED");
  assert.equal(e.details.remaining, 5000);

  const closed = diagnoseCreditRefusal({ ...doc, closedAt: new Date() }, { currency: "XOF", amount: 1 });
  assert.equal(closed.code, "VAULT_CLOSED");
});

test("débit refusé : avant clôture ⇒ VAULT_NOT_CLOSED ; au-delà du solde ⇒ VAULT_INSUFFICIENT_BALANCE", () => {
  const open = { currency: "XOF", balance: dec(1000), collected: dec(1000), closedAt: null };
  assert.equal(
    diagnoseDebitRefusal(open, { currency: "XOF", amount: 500, requireClosed: true }).code,
    "VAULT_NOT_CLOSED"
  );

  const closed = { ...open, closedAt: new Date() };
  const e = diagnoseDebitRefusal(closed, { currency: "XOF", amount: 999999, requireClosed: true });
  assert.equal(e.code, "VAULT_INSUFFICIENT_BALANCE");
  assert.equal(e.details.available, 1000);
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Gardes de source — l'appelant ne fournit plus AUCUN montant                */
/* ────────────────────────────────────────────────────────────────────────── */

test("R-14 : le règlement de participation ne lit aucun montant, taux ni devise de paiement dans le corps", () => {
  const s = code("controllers/cagnotteSettlementController.js");

  for (const interdit of [/req\.body\??\.payer/, /req\.body\??\.feeCredit/, /amountViewer/, /viewerCurrencyCode/]) {
    assert.doesNotMatch(s, interdit, `le contrôleur de participation lit encore ${interdit}`);
  }

  assert.match(s, /status:\s*"ACTIVE",\s*expiresAt:\s*\{\s*\$gt/, "le devis est consommé conditionnellement (ACTIVE, non expiré)");
  assert.match(s, /LEGACY_PARTICIPATION_SETTLE_REMOVED/, "l'ancien contrat sans devis est refusé explicitement");
});

test("R-14 : frais de clôture et participation invité ne lisent aucun montant de frais dans le corps", () => {
  const cloture = code("controllers/cagnotteClosureFeesSettlementController.js");
  assert.doesNotMatch(cloture, /req\.body\??\.feeCredit\??\.amount/);
  assert.match(cloture, /CLOSURE_FEE_AMOUNT_NOT_ACCEPTED/);

  const externe = code("controllers/cagnotteExternalSettlementController.js");
  assert.doesNotMatch(externe, /req\.body\??\.feeCredit/);
  assert.match(externe, /computeCagnottePricing\(/);
});

test("R-14/R-15 : le retrait débite la position AVANT de créditer le bénéficiaire, dans la transaction", () => {
  const s = code("controllers/cagnotteVaultWithdrawalSettlementController.js");
  const tx = s.indexOf("runWithTransaction(session");
  const debit = s.indexOf("debitPosition(", tx);
  const credit = s.indexOf("ensureWalletForUser({", tx);

  assert.notEqual(tx, -1);
  assert.ok(debit > tx, "le débit de position doit être DANS la transaction");
  assert.ok(debit < credit, "le plafond doit être posé avant le crédit du portefeuille");
  assert.match(s.slice(debit, credit), /requireClosed:\s*true/, "aucun retrait avant la clôture");
});

test("les deux types tarifaires de cagnotte sont déclarés dans PricingRule", () => {
  const s = fs.readFileSync(path.join(SRC, "models", "pricing", "PricingRule.js"), "utf8");
  assert.match(s, /"CAGNOTTE_PARTICIPATION"/);
  assert.match(s, /"CAGNOTTE_CLOSURE"/);
});
