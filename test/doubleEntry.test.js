"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LEDGER_VERSION,
  BALANCE_EPSILON,
  checkBalanced,
  assertBalanced,
  summarizeLegs,
  transferLegs,
  computeTrialBalance,
  userWalletAccountId,
  systemReserveAccountId,
  systemClearingAccountId,
  treasuryAccountId,
} = require("../src/services/ledger/doubleEntry");

/**
 * Le sujet de ce fichier est l'INVARIANT COMPTABLE : Σ débits = Σ crédits, par
 * devise. C'est le seul contrôle du grand livre qui n'a pas besoin de connaître
 * un défaut à l'avance pour l'attraper — il mérite donc d'être verrouillé plus
 * soigneusement que le reste.
 */

const USER_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

function leg(accountId, direction, amount, currency = "XOF", accountType = "USER_WALLET") {
  return { accountType, accountId, direction, amount, currency };
}

/* -------------------------------------------------------------------------- */
/* Identifiants de comptes                                                    */
/* -------------------------------------------------------------------------- */

test("les identifiants de comptes suivent une convention lisible", () => {
  assert.equal(userWalletAccountId(USER_A, "xof"), `user_wallet:${USER_A}:XOF`);
  assert.equal(systemReserveAccountId(USER_A, "xof"), `system_reserve:${USER_A}:XOF`);
  assert.equal(systemClearingAccountId("xof"), "system_clearing:XOF");
  assert.equal(
    treasuryAccountId({ treasuryUserId: USER_B, treasurySystemType: "fees_treasury", currency: "cad" }),
    `treasury:FEES_TREASURY:${USER_B}:CAD`
  );
});

test("le compte de réserve porte l'utilisateur, la compensation non", () => {
  /**
   * Une réserve globale empêcherait de répondre à « de qui sont ces fonds
   * gelés ? » — la question exacte qu'on pose quand une réserve reste bloquée.
   * La compensation, elle, est délibérément collective : son solde par devise
   * est la mesure des fonds en transit.
   */
  assert.ok(systemReserveAccountId(USER_A, "XOF").includes(USER_A));
  assert.ok(!systemClearingAccountId("XOF").includes(USER_A));
});

/* -------------------------------------------------------------------------- */
/* L'invariant                                                                */
/* -------------------------------------------------------------------------- */

test("une paire équilibrée est acceptée", () => {
  const v = checkBalanced([
    leg("user_wallet:A:XOF", "DEBIT", 10000),
    leg("system_reserve:A:XOF", "CREDIT", 10000, "XOF", "SYSTEM_RESERVE"),
  ]);

  assert.equal(v.ok, true);
  assert.deepEqual(v.byCurrency.XOF, { debit: 10000, credit: 10000, delta: 0 });
});

test("UNE SEULE JAMBE est refusée — c'est la partie simple qu'on remplace", () => {
  const v = checkBalanced([leg("user_wallet:A:XOF", "DEBIT", 10000)]);

  assert.equal(v.ok, false);
  assert.equal(v.reason, "single-leg");
});

test("un déséquilibre est refusé, même d'une unité", () => {
  const v = checkBalanced([
    leg("user_wallet:A:XOF", "DEBIT", 10000),
    leg("system_reserve:A:XOF", "CREDIT", 9999, "XOF", "SYSTEM_RESERVE"),
  ]);

  assert.equal(v.ok, false);
  assert.equal(v.reason, "unbalanced");
  assert.match(v.detail, /XOF/);
});

test("l'équilibre est vérifié PAR DEVISE, pas globalement", () => {
  /**
   * Le cas qui compte. Additionner 200 XOF de débit et 200 CAD de crédit
   * donnerait un delta nul et laisserait passer une écriture absurde.
   */
  const v = checkBalanced([
    leg("user_wallet:A:XOF", "DEBIT", 200, "XOF"),
    leg("treasury:FEES:T:CAD", "CREDIT", 200, "CAD", "TREASURY"),
  ]);

  assert.equal(v.ok, false, "deux devises ne s'équilibrent jamais entre elles");
  assert.equal(v.reason, "unbalanced");
});

test("deux devises, chacune équilibrée séparément, sont acceptées", () => {
  const v = checkBalanced([
    leg("user_wallet:A:XOF", "DEBIT", 200, "XOF"),
    leg("system_clearing:XOF", "CREDIT", 200, "XOF", "SYSTEM_CLEARING"),
    leg("system_clearing:CAD", "DEBIT", 1, "CAD", "SYSTEM_CLEARING"),
    leg("treasury:FEES:T:CAD", "CREDIT", 1, "CAD", "TREASURY"),
  ]);

  assert.equal(v.ok, true);
  assert.equal(v.byCurrency.XOF.delta, 0);
  assert.equal(v.byCurrency.CAD.delta, 0);
});

test("un montant négatif est refusé — le SENS porte déjà le signe", () => {
  /**
   * Autoriser les montants négatifs permettrait d'écrire un débit de −100,
   * c'est-à-dire un crédit déguisé. La balance ne verrait rien.
   */
  const v = checkBalanced([
    leg("user_wallet:A:XOF", "DEBIT", -100),
    leg("system_reserve:A:XOF", "DEBIT", 100, "XOF", "SYSTEM_RESERVE"),
  ]);

  assert.equal(v.ok, false);
  assert.equal(v.reason, "bad-amount");
});

test("un montant nul est refusé", () => {
  const v = checkBalanced([
    leg("user_wallet:A:XOF", "DEBIT", 0),
    leg("system_reserve:A:XOF", "CREDIT", 0, "XOF", "SYSTEM_RESERVE"),
  ]);

  assert.equal(v.ok, false);
  assert.equal(v.reason, "bad-amount");
});

test("un sens, un type de compte ou une devise invalides sont refusés", () => {
  const base = leg("system_reserve:A:XOF", "CREDIT", 100, "XOF", "SYSTEM_RESERVE");

  assert.equal(
    checkBalanced([{ ...leg("a", "SIDEWAYS", 100) }, base]).reason,
    "bad-direction"
  );
  assert.equal(
    checkBalanced([{ ...leg("a", "DEBIT", 100), accountType: "MAGIC" }, base]).reason,
    "bad-account-type"
  );
  assert.equal(
    checkBalanced([{ ...leg("a", "DEBIT", 100), currency: "" }, base]).reason,
    "missing-currency"
  );
  assert.equal(
    checkBalanced([{ ...leg("", "DEBIT", 100) }, base]).reason,
    "missing-account-id"
  );
});

test("la tolérance absorbe l'imprécision des flottants, pas une vraie erreur", () => {
  /**
   * `0.1 + 0.2 !== 0.3` : comparer des flottants avec `===` est une faute
   * connue. Un demi-centime est très en dessous de toute erreur réelle.
   */
  const tiny = checkBalanced([
    leg("a", "DEBIT", 0.1 + 0.2, "CAD"),
    leg("b", "CREDIT", 0.3, "CAD", "SYSTEM_CLEARING"),
  ]);
  assert.equal(tiny.ok, true, "l'imprécision binaire doit passer");

  const real = checkBalanced([
    leg("a", "DEBIT", 100, "CAD"),
    leg("b", "CREDIT", 100 - BALANCE_EPSILON * 3, "CAD", "SYSTEM_CLEARING"),
  ]);
  assert.equal(real.ok, false, "un écart réel doit être refusé");
});

test("assertBalanced lève avec un code exploitable", () => {
  assert.throws(
    () => assertBalanced([leg("a", "DEBIT", 100)], "reserveSenderFunds"),
    (err) => {
      assert.equal(err.code, "LEDGER_UNBALANCED");
      assert.equal(err.reason, "single-leg");
      assert.match(err.message, /reserveSenderFunds/, "le contexte doit apparaître");
      return true;
    }
  );
});

/* -------------------------------------------------------------------------- */
/* transferLegs                                                               */
/* -------------------------------------------------------------------------- */

test("transferLegs produit une paire équilibrée par construction", () => {
  const legs = transferLegs({
    from: { accountType: "USER_WALLET", accountId: "user_wallet:A:XOF", userId: USER_A },
    to: { accountType: "SYSTEM_RESERVE", accountId: "system_reserve:A:XOF", userId: USER_A },
    amount: 10000,
    currency: "XOF",
  });

  assert.equal(legs.length, 2);
  assert.equal(legs[0].direction, "DEBIT");
  assert.equal(legs[1].direction, "CREDIT");
  assert.equal(checkBalanced(legs).ok, true);
});

/* -------------------------------------------------------------------------- */
/* Le cycle complet d'un virement                                             */
/* -------------------------------------------------------------------------- */

test("un virement interne complet boucle exactement", () => {
  /**
   * 10 000 XOF envoyés, 200 de frais. Le scénario de l'en-tête du module,
   * vérifié bout en bout : chaque étape équilibrée SEULE, et le total aussi.
   */
  const steps = [
    // 1. réservation
    transferLegs({
      from: { accountType: "USER_WALLET", accountId: userWalletAccountId(USER_A, "XOF") },
      to: { accountType: "SYSTEM_RESERVE", accountId: systemReserveAccountId(USER_A, "XOF") },
      amount: 10000,
      currency: "XOF",
    }),
    // 2. capture
    transferLegs({
      from: { accountType: "SYSTEM_RESERVE", accountId: systemReserveAccountId(USER_A, "XOF") },
      to: { accountType: "SYSTEM_CLEARING", accountId: systemClearingAccountId("XOF") },
      amount: 10000,
      currency: "XOF",
    }),
    // 3. crédit du bénéficiaire
    transferLegs({
      from: { accountType: "SYSTEM_CLEARING", accountId: systemClearingAccountId("XOF") },
      to: { accountType: "USER_WALLET", accountId: userWalletAccountId(USER_B, "XOF") },
      amount: 9800,
      currency: "XOF",
    }),
    // 4. frais
    transferLegs({
      from: { accountType: "SYSTEM_CLEARING", accountId: systemClearingAccountId("XOF") },
      to: { accountType: "TREASURY", accountId: "treasury:FEES_TREASURY:T:XOF" },
      amount: 200,
      currency: "XOF",
    }),
  ];

  // Chaque étape équilibrée seule : une transaction interrompue au milieu reste
  // vérifiable.
  for (const [i, legs] of steps.entries()) {
    assert.equal(checkBalanced(legs).ok, true, `étape ${i + 1}`);
  }

  const all = steps.flat();
  const total = summarizeLegs(all).get("XOF");

  assert.equal(total.debit, 30000);
  assert.equal(total.credit, 30000);
  assert.equal(total.delta, 0);
});

test("la compensation revient à zéro quand tout est distribué", () => {
  /**
   * Un solde de compensation durablement non nul signifie que des fonds sont
   * restés en transit. C'est la mesure qui rend ce compte utile.
   */
  const entries = [
    { currency: "XOF", direction: "CREDIT", amount: 10000, accountId: systemClearingAccountId("XOF"), metadata: { ledgerVersion: 2 } },
    { currency: "XOF", direction: "DEBIT", amount: 9800, accountId: systemClearingAccountId("XOF"), metadata: { ledgerVersion: 2 } },
    { currency: "XOF", direction: "DEBIT", amount: 200, accountId: systemClearingAccountId("XOF"), metadata: { ledgerVersion: 2 } },
  ];

  const clearing = summarizeLegs(entries).get("XOF");
  assert.equal(clearing.credit - clearing.debit, 0);
});

/* -------------------------------------------------------------------------- */
/* Balance de vérification                                                    */
/* -------------------------------------------------------------------------- */

function entry(direction, amount, currency = "XOF", version = LEDGER_VERSION) {
  return { direction, amount, currency, metadata: { ledgerVersion: version } };
}

test("la balance de vérification confirme un ensemble équilibré", () => {
  const t = computeTrialBalance([entry("DEBIT", 500), entry("CREDIT", 500)]);

  assert.equal(t.balanced, true);
  assert.equal(t.consideredEntries, 2);
  assert.equal(t.skippedLegacyEntries, 0);
});

test("la balance détecte une écriture PERDUE", () => {
  /**
   * C'est le défaut que les six invariants énumérés à la main ne trouvaient
   * pas : rien ne manque « visiblement », c'est le total qui ne tombe plus.
   */
  const t = computeTrialBalance([entry("DEBIT", 500), entry("CREDIT", 300)]);

  assert.equal(t.balanced, false);
  assert.equal(t.byCurrency.XOF.delta, 200);
});

test("la balance détecte une écriture EN DOUBLE", () => {
  const t = computeTrialBalance([
    entry("DEBIT", 500),
    entry("CREDIT", 500),
    entry("CREDIT", 500),
  ]);

  assert.equal(t.balanced, false);
  assert.equal(t.byCurrency.XOF.delta, -500);
});

test("l'historique en partie simple est IGNORÉ, pas compté comme faux", () => {
  /**
   * Sans cette exclusion, le contrôle serait rouge sur tout le passé et
   * quelqu'un le désactiverait dans la semaine. `ledgerVersion` absent = v1.
   */
  const t = computeTrialBalance([
    { direction: "DEBIT", amount: 999, currency: "XOF" }, // héritée, sans version
    entry("DEBIT", 500),
    entry("CREDIT", 500),
  ]);

  assert.equal(t.balanced, true);
  assert.equal(t.consideredEntries, 2);
  assert.equal(t.skippedLegacyEntries, 1);
});

test("la balance lit les montants Decimal128 comme les nombres", () => {
  // Selon la voie de lecture (`.lean()` ou hydratation), le montant arrive en
  // `Decimal128` ou en nombre. Les deux doivent donner le même verdict.
  const asDecimal = { toString: () => "500.00" };

  const t = computeTrialBalance([
    { direction: "DEBIT", amount: asDecimal, currency: "XOF", metadata: { ledgerVersion: 2 } },
    entry("CREDIT", 500),
  ]);

  assert.equal(t.balanced, true);
});

test("un ensemble vide est équilibré — l'absence n'est pas une anomalie", () => {
  const t = computeTrialBalance([]);
  assert.equal(t.balanced, true);
  assert.equal(t.consideredEntries, 0);
});
