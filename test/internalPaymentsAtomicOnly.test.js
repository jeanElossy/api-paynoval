"use strict";

/**
 * LES PAIEMENTS INTERNES NE BOUGENT PAS D'ARGENT SANS TRANSACTION ATOMIQUE
 * ============================================================================
 *
 * `internalPaymentsController.js` touche DEUX comptes : un débit puis un crédit.
 * Quand les deux bases ne partagent pas le même `MongoClient`, aucune session
 * multi-documents n'est possible — les deux écritures ne sont donc pas
 * atomiques.
 *
 * Le rattrapage était confié à une compensation écrite à la main dans le bloc
 * `catch`. Elle portait deux défauts, trouvés le 2026-09-03 :
 *
 *   1. **Asymétrique.** Elle ne remboursait que le DÉBIT. `credited` et
 *      `creditUserId` étaient pourtant suivis, et elle les ignorait : une
 *      erreur survenant après le crédit remboursait l'expéditeur et laissait le
 *      bénéficiaire crédité. **De l'argent créé** — la faute la plus grave
 *      possible sur ce chemin.
 *
 *   2. **Aucune contre-écriture.** Si `postInternalPaymentEntries` avait déjà
 *      écrit au grand livre, la compensation restaurait le solde en silence :
 *      le grand livre disait que l'argent avait bougé, le solde disait le
 *      contraire. L'invariant 4 exige un `REVERSAL`, jamais une restauration
 *      muette.
 *
 * Traitement retenu : **refus** (règle B.2). Rendre la compensation correcte
 * demanderait de rejouer à la main ce qu'une transaction fait gratuitement, et
 * de le faire juste dans un bloc `catch` que personne n'exerce.
 *
 * Lecture du source : charger ce contrôleur ouvre des connexions Mongo.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CHEMIN = path.join(
  __dirname,
  "..",
  "src",
  "controllers",
  "internalPaymentsController.js"
);
const SOURCE = fs.readFileSync(CHEMIN, "utf8");

/** Hors commentaires : le fichier DÉCRIT la faute retirée pour l'expliquer. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Position de LA garde de refus — pas de la première occurrence de
 * `canShareSession()`, qui apparaît dès `startTxSession()` (ligne ~71) et n'a
 * rien à voir. Chercher la chaîne nue ferait pointer le test 100 lignes trop
 * haut et le rendrait vrai par accident.
 */
const MOTIF_REFUS =
  /if\s*\(\s*!canShareSession\(\)\s*\)\s*\{[\s\S]{0,600}?createError\(\s*503/;
const POS_REFUS = CODE.search(MOTIF_REFUS);

/* -------------------------------------------------------------------------- */
/* Le refus existe et ferme                                                   */
/* -------------------------------------------------------------------------- */

test("le corps refuse de bouger de l'argent sans session partagée", () => {
  assert.match(CODE, MOTIF_REFUS, "un mouvement non atomique doit être REFUSÉ, pas rattrapé");
});

test("le refus précède la première écriture de solde", () => {
  const posRefus = POS_REFUS;
  const posDebit = CODE.indexOf("TxWalletBalance.debit(");
  const posCredit = CODE.indexOf("TxWalletBalance.credit(");

  assert.ok(posRefus > -1, "refus introuvable");
  assert.ok(posDebit > -1, "le débit doit toujours exister");
  assert.ok(
    posRefus < posDebit,
    "refuser APRÈS le débit laisserait de l'argent déplacé — c'est le défaut d'origine"
  );
  if (posCredit > -1) {
    assert.ok(posRefus < posCredit, "le refus doit aussi précéder le crédit");
  }
});

/* -------------------------------------------------------------------------- */
/* La compensation manuelle ne revient pas                                    */
/* -------------------------------------------------------------------------- */

test("aucune compensation manuelle de solde dans le bloc catch", () => {
  const posCatch = CODE.indexOf("} catch (err) {");
  assert.ok(posCatch > -1, "bloc catch introuvable");

  const apresCatch = CODE.slice(posCatch);

  for (const interdit of ["TxWalletBalance.credit(", "TxWalletBalance.debit("]) {
    assert.ok(
      !apresCatch.includes(interdit),
      `« ${interdit} » réapparaît dans le bloc catch. Une compensation écrite à ` +
        "la main sur un chemin d'argent doit être symétrique ET produire une " +
        "contre-écriture au grand livre — c'est précisément ce qui manquait."
    );
  }
});

test("un rattrapage improvisé n'a pas été réintroduit ailleurs dans le catch", () => {
  const apresCatch = CODE.slice(CODE.indexOf("} catch (err) {"));

  for (const interdit of ["compensate", "refundSenderFunds(", "creditReceiverFunds("]) {
    assert.ok(
      !apresCatch.includes(interdit),
      `« ${interdit} » dans le bloc catch : le rollback de la transaction fait ` +
        "déjà ce travail, et le refaire à la main crédite deux fois."
    );
  }
});

/* -------------------------------------------------------------------------- */
/* L'état impossible reste bruyant                                            */
/* -------------------------------------------------------------------------- */

test("un état impossible est signalé, jamais rattrapé", () => {
  assert.match(
    CODE,
    /MONEY_MOVED_WITHOUT_TRANSACTION/,
    "si de l'argent a bougé hors transaction, il faut le dire fort : " +
      "un marqueur stable permet d'y accrocher une alerte"
  );

  // Et il doit rester un simple signalement : aucune écriture dans cette branche.
  const m = CODE.match(/MONEY_MOVED_WITHOUT_TRANSACTION[\s\S]{0,800}/);
  assert.ok(m);
  assert.ok(
    !/TxWalletBalance\.(credit|debit)\(/.test(m[0]),
    "signaler, pas rattraper"
  );
});

/* -------------------------------------------------------------------------- */
/* Ce qui doit continuer d'exister                                            */
/* -------------------------------------------------------------------------- */

test("le grand livre est toujours écrit sur le chemin nominal", () => {
  assert.match(
    CODE,
    /postInternalPaymentEntries\(/,
    "le mouvement de solde doit rester accompagné de son écriture au grand livre"
  );
});

test("le mode log-only n'est pas bloqué : il ne déplace rien", () => {
  const posLogOnly = CODE.indexOf('outcome: "log-only"');
  const posRefus = POS_REFUS;

  assert.ok(posLogOnly > -1, "le mode log-only doit rester");
  assert.ok(posRefus > -1, "refus introuvable");
  assert.ok(
    posLogOnly < posRefus,
    "log-only rend son résultat AVANT le refus : refuser une opération qui ne " +
      "bouge aucun argent serait une régression gratuite"
  );
});
