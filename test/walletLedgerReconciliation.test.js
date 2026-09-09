"use strict";

/**
 * ============================================================================
 * LE SOLDE CONFRONTÉ AU GRAND LIVRE — LE CŒUR, SANS BASE
 * ============================================================================
 *
 * Ce que ces tests doivent prouver, et qui n'est PAS « le contrôle s'exécute » :
 *
 *   1. Une divergence RÉELLE est détectée, **avec les bons chiffres**. Un
 *      rapport qui dit « incohérence » sans les montants oblige à tout refaire
 *      à la main.
 *   2. Le cumul reproduit `availableAmount`, et **pas** `amount`. C'est le
 *      choix de conception qui décide de tout : le test le met en défaut en
 *      construisant un portefeuille où les deux diffèrent.
 *   3. Le cumul est EXACT. Les trois mesures citées en tête de
 *      `decimalMoney.js` sont rejouées ici : là où le flottant dérive de
 *      presque une unité, le cumul exact tombe juste.
 *   4. Le contrôle ne prétend jamais « OK » quand il ne sait pas.
 *   5. Il ne modifie rien — les documents lui arrivent GELÉS.
 *
 * Aucune base, aucune connexion, aucun serveur : ce fichier appartient à
 * `npm test`, qui doit le rester. Le bout-en-bout avec base vit dans
 * `test-concurrency/walletLedgerReconciliation.concurrency.test.js`.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const D = require("../src/services/ledger/decimalMoney");

const {
  ANOMALIES,
  VERDICTS,
  DEFAULT_TOLERANCE,
  reconcileWallet,
  summarize,
} = require("../src/services/ledger/walletLedgerReconciliation");

const USER = "64b7f9c2e1a4d5b6c7d8e9f0";
const WALLET_ACCOUNT = `user_wallet:${USER}:XOF`;
const RESERVE_ACCOUNT = `system_reserve:${USER}:XOF`;

let seq = 0;

/** Gelé : si le contrôle tentait d'écrire quoi que ce soit, il lèverait. */
function entry({
  account = WALLET_ACCOUNT,
  direction,
  amount,
  status = "POSTED",
  version = 2,
  currency = "XOF",
}) {
  const e = {
    _id: `entry-${++seq}`,
    accountId: account,
    direction,
    amount,
    currency,
    status,
    metadata: version === null ? null : { ledgerVersion: version },
  };

  if (e.metadata) Object.freeze(e.metadata);
  return Object.freeze(e);
}

function wallet({ amount, available, reserved, currency = "XOF" }) {
  return Object.freeze({
    _id: "wallet-1",
    user: USER,
    currency,
    amount,
    availableAmount: available,
    reservedAmount: reserved,
  });
}

function typesOf(result) {
  return result.anomalies.map((a) => a.type);
}

function anomalyOf(result, type) {
  return result.anomalies.find((a) => a.type === type);
}

/* ========================================================================== */
/* 1. Arithmétique exacte — la raison d'être de `decimalMoney`               */
/* ========================================================================== */

test("parseDecimal rend null — jamais 0 — sur une valeur illisible", () => {
  for (const illisible of [
    null,
    undefined,
    "",
    "  ",
    "abc",
    "1,50",
    NaN,
    Infinity,
    -Infinity,
    {},
    [],
  ]) {
    assert.equal(
      D.parseDecimal(illisible),
      null,
      `${JSON.stringify(illisible)} devrait être illisible, pas nul — ` +
        "substituer 0 transformerait une donnée corrompue en « rien ne bouge »"
    );
  }
});

test("parseDecimal lit les quatre formes réellement rencontrées en base", () => {
  const attendu = "1234.56";

  assert.equal(D.format(D.parseDecimal("1234.56")), attendu);
  assert.equal(D.format(D.parseDecimal(1234.56)), attendu);
  assert.equal(D.format(D.parseDecimal({ $numberDecimal: "1234.56" })), attendu);
  assert.equal(
    D.format(D.parseDecimal(mongoose.Types.Decimal128.fromString("1234.56"))),
    attendu
  );
});

test("parseDecimal absorbe la notation exponentielle sans perdre un chiffre", () => {
  assert.equal(D.format(D.parseDecimal("1E+3")), "1000");
  assert.equal(D.format(D.parseDecimal("1.5e2")), "150");
  assert.equal(D.format(D.parseDecimal("125E-2")), "1.25");
  assert.equal(D.format(D.parseDecimal("-0.750")), "-0.750");
});

test("le cumul exact tombe juste là où le flottant dérive (3 × 0.1)", () => {
  let naif = 0;
  for (const v of [0.1, 0.1, 0.1]) naif += v;

  assert.notEqual(naif, 0.3, "le témoin ne dérive pas : le test ne prouve rien");

  const exact = D.sum([0.1, 0.1, 0.1].map((v) => D.parseDecimal(String(v))));
  assert.equal(D.format(exact), "0.3");
});

/**
 * ── LES TROIS MESURES CITÉES EN TÊTE DE `decimalMoney.js`
 *
 * Ce n'est pas le NOMBRE d'écritures qui fait franchir la tolérance, c'est la
 * MAGNITUDE du cumul. Un solde en XOF atteint vite 10⁹ ; un compte de
 * compensation, davantage. À 10¹², le flottant se trompe de presque une unité
 * entière — 195 fois la tolérance — sur un portefeuille parfaitement sain.
 *
 * Le test rejoue les trois cas et vérifie DEUX choses : que le témoin flottant
 * dérive bien (sinon le test ne démontre rien) et que le cumul exact, lui,
 * tombe juste.
 */
for (const { depart, libelle } of [
  { depart: "10000000", libelle: "10⁷" },
  { depart: "1000000000", libelle: "10⁹" },
  { depart: "1000000000000", libelle: "10¹²" },
]) {
  test(`cumul exact sur ${libelle} + 100 000 × 0.01 — là où le flottant se perd`, () => {
    const N = 100000;

    let naif = Number(depart);
    for (let i = 0; i < N; i++) naif += 0.01;
    const derive = Math.abs(naif - (Number(depart) + 1000));

    let exact = D.parseDecimal(depart);
    const centime = D.parseDecimal("0.01");
    for (let i = 0; i < N; i++) exact = D.add(exact, centime);

    const attendu = D.add(D.parseDecimal(depart), D.parseDecimal("1000"));

    assert.equal(
      D.compare(exact, attendu),
      0,
      `le cumul exact devrait valoir ${D.format(attendu)}, il vaut ${D.format(exact)}`
    );

    // Le témoin : on documente la dérive mesurée, sans l'affirmer sans mesure.
    console.log(
      `    ${libelle} : dérive du cumul flottant = ${derive} ` +
        `(tolérance ${DEFAULT_TOLERANCE})`
    );
  });
}

test("la tolérance est comparée exactement, pas en flottant", () => {
  const tol = D.parseDecimal(DEFAULT_TOLERANCE);

  assert.equal(D.exceeds(D.parseDecimal("0.004"), tol), false);
  assert.equal(D.exceeds(D.parseDecimal("0.005"), tol), false, "égal n'excède pas");
  assert.equal(D.exceeds(D.parseDecimal("0.006"), tol), true);
  assert.equal(D.exceeds(D.parseDecimal("-0.006"), tol), true, "le signe ne sauve pas");
});

/* ========================================================================== */
/* 2. Le cœur : une divergence réelle, avec les bons chiffres                */
/* ========================================================================== */

test("un portefeuille conforme au cumul de ses écritures est déclaré OK", () => {
  const r = reconcileWallet({
    wallet: wallet({ amount: "1000", available: "600", reserved: "400" }),
    entries: [
      entry({ direction: "CREDIT", amount: "1000" }),
      entry({ direction: "DEBIT", amount: "400" }),
      entry({ account: RESERVE_ACCOUNT, direction: "CREDIT", amount: "400" }),
    ],
  });

  assert.equal(r.verdict, VERDICTS.OK);
  assert.deepEqual(r.anomalies, []);
  assert.equal(r.projected.availableAmount, "600");
  assert.equal(r.projected.reservedAmount, "400");
  assert.equal(r.projected.amount, "1000");
  assert.equal(r.entries.counted, 3);
});

/**
 * ⚠️ LE TEST CENTRAL. Le solde stocké MENT : le grand livre dit 700, le
 * portefeuille affiche 500. Aucun des deux contrôles existants ne le verrait —
 * `amount = available + reserved` tient (500 = 500 + 0) et le grand livre, pris
 * seul, est parfaitement équilibré.
 */
test("une divergence réelle est détectée, avec les chiffres exacts", () => {
  const r = reconcileWallet({
    wallet: wallet({ amount: "500", available: "500", reserved: "0" }),
    entries: [
      entry({ direction: "CREDIT", amount: "1000" }),
      entry({ direction: "DEBIT", amount: "300" }),
    ],
  });

  assert.equal(r.verdict, VERDICTS.DRIFT);

  const dispo = anomalyOf(r, ANOMALIES.AVAILABLE_DRIFT);
  assert.ok(dispo, `écart sur le disponible non signalé (${typesOf(r)})`);

  assert.equal(dispo.userId, USER);
  assert.equal(dispo.currency, "XOF");
  assert.equal(dispo.account, WALLET_ACCOUNT);
  assert.equal(dispo.stored, "500", "le solde stocké doit figurer au rapport");
  assert.equal(dispo.projected, "700", "le solde recalculé doit figurer au rapport");
  assert.equal(dispo.gap, "-200", "l'écart doit être chiffré et signé");
  assert.equal(dispo.ledgerCredit, "1000");
  assert.equal(dispo.ledgerDebit, "300");
  assert.equal(
    dispo.entriesCounted,
    2,
    "le nombre d'écritures prises en compte fait partie du rapport"
  );

  // Le total dérive aussi, et il est rapporté séparément : les deux questions
  // (« le disponible est-il juste ? », « le total l'est-il ? ») n'ont pas la
  // même cause ni le même remède.
  const total = anomalyOf(r, ANOMALIES.TOTAL_DRIFT);
  assert.ok(total, "écart sur le total non signalé");
  assert.equal(total.stored, "500");
  assert.equal(total.projected, "700");
  assert.equal(total.gap, "-200");
});

test("une dérive de la RÉSERVE est détectée séparément du disponible", () => {
  const r = reconcileWallet({
    wallet: wallet({ amount: "1000", available: "600", reserved: "400" }),
    entries: [
      entry({ direction: "CREDIT", amount: "1000" }),
      entry({ direction: "DEBIT", amount: "400" }),
      // La réserve n'a jamais été créditée que de 250 au grand livre.
      entry({ account: RESERVE_ACCOUNT, direction: "CREDIT", amount: "250" }),
    ],
  });

  assert.equal(r.verdict, VERDICTS.DRIFT);

  const reserve = anomalyOf(r, ANOMALIES.RESERVED_DRIFT);
  assert.ok(reserve, `écart de réserve non signalé (${typesOf(r)})`);
  assert.equal(reserve.account, RESERVE_ACCOUNT);
  assert.equal(reserve.stored, "400");
  assert.equal(reserve.projected, "250");
  assert.equal(reserve.gap, "150");
  assert.equal(reserve.entriesCounted, 1);

  assert.equal(
    anomalyOf(r, ANOMALIES.AVAILABLE_DRIFT),
    undefined,
    "le disponible est juste : le signaler serait crier au loup"
  );
});

test("les décimales sont exactes en devise à 2 décimales", () => {
  const r = reconcileWallet({
    wallet: {
      _id: "w",
      user: USER,
      currency: "CAD",
      amount: "10.00",
      availableAmount: "10.00",
      reservedAmount: "0.00",
    },
    entries: [
      { accountId: `user_wallet:${USER}:CAD`, direction: "CREDIT", amount: "0.10", status: "POSTED" },
      { accountId: `user_wallet:${USER}:CAD`, direction: "CREDIT", amount: "0.10", status: "POSTED" },
      { accountId: `user_wallet:${USER}:CAD`, direction: "CREDIT", amount: "0.10", status: "POSTED" },
    ],
  });

  assert.equal(
    r.projected.availableAmount,
    "0.30",
    "0.1 + 0.1 + 0.1 doit valoir 0.30 tout rond, pas 0.30000000000000004"
  );

  const dispo = anomalyOf(r, ANOMALIES.AVAILABLE_DRIFT);
  assert.ok(dispo);
  assert.equal(dispo.gap, "9.70");
});

/* ========================================================================== */
/* 3. Le choix du champ : le cumul reproduit `availableAmount`               */
/* ========================================================================== */

/**
 * ⚠️ LE TEST QUI TRANCHE LA CONCEPTION.
 *
 * Parcours réel : crédit 1000, réservation 400, capture de 250. Après quoi le
 * portefeuille porte trois valeurs DIFFÉRENTES —
 *
 *     amount = 750   ·   availableAmount = 600   ·   reservedAmount = 150
 *
 * — et `captureReserve` n'a posé AUCUNE jambe sur `user_wallet`. Un contrôle
 * qui croirait que le cumul de `user_wallet` reproduit `amount` verrait ici un
 * écart de 150 sur un portefeuille sain.
 */
test("le cumul de user_wallet reproduit availableAmount, pas amount", () => {
  const r = reconcileWallet({
    wallet: wallet({ amount: "750", available: "600", reserved: "150" }),
    entries: [
      entry({ direction: "CREDIT", amount: "1000" }), // credit()
      entry({ direction: "DEBIT", amount: "400" }), // reserve(), jambe portefeuille
      entry({ account: RESERVE_ACCOUNT, direction: "CREDIT", amount: "400" }),
      // captureReserve() : réserve → compensation. Rien sur user_wallet.
      entry({ account: RESERVE_ACCOUNT, direction: "DEBIT", amount: "250" }),
    ],
  });

  assert.equal(
    r.verdict,
    VERDICTS.OK,
    `portefeuille sain déclaré en écart — le champ ciblé est faux (${typesOf(r)})`
  );

  assert.equal(r.projected.availableAmount, "600");
  assert.equal(r.projected.reservedAmount, "150");
  assert.equal(r.projected.amount, "750");

  assert.notEqual(
    r.projected.availableAmount,
    r.stored.amount,
    "le cas de test ne discrimine rien si available et amount coïncident"
  );
});

/**
 * Le miroir du précédent : si quelqu'un avait rangé le TOTAL dans
 * `availableAmount` — la confusion exacte que ce contrôle doit attraper — il
 * est signalé, chiffres à l'appui.
 */
test("un total rangé par erreur dans availableAmount est signalé", () => {
  const r = reconcileWallet({
    wallet: wallet({ amount: "750", available: "750", reserved: "150" }),
    entries: [
      entry({ direction: "CREDIT", amount: "1000" }),
      entry({ direction: "DEBIT", amount: "400" }),
      entry({ account: RESERVE_ACCOUNT, direction: "CREDIT", amount: "400" }),
      entry({ account: RESERVE_ACCOUNT, direction: "DEBIT", amount: "250" }),
    ],
  });

  assert.equal(r.verdict, VERDICTS.DRIFT);

  const dispo = anomalyOf(r, ANOMALIES.AVAILABLE_DRIFT);
  assert.ok(dispo);
  assert.equal(dispo.stored, "750");
  assert.equal(dispo.projected, "600");
  assert.equal(dispo.gap, "150");
});

/* ========================================================================== */
/* 4. Statuts, versions, tolérance                                           */
/* ========================================================================== */

test("une écriture REVERSED est exclue du cumul ET signalée", () => {
  const r = reconcileWallet({
    wallet: wallet({ amount: "1000", available: "1000", reserved: "0" }),
    entries: [
      entry({ direction: "CREDIT", amount: "1000" }),
      entry({ direction: "CREDIT", amount: "500", status: "REVERSED" }),
    ],
  });

  assert.equal(
    r.projected.availableAmount,
    "1000",
    "une écriture annulée ne doit pas remettre d'argent dans la projection"
  );
  assert.equal(r.entries.counted, 1);
  assert.equal(r.entries.skippedByStatus, 1);

  const signal = anomalyOf(r, ANOMALIES.UNEXPECTED_ENTRY_STATUS);
  assert.ok(
    signal,
    "aucune voie d'écriture du dépôt ne pose REVERSED : en trouver une doit se dire"
  );
  assert.deepEqual(signal.skipped, { REVERSED: 1 });

  assert.equal(
    r.verdict,
    VERDICTS.INDETERMINATE,
    "les montants concordent, mais l'hypothèse du contrôle ne tient plus : " +
      "rendre OK serait affirmer une conformité non vérifiée"
  );
});

test("une écriture en partie simple (sans ledgerVersion) est bien comptée", () => {
  // Le cas réel : `internalReferralTransferService` crédite le portefeuille avec
  // une écriture v1. L'ignorer comme le fait la balance de vérification
  // fabriquerait un écart de 250 de toutes pièces.
  const r = reconcileWallet({
    wallet: wallet({ amount: "1250", available: "1250", reserved: "0" }),
    entries: [
      entry({ direction: "CREDIT", amount: "1000" }),
      entry({ direction: "CREDIT", amount: "250", version: null }),
    ],
  });

  assert.equal(r.verdict, VERDICTS.OK);
  assert.equal(r.entries.counted, 2);
  assert.deepEqual(r.entries.byLedgerVersion, { 1: 1, 2: 1 });
});

test("minLedgerVersion permet de restreindre, et le rapport le dit", () => {
  const r = reconcileWallet({
    wallet: wallet({ amount: "1250", available: "1250", reserved: "0" }),
    entries: [
      entry({ direction: "CREDIT", amount: "1000" }),
      entry({ direction: "CREDIT", amount: "250", version: null }),
    ],
    minLedgerVersion: 2,
  });

  assert.equal(r.entries.skippedByVersion, 1);
  assert.equal(r.projected.availableAmount, "1000");

  const dispo = anomalyOf(r, ANOMALIES.AVAILABLE_DRIFT);
  assert.ok(dispo, "l'écart induit par la restriction doit rester visible");
  assert.equal(dispo.gap, "250");
});

test("la tolérance absorbe le résidu d'arrondi, pas un écart réel", () => {
  const sous = reconcileWallet({
    wallet: wallet({ amount: "700.004", available: "700.004", reserved: "0" }),
    entries: [entry({ direction: "CREDIT", amount: "700" })],
  });

  assert.equal(sous.verdict, VERDICTS.OK, "0,004 est sous la tolérance");
  assert.equal(sous.gaps.availableAmount, "0.004", "l'écart reste chiffré même sans alerte");

  const au_dessus = reconcileWallet({
    wallet: wallet({ amount: "700.006", available: "700.006", reserved: "0" }),
    entries: [entry({ direction: "CREDIT", amount: "700" })],
  });

  assert.equal(au_dessus.verdict, VERDICTS.DRIFT);
  assert.equal(anomalyOf(au_dessus, ANOMALIES.AVAILABLE_DRIFT).gap, "0.006");
});

/* ========================================================================== */
/* 5. Fermeture : le contrôle ne prétend jamais savoir                       */
/* ========================================================================== */

test("un montant d'écriture illisible rend le verdict INDÉTERMINÉ, jamais OK", () => {
  const r = reconcileWallet({
    wallet: wallet({ amount: "1000", available: "1000", reserved: "0" }),
    entries: [
      entry({ direction: "CREDIT", amount: "1000" }),
      entry({ direction: "CREDIT", amount: null }),
    ],
  });

  assert.equal(
    r.verdict,
    VERDICTS.INDETERMINATE,
    "montant illisible traité comme 0 : une donnée corrompue passerait pour saine"
  );

  const signal = anomalyOf(r, ANOMALIES.UNREADABLE_AMOUNT);
  assert.ok(signal);
  assert.equal(signal.entryCount, 1);
  assert.equal(r.entries.unreadable, 1);
});

test("un solde stocké illisible rend le verdict INDÉTERMINÉ, sans écart inventé", () => {
  const r = reconcileWallet({
    wallet: wallet({ amount: "1000", available: "n/a", reserved: "0" }),
    entries: [entry({ direction: "CREDIT", amount: "1000" })],
  });

  assert.equal(r.verdict, VERDICTS.INDETERMINATE);
  assert.deepEqual(anomalyOf(r, ANOMALIES.UNREADABLE_AMOUNT).storedFields, [
    "availableAmount",
  ]);
  assert.equal(
    r.gaps.availableAmount,
    null,
    "on ne fabrique pas un écart à partir d'une valeur qu'on n'a pas su lire"
  );
});

test("une écriture hors des deux comptes est refusée, pas cumulée en douce", () => {
  const r = reconcileWallet({
    wallet: wallet({ amount: "1000", available: "1000", reserved: "0" }),
    entries: [
      entry({ direction: "CREDIT", amount: "1000" }),
      entry({ account: "system_clearing:XOF", direction: "CREDIT", amount: "9999" }),
    ],
  });

  assert.equal(r.projected.availableAmount, "1000");
  assert.equal(r.entries.unexpectedAccount, 1);
  assert.ok(anomalyOf(r, ANOMALIES.UNEXPECTED_ACCOUNT));
  assert.equal(r.verdict, VERDICTS.INDETERMINATE);
});

test("le contrôle ne modifie ni le portefeuille ni les écritures", () => {
  // Les objets sont gelés par les fabriques : une écriture lèverait en mode
  // strict. C'est la preuve la plus directe de la lecture seule.
  const w = wallet({ amount: "500", available: "500", reserved: "0" });
  const entries = Object.freeze([
    entry({ direction: "CREDIT", amount: "1000" }),
    entry({ direction: "DEBIT", amount: "300" }),
  ]);

  assert.doesNotThrow(() => reconcileWallet({ wallet: w, entries }));

  assert.equal(w.availableAmount, "500", "le solde stocké a été touché");
  assert.equal(entries[0].amount, "1000");
});

test("reconcileWallet refuse un portefeuille sans utilisateur ou sans devise", () => {
  assert.throws(
    () => reconcileWallet({ wallet: { _id: "w", currency: "XOF" }, entries: [] }),
    /utilisateur/
  );

  assert.throws(
    () => reconcileWallet({ wallet: { _id: "w", user: USER }, entries: [] }),
    /devise/
  );
});

/* ========================================================================== */
/* 6. Agrégation                                                             */
/* ========================================================================== */

test("summarize refuse « healthy » dès qu'un portefeuille dérive ou est indéterminé", () => {
  const sain = reconcileWallet({
    wallet: wallet({ amount: "1000", available: "1000", reserved: "0" }),
    entries: [entry({ direction: "CREDIT", amount: "1000" })],
  });

  const derive = reconcileWallet({
    wallet: wallet({ amount: "500", available: "500", reserved: "0" }),
    entries: [entry({ direction: "CREDIT", amount: "1000" })],
  });

  assert.equal(summarize([sain]).healthy, true);

  const rapport = summarize([sain, derive]);
  assert.equal(rapport.healthy, false);
  assert.equal(rapport.checked.wallets, 2);
  assert.equal(rapport.byVerdict.OK, 1);
  assert.equal(rapport.byVerdict.DRIFT, 1);
  assert.equal(rapport.byType[ANOMALIES.AVAILABLE_DRIFT], 1);
  assert.equal(rapport.byType[ANOMALIES.TOTAL_DRIFT], 1);

  const indetermine = reconcileWallet({
    wallet: wallet({ amount: "1000", available: "1000", reserved: "0" }),
    entries: [entry({ direction: "CREDIT", amount: undefined })],
  });

  assert.equal(
    summarize([sain, indetermine]).healthy,
    false,
    "un portefeuille qu'on n'a pas su lire n'est pas un portefeuille sain"
  );
});
