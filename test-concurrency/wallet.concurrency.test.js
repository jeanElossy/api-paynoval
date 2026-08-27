"use strict";

/**
 * ============================================================================
 * MÊME PORTEFEUILLE — `NO DOUBLE DEBIT`
 * ============================================================================
 *
 * L'invariant qu'on cherche à mettre en défaut : un portefeuille qui couvre K
 * réservations ne doit jamais en accorder K+1, quel que soit le nombre de
 * demandes simultanées.
 *
 * ── Ce qui le tient aujourd'hui, et ce qui ne le tient pas
 *
 * Aucun verrou distribué ne protège `wallet` ni `balance` — c'est le constat
 * qui a ouvert la ligne A3 du suivi. La seule protection est la forme de
 * l'écriture, dans `models/TxWalletBalance.js` :
 *
 *     findOneAndUpdate(
 *       { user, currency, status: "active", availableAmount: { $gte: n } },
 *       { $inc: { reservedAmount: n, availableAmount: -n } }
 *     )
 *
 * C'est un **compare-and-swap** : la condition de solde vit DANS le filtre de
 * l'écriture, donc MongoDB l'évalue et applique l'incrément sous le même verrou
 * de document. Il n'y a pas de fenêtre entre « je lis 10 000 » et « je retire
 * 10 000 » — la fenêtre est ce que le verrou aurait servi à fermer.
 *
 * ── Ce test ne fait pas que constater le résultat
 *
 * Un test qui vérifierait seulement « le solde final est 0 » passerait aussi
 * sur un code qui sérialise tout. Il faut donc AUSSI que des demandes aient
 * réellement été refusées : `nbEchecs > 0` fait partie de la preuve. Sans
 * refus, la rafale n'a rien éprouvé.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const H = require("./lib/harness");

/** XOF : zéro décimale. Aucune erreur de virgule flottante ne peut se cacher. */
const DEVISE = "XOF";
const MONTANT = 1000;

const RAFALES = [2, 10, 100, 1000];

const utilisateurs = [];

before(async () => {
  await H.ouvrir();
  await H.verifierIndex();
});

after(async () => {
  await H.nettoyer({ userIds: utilisateurs });
  await H.fermer();
});

function nouvelUtilisateur() {
  const id = new mongoose.Types.ObjectId();
  utilisateurs.push(id);
  return id;
}

for (const N of RAFALES) {
  const K = Math.max(1, Math.floor(N / 2));

  test(`${N} réservations simultanées sur un portefeuille qui n'en couvre que ${K}`, async () => {
    const e = await H.ouvrir();
    const user = nouvelUtilisateur();

    // Le portefeuille est créé AVANT la rafale : ce test-ci porte sur le
    // compare-and-swap, pas sur la course à la création (voir plus bas).
    await e.Wallet.credit(user, DEVISE, K * MONTANT);

    const r = await H.rafale(N, () => e.Wallet.reserve(user, DEVISE, MONTANT));

    console.log(H.resumer(r, `même portefeuille · N=${N} · couvre ${K}`));

    assert.equal(
      r.nbReussites,
      K,
      `NO DOUBLE DEBIT VIOLÉ : ${r.nbReussites} réservations accordées pour ` +
        `${K} couvertes. Le portefeuille a payé ${r.nbReussites - K} fois de trop.`
    );

    assert.ok(
      r.nbEchecs > 0,
      "Aucune demande refusée : la rafale n'a rien éprouvé. " +
        "Vérifier que les tâches partent bien en parallèle."
    );

    const fin = await e.Wallet.findOne({ user, currency: DEVISE }).lean();
    const nb = (v) => Number(v?.toString?.() ?? v ?? 0);

    assert.equal(nb(fin.availableAmount), 0, "solde disponible final");
    assert.equal(nb(fin.reservedAmount), K * MONTANT, "fonds gelés finaux");

    // L'invariant de structure : rien n'a été créé ni détruit, seulement déplacé.
    assert.equal(
      nb(fin.amount),
      nb(fin.availableAmount) + nb(fin.reservedAmount),
      "amount = available + reserved — le portefeuille s'est désaccordé"
    );

    assert.ok(nb(fin.availableAmount) >= 0, "solde disponible NÉGATIF");
  });
}

test("un seul document de portefeuille survit à N créations simultanées", async () => {
  const e = await H.ouvrir();
  const user = nouvelUtilisateur();

  /**
   * ── Pourquoi ce test est séparé du précédent
   *
   * `reserve()` appelle `ensureWallet()`, un upsert. Or MongoDB ne sérialise
   * PAS les upserts concurrents : sans index unique sur `{user, currency}`,
   * plusieurs documents naissent pour le même portefeuille — et l'argent se
   * répartit entre eux, chacun cohérent avec lui-même. La balance de
   * vérification ne verrait rien : elle contrôle le grand livre, pas le nombre
   * de portefeuilles.
   *
   * Avec l'index, MongoDB refuse le second insert avec un E11000. Le pilote ne
   * rejoue pas : l'appelant reçoit une erreur de DOUBLON là où il demandait une
   * simple création. C'est le régime réel, et ce test mesure combien de
   * demandes légitimes en pâtissent au lieu de le supposer.
   */
  const r = await H.rafale(200, () => e.Wallet.ensureWallet(user, DEVISE));

  console.log(H.resumer(r, "création simultanée du même portefeuille · N=200"));

  const documents = await e.Wallet.countDocuments({ user, currency: DEVISE });

  assert.equal(
    documents,
    1,
    `${documents} documents pour UN portefeuille. L'index unique ` +
      `{user, currency} n'a pas tenu — l'argent se répartirait entre eux.`
  );
});

test("MÊME utilisateur, devises différentes — aucune contamination croisée", async () => {
  /**
   * ── Le cas de la liste A2 que les tests ci-dessus ne couvrent pas
   *
   * « Même portefeuille » et « même utilisateur » ne sont pas la même chose :
   * un utilisateur détient un portefeuille PAR DEVISE. Le filtre de chaque
   * écriture porte `{ user, currency }` — si `currency` en tombait, ou si la
   * normalisation de devise divergeait entre deux chemins, une réservation en
   * XOF piocherait dans le solde CAD.
   *
   * Ce serait un défaut particulièrement coûteux : chaque portefeuille resterait
   * cohérent avec lui-même, le grand livre resterait équilibré PAR DEVISE, et
   * rien dans les contrôles existants ne le dirait. Seul le total par devise
   * bougerait — c'est exactement ce qu'on vérifie ici.
   */
  const e = await H.ouvrir();
  const user = nouvelUtilisateur();

  const DEVISES = ["XOF", "CAD", "USD"];
  const COUVERTES = 10;
  const PAR_DEVISE = 40;

  for (const cur of DEVISES) {
    await e.Wallet.credit(user, cur, COUVERTES * MONTANT);
  }

  // Les trois devises partent MÉLANGÉES dans la même rafale : sérialiser par
  // devise ne testerait rien de la cohabitation.
  const taches = DEVISES.flatMap((cur) =>
    Array.from({ length: PAR_DEVISE }, () => cur)
  ).sort(() => Math.random() - 0.5);

  const r = await H.rafale(taches.length, (i) =>
    e.Wallet.reserve(user, taches[i], MONTANT)
  );

  console.log(
    H.resumer(r, `même utilisateur · ${DEVISES.length} devises · N=${taches.length}`)
  );

  assert.equal(
    r.nbReussites,
    COUVERTES * DEVISES.length,
    "le nombre total de réservations accordées ne correspond pas"
  );

  const nb = (v) => Number(v?.toString?.() ?? v ?? 0);

  for (const cur of DEVISES) {
    const w = await e.Wallet.findOne({ user, currency: cur }).lean();

    assert.equal(
      nb(w.reservedAmount),
      COUVERTES * MONTANT,
      `${cur} : ${nb(w.reservedAmount)} gelés au lieu de ${COUVERTES * MONTANT}. ` +
        `Une réservation d'une AUTRE devise a pioché ici.`
    );

    assert.equal(nb(w.availableAmount), 0, `${cur} : solde disponible final`);
    assert.equal(
      nb(w.amount),
      nb(w.availableAmount) + nb(w.reservedAmount),
      `${cur} : amount = available + reserved`
    );
  }
});
