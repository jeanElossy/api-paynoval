"use strict";

/**
 * ============================================================================
 * MÊME TRANSACTION — `NO DOUBLE CREDIT` · `NO INCONSISTENT LEDGER`
 * ============================================================================
 *
 * Le grand livre fait foi (invariant n° 2). Un même mouvement enregistré deux
 * fois y est particulièrement vicieux : les DEUX jambes sont dupliquées, donc
 * Σ DEBIT − Σ CREDIT vaut toujours zéro. **La balance de vérification ne voit
 * rien** — et pourtant le solde comptable du compte est faux du double.
 *
 * La seule protection contre ça est `dedupKey` et son index unique partiel.
 * Ce fichier la met à l'épreuve en concurrence, pas en séquence.
 *
 * ── Les deux régimes, et pourquoi les deux comptent
 *
 *   1. AVEC transaction MongoDB — le régime normal. Le lot d'écritures part
 *      dans la même transaction que le mouvement de portefeuille ; un conflit
 *      d'écriture est rejoué par le pilote.
 *
 *   2. SANS transaction — le mode dégradé (`MONGO_SHARE_CLIENT=off`, ou un
 *      cluster sans jeu de réplicas). Il est réel, il est documenté, et c'est
 *      LUI que `dedupKey` a été écrit pour couvrir. Ne tester que le régime
 *      normal reviendrait à ne pas tester le filet.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const H = require("./lib/harness");

const DEVISE = "XOF";
const MONTANT = 5000;

const transactions = [];
const utilisateurs = [];

let ledgerService;
let doubleEntry;

before(async () => {
  await H.ouvrir();
  await H.verifierIndex();

  // Après l'ouverture : ces modules résolvent des modèles sur `getTxConn()`.
  ledgerService = require("../src/services/ledgerService");
  doubleEntry = require("../src/services/ledger/doubleEntry");
});

after(async () => {
  await H.nettoyer({ userIds: utilisateurs, transactionIds: transactions });
  await H.fermer();
});

function contexteNeuf() {
  const transactionId = new mongoose.Types.ObjectId();
  const user = new mongoose.Types.ObjectId();

  transactions.push(transactionId);
  utilisateurs.push(user);

  return { transactionId, user };
}

function legsDe(user) {
  return doubleEntry.transferLegs({
    from: {
      accountType: "USER_WALLET",
      accountId: doubleEntry.userWalletAccountId(user, DEVISE),
      userId: user,
    },
    to: {
      accountType: "SYSTEM_RESERVE",
      accountId: doubleEntry.systemReserveAccountId(user, DEVISE),
      userId: user,
    },
    amount: MONTANT,
    currency: DEVISE,
  });
}

for (const N of [2, 10, 100]) {
  test(`${N} écritures simultanées du MÊME mouvement — hors transaction`, async () => {
    const e = await H.ouvrir();
    const { transactionId, user } = contexteNeuf();

    const r = await H.rafale(N, () =>
      ledgerService.postDoubleEntry({
        transactionId,
        reference: `CONC-${transactionId}`,
        entryType: "RESERVE",
        context: "test-concurrence",
        dedupScope: "reserveSenderFunds",
        legs: legsDe(user),
        metadata: { stage: "test" },
        session: null,
      })
    );

    console.log(H.resumer(r, `même mouvement hors transaction · N=${N}`));

    const ecrites = await e.LedgerEntry.countDocuments({ transactionId });

    assert.equal(
      ecrites,
      2,
      `NO DOUBLE CREDIT VIOLÉ : ${ecrites} écritures pour UN mouvement à deux ` +
        `jambes. Le grand livre reste ÉQUILIBRÉ (les doublons vont par paires) ` +
        `— donc la balance de vérification ne l'aurait jamais signalé.`
    );

    await H.assertBalanceFerme({ transactionId }, `après ${N} écritures du même mouvement`);
  });
}

test("le rejeu concurrent ne fabrique pas de faux « grand livre INCOMPLET »", async () => {
  /**
   * ── Ce que ce test mesure, et pourquoi il ne l'affirme pas d'avance
   *
   * Hors transaction, la reprise sur E11000 de `postDoubleEntry` relit les clés
   * du lot et exige de les trouver TOUTES ; sinon elle lève
   * `LEDGER_PARTIAL_POSTING` — « le lot précédent s'est interrompu ».
   *
   * En séquence, ce raisonnement est juste. En CONCURRENCE, il existe une
   * fenêtre : la tâche B peut heurter la jambe 0 déjà insérée par A pendant que
   * A n'a pas encore inséré la jambe 1. B relit, trouve 1 clé sur 2, et conclut
   * à un lot incomplet — alors que le grand livre est parfaitement sain.
   *
   * Ce serait une **fausse alerte sur le chemin de l'argent** : une erreur 500
   * et un appel à intervention manuelle pour un lot qui n'a rien.
   *
   * `insertMany({ordered: true})` sur deux jambes rend la fenêtre étroite, pas
   * inexistante. On la MESURE ici — et si elle se referme d'elle-même, on l'aura
   * constaté au lieu de l'avoir supposé.
   */
  const e = await H.ouvrir();
  const { transactionId, user } = contexteNeuf();

  const r = await H.rafale(200, () =>
    ledgerService.postDoubleEntry({
      transactionId,
      reference: `RACE-${transactionId}`,
      entryType: "RESERVE",
      context: "test-fenetre",
      dedupScope: "reserveSenderFunds",
      legs: legsDe(user),
      session: null,
    })
  );

  const faussesAlertes = r.echecsBruts.filter(
    (err) => err?.code === "LEDGER_PARTIAL_POSTING"
  );

  console.log(
    H.resumer(r, "fenêtre de rejeu concurrent · N=200") +
      `\n    fausses alertes « lot incomplet » : ${faussesAlertes.length}`
  );

  // Quoi qu'il arrive côté alertes, le grand livre lui-même doit être intact.
  const ecrites = await e.LedgerEntry.countDocuments({ transactionId });
  assert.equal(ecrites, 2, "le grand livre a été dupliqué");

  await H.assertBalanceFerme({ transactionId }, "après 200 rejeux concurrents");

  assert.equal(
    faussesAlertes.length,
    0,
    `${faussesAlertes.length} rejeux sur 200 ont conclu à tort à un « grand ` +
      `livre INCOMPLET » alors que les 2 jambes sont bien présentes. ` +
      `En production ce sont autant de 500 et d'appels à intervention manuelle ` +
      `sur un grand livre sain.`
  );
});

test("N réservations simultanées SOUS transaction Mongo — le chemin réel", async () => {
  /**
   * Ici on exerce le chemin de production : `runInTransaction`, qui délègue à
   * `session.withTransaction()` et rejoue donc le corps sur conflit d'écriture.
   * Portefeuille ET grand livre bougent ensemble, ou pas du tout.
   */
  const e = await H.ouvrir();
  const runtime = require("../src/services/transactions/shared/runtime");

  const user = new mongoose.Types.ObjectId();
  utilisateurs.push(user);

  const N = 50;
  const COUVERTES = 20;

  await e.Wallet.credit(user, DEVISE, COUVERTES * MONTANT);

  const ids = Array.from({ length: N }, () => new mongoose.Types.ObjectId());
  transactions.push(...ids);

  const r = await H.rafale(N, async (i) => {
    const session = await runtime.startTxSession();

    try {
      return await runtime.runInTransaction(session, async (sess) => {
        return ledgerService.reserveSenderFunds({
          transaction: { _id: ids[i], reference: `TXC-${ids[i]}` },
          senderId: user,
          amount: MONTANT,
          currency: DEVISE,
          session: sess,
        });
      });
    } finally {
      await runtime.safeEndSession(session);
    }
  });

  console.log(
    H.resumer(r, `sous transaction Mongo · N=${N} · couvre ${COUVERTES}`)
  );

  assert.equal(
    r.nbReussites,
    COUVERTES,
    `NO DOUBLE DEBIT VIOLÉ sous transaction : ${r.nbReussites} réservations ` +
      `pour ${COUVERTES} couvertes.`
  );

  const fin = await e.Wallet.findOne({ user, currency: DEVISE }).lean();
  const nb = (v) => Number(v?.toString?.() ?? v ?? 0);

  assert.equal(nb(fin.availableAmount), 0, "solde disponible final");
  assert.equal(nb(fin.reservedAmount), COUVERTES * MONTANT, "fonds gelés finaux");

  /**
   * ═══ LE CONTRÔLE QUI COMPTE VRAIMENT ═════════════════════════════════════
   *
   * Le portefeuille et le grand livre sont écrits dans la MÊME transaction.
   * S'ils divergent, c'est que l'atomicité n'a pas tenu — et c'est exactement
   * ce qu'aucun test unitaire ne peut voir.
   */
  const ecritures = await e.LedgerEntry.find({ transactionId: { $in: ids } }).lean();

  assert.equal(
    ecritures.length,
    COUVERTES * 2,
    `Le grand livre porte ${ecritures.length} jambes pour ` +
      `${r.nbReussites} réservations validées (attendu ${COUVERTES * 2}). ` +
      `Portefeuille et grand livre ont divergé : l'atomicité n'a pas tenu.`
  );

  await H.assertBalanceFerme(
    { transactionId: { $in: ids } },
    "après réservations concurrentes sous transaction"
  );
});
