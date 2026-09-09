"use strict";

/**
 * ============================================================================
 * LE SOLDE CONFRONTÉ AU GRAND LIVRE — BOUT EN BOUT, AVEC BASE
 * ============================================================================
 *
 * ── Pourquoi ce fichier est ICI et pas dans `npm test`
 *
 * Le cœur du contrôle est pur et testé sans base
 * (`test/walletLedgerReconciliation.test.js`, 24 tests). Ce qu'il ne peut PAS
 * prouver, c'est que les identifiants de compte reconstruits à la lecture
 * correspondent à ceux que `ledgerService` écrit réellement, ni que la requête
 * Mongo ramène bien les écritures visées. Une erreur d'un caractère dans
 * `user_wallet:<id>:<devise>` et le contrôle rapporterait une perte totale sur
 * chaque portefeuille — ou, pire, ne rapporterait rien.
 *
 * Cette vérification-là exige une vraie base. Elle vit donc derrière
 * `npm run test:concurrency`, comme les autres, et `npm test` ne la voit pas :
 * les 647 tests de `npm test` n'ouvrent aucune connexion et doivent le rester.
 *
 * ── Ce que ce fichier prouve, et qui est le cœur du sujet
 *
 * Il construit un portefeuille **cohérent avec lui-même mais faux** :
 *
 *     amount = 7000   available = 5500   reserved = 1500
 *     7000 = 5500 + 1500  ✓   ← `checkWalletBalances` ne voit RIEN
 *     Σ DEBIT = Σ CREDIT  ✓   ← `computeTrialBalance` ne voit RIEN
 *     et pourtant le grand livre dit que le disponible vaut 6000.
 *
 * C'est exactement le trou que ce contrôle comble. Le test vérifie donc les
 * TROIS choses ensemble : que les deux contrôles existants restent muets, et
 * que le nouveau parle — avec les bons chiffres.
 *
 * ── Une écriture sur un portefeuille, dans un test, et nulle part ailleurs
 *
 * Planter le mensonge suppose d'écrire un solde faux : c'est fait par
 * `Wallet.collection.updateOne`, qui contourne les primitives. Ce n'est
 * acceptable que parce que `benchGuard` a déjà prouvé que la base porte un
 * préfixe `bench_` et que le portefeuille a été fabriqué par ce fichier même —
 * c'est le geste que le harnais s'autorise déjà pour nettoyer le grand livre.
 * **Aucun code de `src/` ne doit le reprendre.** Le service de réconciliation,
 * lui, est en lecture seule sans exception.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const H = require("./lib/harness");

const DEVISE = "XOF";

const transactions = [];
const utilisateurs = [];

let ledgerService;
let reconciliation;

before(async () => {
  await H.ouvrir();
  await H.verifierIndex();

  // Après l'ouverture seulement : ces modules résolvent des modèles sur
  // `getTxConn()` dès leur chargement.
  ledgerService = require("../src/services/ledgerService");
  reconciliation = require("../src/services/reconciliation/walletLedgerReconciliationService");
});

after(async () => {
  await H.nettoyer({ userIds: utilisateurs, transactionIds: transactions });
  await H.fermer();
});

function nouvelleTransaction() {
  const _id = new mongoose.Types.ObjectId();
  transactions.push(_id);
  return { _id, reference: `WLR-${_id}`, flow: "PAYNOVAL_INTERNAL_TRANSFER" };
}

function nouvelUtilisateur() {
  const id = new mongoose.Types.ObjectId();
  utilisateurs.push(id);
  return id;
}

/**
 * Construit un portefeuille par le CHEMIN RÉEL : chaque mouvement passe par
 * `ledgerService`, qui déplace le solde et pose ses écritures dans le même
 * geste. Un test qui écrirait les écritures à la main testerait sa propre idée
 * du grand livre, pas celui du service.
 *
 * Le parcours est choisi pour que les trois champs DIFFÈRENT à l'arrivée :
 * sans cela, comparer au bon champ ou au mauvais donnerait le même résultat et
 * le test ne discriminerait rien.
 */
async function construireParcoursReel(user) {
  await ledgerService.creditReceiverFunds({
    transaction: nouvelleTransaction(),
    receiverId: user,
    amount: 10000,
    currency: DEVISE,
  });

  await ledgerService.reserveSenderFunds({
    transaction: nouvelleTransaction(),
    senderId: user,
    amount: 4000,
    currency: DEVISE,
  });

  await ledgerService.captureSenderReserve({
    transaction: nouvelleTransaction(),
    senderId: user,
    amount: 2500,
    currency: DEVISE,
  });

  // amount 7500 · available 6000 · reserved 1500
  return { amount: 7500, available: 6000, reserved: 1500 };
}

test("un portefeuille bâti par le chemin réel est déclaré conforme au grand livre", async () => {
  const e = await H.ouvrir();
  const user = nouvelUtilisateur();

  const attendu = await construireParcoursReel(user);

  const w = await e.Wallet.findOne({ user, currency: DEVISE }).lean();
  assert.equal(Number(w.amount.toString()), attendu.amount);
  assert.equal(Number(w.availableAmount.toString()), attendu.available);
  assert.equal(Number(w.reservedAmount.toString()), attendu.reserved);

  const r = await reconciliation.reconcileOneWallet({
    userId: user,
    currency: DEVISE,
  });

  assert.ok(r, "le portefeuille devrait être trouvé");

  assert.equal(
    r.verdict,
    "OK",
    "portefeuille sain déclaré en écart — les identifiants de compte " +
      `reconstruits ne correspondent pas à ceux qu'écrit ledgerService.\n` +
      `  comptes visés : ${JSON.stringify(r.accounts)}\n` +
      `  écritures trouvées : ${r.entries.counted}\n` +
      `  anomalies : ${JSON.stringify(r.anomalies, null, 2)}`
  );

  /**
   * Le contrôle a-t-il seulement REGARDÉ quelque chose ? Un verdict « OK »
   * obtenu sur zéro écriture ne prouve rien — c'est la variante silencieuse de
   * la panne qu'on cherche à empêcher.
   */
  assert.equal(
    r.entries.counted,
    4,
    "4 jambes du parcours touchent ces deux comptes : CREDIT user_wallet " +
      "(crédit), DEBIT user_wallet + CREDIT system_reserve (réservation), " +
      "DEBIT system_reserve (capture). Les deux jambes de compensation ne " +
      "sont pas des nôtres. Un autre compte signifie que la requête ne " +
      "ramène pas ce qu'on croit"
  );
  assert.equal(r.entries.onWalletAccount, 2);
  assert.equal(r.entries.onReserveAccount, 2);

  assert.equal(r.projected.availableAmount, "6000");
  assert.equal(r.projected.reservedAmount, "1500");
  assert.equal(r.projected.amount, "7500");
});

test("un solde COHÉRENT AVEC LUI-MÊME mais faux est détecté — et par lui seul", async () => {
  const e = await H.ouvrir();
  const user = nouvelUtilisateur();

  await construireParcoursReel(user);

  /**
   * Le mensonge. `amount` et `availableAmount` baissent ENSEMBLE de 500 :
   * l'invariant local `amount = available + reserved` tient toujours, donc le
   * contrôle existant reste aveugle. Aucune écriture n'est touchée, donc la
   * balance de vérification reste fermée. Seule la confrontation des deux voit
   * quelque chose.
   */
  const dec = (n) => mongoose.Types.Decimal128.fromString(String(n));

  await e.Wallet.collection.updateOne(
    { user, currency: DEVISE },
    { $set: { amount: dec(7000), availableAmount: dec(5500) } }
  );

  const w = await e.Wallet.findOne({ user, currency: DEVISE }).lean();

  /* ── 1. Le contrôle existant reste MUET (c'est le trou) ─────────────────── */
  const amount = Number(w.amount.toString());
  const available = Number(w.availableAmount.toString());
  const reserved = Number(w.reservedAmount.toString());

  assert.equal(
    amount,
    available + reserved,
    "le scénario ne démontre rien si `checkWalletBalances` peut l'attraper : " +
      "il doit rester cohérent avec lui-même"
  );

  /* ── 2. La balance de vérification reste FERMÉE (c'est le trou aussi) ──── */
  await H.assertBalanceFerme(
    { transactionId: { $in: transactions } },
    "le grand livre est intact — seul le solde ment"
  );

  /* ── 3. Le nouveau contrôle, lui, parle ────────────────────────────────── */
  const r = await reconciliation.reconcileOneWallet({
    userId: user,
    currency: DEVISE,
  });

  assert.equal(
    r.verdict,
    "DRIFT",
    "un solde qui ment de 500 face à son grand livre n'a pas été détecté"
  );

  const dispo = r.anomalies.find(
    (a) => a.type === "WALLET_LEDGER_AVAILABLE_DRIFT"
  );

  assert.ok(dispo, `écart sur le disponible non signalé : ${JSON.stringify(r)}`);
  assert.equal(dispo.stored, "5500");
  assert.equal(dispo.projected, "6000");
  assert.equal(dispo.gap, "-500");
  assert.equal(dispo.entriesCounted, 2, "2 jambes sur user_wallet");

  const total = r.anomalies.find((a) => a.type === "WALLET_LEDGER_TOTAL_DRIFT");
  assert.ok(total, "écart sur le total non signalé");
  assert.equal(total.stored, "7000");
  assert.equal(total.projected, "7500");
  assert.equal(total.gap, "-500");

  assert.equal(
    r.anomalies.find((a) => a.type === "WALLET_LEDGER_RESERVED_DRIFT"),
    undefined,
    "la réserve est juste : la signaler serait crier au loup"
  );

  console.log(
    `    écart détecté — stocké ${dispo.stored}, recalculé ${dispo.projected}, ` +
      `écart ${dispo.gap} sur ${dispo.entriesCounted} écritures`
  );
});

test("le contrôle N'ÉCRIT RIEN — le solde faux est toujours faux après passage", async () => {
  const e = await H.ouvrir();
  const user = nouvelUtilisateur();

  await construireParcoursReel(user);

  const dec = (n) => mongoose.Types.Decimal128.fromString(String(n));
  await e.Wallet.collection.updateOne(
    { user, currency: DEVISE },
    { $set: { amount: dec(7000), availableAmount: dec(5500) } }
  );

  const ecrituresAvant = await e.LedgerEntry.countDocuments({
    accountId: `user_wallet:${user}:${DEVISE}`,
  });

  await reconciliation.reconcileOneWallet({ userId: user, currency: DEVISE });
  await reconciliation.reconcileWalletsAgainstLedger({
    userId: user,
    currency: DEVISE,
  });

  const apres = await e.Wallet.findOne({ user, currency: DEVISE }).lean();

  /**
   * Un contrôle qui « répare » est une seconde source de mouvements d'argent,
   * déclenchée par un travail de fond que personne ne regarde. Le solde faux
   * DOIT rester faux : il se corrige par une contre-écriture décidée par un
   * humain.
   */
  assert.equal(
    Number(apres.availableAmount.toString()),
    5500,
    "le contrôle a corrigé le solde — c'est de l'argent écrit sans écriture " +
      "comptable, l'inverse exact de l'invariant 2"
  );
  assert.equal(Number(apres.amount.toString()), 7000);

  assert.equal(
    await e.LedgerEntry.countDocuments({
      accountId: `user_wallet:${user}:${DEVISE}`,
    }),
    ecrituresAvant,
    "le contrôle a écrit dans le grand livre"
  );
});

test("le balayage restreint à un utilisateur ne ramène que lui", async () => {
  const sain = nouvelUtilisateur();
  const menteur = nouvelUtilisateur();

  await construireParcoursReel(sain);
  await construireParcoursReel(menteur);

  const e = await H.ouvrir();
  const dec = (n) => mongoose.Types.Decimal128.fromString(String(n));

  await e.Wallet.collection.updateOne(
    { user: menteur, currency: DEVISE },
    { $set: { amount: dec(7000), availableAmount: dec(5500) } }
  );

  const rapportSain = await reconciliation.reconcileWalletsAgainstLedger({
    userId: sain,
    currency: DEVISE,
  });

  assert.equal(rapportSain.checked.wallets, 1);
  assert.equal(rapportSain.healthy, true, JSON.stringify(rapportSain.anomalies));

  const rapportMenteur = await reconciliation.reconcileWalletsAgainstLedger({
    userId: menteur,
    currency: DEVISE,
  });

  assert.equal(rapportMenteur.checked.wallets, 1);
  assert.equal(rapportMenteur.healthy, false);
  assert.equal(rapportMenteur.divergent.length, 1);
  assert.equal(rapportMenteur.divergent[0].userId, String(menteur));
});
