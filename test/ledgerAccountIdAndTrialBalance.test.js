"use strict";

/**
 * UNE SEULE CONVENTION DE COMPTE, ET UN FILET QUI N'ABSORBE PAS
 * ============================================================================
 *
 * Deux défauts trouvés par l'audit de `ledger.md` du 2026-09-03, tous deux au
 * cœur de l'invariant 2 (le grand livre fait foi).
 *
 * ── 1. Deux constructeurs d'identifiant de compte, divergents ─────────────
 *
 * `ledgerService.js` portait ses propres copies de `userWalletAccountId` et
 * `treasuryAccountId`, avec une normalisation de devise différente de celle du
 * module `doubleEntry` :
 *
 *     "FCFA" →  user_wallet:<id>:XOF    (ledgerService, avec alias)
 *     "FCFA" →  user_wallet:<id>:FCFA   (doubleEntry, sans alias)
 *
 * Soit « deux comptes pour un seul argent » — le défaut que `utils/currency.js`
 * raconte avoir déjà coûté cher. Le chemin de production était sauf, mais la
 * version exportée par `doubleEntry` restait un piège armé. L'identifiant de
 * compte est la clé de jointure entre le grand livre et sa projection : il ne
 * peut pas avoir deux implémentations.
 *
 * ── 2. Le filet absorbait ce qu'il devait détecter ────────────────────────
 *
 * `summarizeLegs` faisait `Number(leg?.amount || 0)` — un montant illisible
 * comptait pour **zéro** — et traitait tout sens différent de `"DEBIT"` comme
 * un **crédit**. Sans conséquence à l'écriture (`checkBalanced` valide en
 * amont), mais `computeTrialBalance` l'appelle sur des données RELUES, sans
 * validation. Or c'est exactement le contrôle censé rattraper une écriture de
 * masse ayant contourné les gardes du modèle.
 *
 * Le filet avait des mailles là où on lui demande de tenir.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  userWalletAccountId,
  treasuryAccountId,
  systemReserveAccountId,
  systemClearingAccountId,
  computeTrialBalance,
  checkBalanced,
  LEDGER_VERSION,
} = require("../src/services/ledger/doubleEntry");

const ID = "000000000000000000000001";

/* -------------------------------------------------------------------------- */
/* 1. Une seule convention                                                    */
/* -------------------------------------------------------------------------- */

test("les alias de devise sont appliqués aux identifiants de compte", () => {
  assert.equal(userWalletAccountId(ID, "FCFA"), `user_wallet:${ID}:XOF`);
  assert.equal(userWalletAccountId(ID, "xof"), `user_wallet:${ID}:XOF`);
  assert.equal(userWalletAccountId(ID, " XOF "), `user_wallet:${ID}:XOF`);
});

test("une même devise donne le MÊME compte, quelle que soit son écriture", () => {
  const ecritures = ["XOF", "xof", "FCFA", "fcfa", " XOF "];
  const comptes = new Set(ecritures.map((c) => userWalletAccountId(ID, c)));

  assert.equal(
    comptes.size,
    1,
    `« deux comptes pour un seul argent » : ${[...comptes].join(" ≠ ")}`
  );
});

test("les quatre familles de comptes suivent la même normalisation", () => {
  assert.match(userWalletAccountId(ID, "FCFA"), /:XOF$/);
  assert.match(systemReserveAccountId(ID, "FCFA"), /:XOF$/);
  assert.match(systemClearingAccountId("FCFA"), /:XOF$/);
  assert.match(
    treasuryAccountId({ treasuryUserId: ID, treasurySystemType: "FEES_TREASURY", currency: "FCFA" }),
    /:XOF$/
  );
});

test("une devise absente LÈVE — aucun repli sur un compte quelconque", () => {
  for (const mauvaise of ["", "   ", null, undefined]) {
    assert.throws(
      () => userWalletAccountId(ID, mauvaise),
      /Devise absente/i,
      "un repli ferait porter l'écriture au mauvais compte, sans erreur"
    );
  }
});

test("ledgerService ne redéfinit plus ces constructeurs", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "ledgerService.js"),
    "utf8"
  );

  for (const nom of ["userWalletAccountId", "treasuryAccountId"]) {
    assert.ok(
      !new RegExp(`function\\s+${nom}\\s*\\(`).test(src),
      `ledgerService.js redéfinit ${nom} : c'est la divergence d'origine`
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 2. Le filet signale au lieu d'absorber                                     */
/* -------------------------------------------------------------------------- */

const ecriture = (direction, amount, extra = {}) => ({
  direction,
  amount,
  currency: "XOF",
  metadata: { ledgerVersion: LEDGER_VERSION },
  ...extra,
});

test("un lot sain reste équilibré", () => {
  const t = computeTrialBalance([ecriture("DEBIT", 500), ecriture("CREDIT", 500)]);

  assert.equal(t.balanced, true);
  assert.equal(t.ecartsDansLaTolerance, true);
  assert.equal(t.anomalies.montantIllisible, 0);
  assert.equal(t.anomalies.sensInconnu, 0);
});

test("un montant ILLISIBLE ne compte plus pour zéro en silence", () => {
  const t = computeTrialBalance([
    ecriture("DEBIT", "pas-un-nombre"),
    ecriture("CREDIT", 500),
  ]);

  assert.equal(t.anomalies.montantIllisible, 1, "l'anomalie doit être comptée");
  assert.equal(
    t.balanced,
    false,
    "« je ne sais pas lire » n'est pas « équilibré » — c'est la maille du filet"
  );
});

test("un SENS inconnu ne compte plus pour un crédit en silence", () => {
  const t = computeTrialBalance([
    ecriture("DEBIT", 500),
    ecriture("N-IMPORTE-QUOI", 500),
  ]);

  assert.equal(t.anomalies.sensInconnu, 1);
  assert.equal(t.balanced, false);
});

test("un sens ABSENT est aussi une anomalie", () => {
  const t = computeTrialBalance([ecriture("DEBIT", 500), ecriture(undefined, 500)]);

  assert.equal(t.anomalies.sensInconnu, 1);
  assert.equal(t.balanced, false);
});

test("déséquilibre et illisibilité restent DISTINGUABLES", () => {
  // Deux problèmes différents appellent deux actions différentes : il ne faut
  // pas que l'un se déguise en l'autre.
  const desequilibre = computeTrialBalance([
    ecriture("DEBIT", 500),
    ecriture("CREDIT", 300),
  ]);
  assert.equal(desequilibre.ecartsDansLaTolerance, false);
  assert.equal(desequilibre.anomalies.montantIllisible, 0);

  const illisible = computeTrialBalance([
    ecriture("DEBIT", NaN),
    ecriture("CREDIT", 0),
  ]);
  assert.equal(illisible.ecartsDansLaTolerance, true);
  assert.equal(illisible.anomalies.montantIllisible, 1);
});

test("checkBalanced REFUSE, il ne lève pas", () => {
  /**
   * `checkBalanced` est un validateur : tout l'appelant attend un
   * `{ ok: false, reason }`. Utiliser la normalisation stricte ici ferait
   * remonter une exception à la place du refus — la garde disparaîtrait
   * derrière un plantage.
   */
  // Jambe COMPLÈTE à un détail près : sans quoi une validation antérieure
  // (type de compte, montant…) se déclencherait et le test viserait à côté.
  const jambe = (extra) => ({
    direction: "DEBIT",
    amount: 100,
    currency: "XOF",
    accountType: "USER_WALLET",
    accountId: `user_wallet:${ID}:XOF`,
    ...extra,
  });

  const r = checkBalanced([
    jambe({ currency: "" }),
    jambe({ direction: "CREDIT" }),
  ]);

  assert.equal(r.ok, false, "un refus structuré, pas une exception");
  assert.equal(r.reason, "missing-currency");
});
