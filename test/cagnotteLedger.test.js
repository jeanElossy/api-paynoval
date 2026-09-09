"use strict";

/**
 * ============================================================================
 * AUCUN RÈGLEMENT DE CAGNOTTE NE DÉPLACE D'ARGENT SANS ÉCRITURE COMPTABLE
 * ============================================================================
 *
 * ── Ce que ce test empêche de revenir ────────────────────────────────────────
 * TX Core exposait TROIS points de terminaison de règlement de cagnotte, tous
 * montés, tous annoncés au démarrage, tous déplaçant réellement de l'argent —
 * et aucun n'écrivait une seule `LedgerEntry` :
 *
 *   POST /api/v1/cagnotte/participation/settle      débit payeur + frais
 *   POST /api/v1/cagnotte/vault-withdrawals/settle  crédit bénéficiaire
 *   POST /api/v1/cagnotte/closure-fees/settle       frais de clôture
 *
 * Chacun écrivait un document de règlement en `status: "confirmed"` : une trace,
 * mais une trace qui n'entre dans aucune balance de vérification et qu'aucune
 * réconciliation portefeuille ↔ grand livre ne peut rapprocher. Les invariants
 * 2 (le grand livre fait foi) et 4 (toute écriture financière est auditable)
 * tombaient ensemble.
 *
 * ── Pourquoi le défaut a survécu au correctif du chemin voisin ──────────────
 * `internalPaymentsController.js` avait exactement le même défaut, corrigé le
 * 2026-09-03, et verrouillé par `noLedgerlessMoneyPath.test.js`. Ce garde-fou
 * cherchait `TxWalletBalance.debit|credit(`. Les contrôleurs de cagnotte, eux,
 * écrivent par `findOneAndUpdate({ $inc })` et `TxSystemBalance.credit()` : la
 * même faute, sous une autre forme, passait à travers le filet. Le filet a été
 * élargi le même jour que ce fichier.
 *
 * ── Pourquoi un test de CÂBLAGE ─────────────────────────────────────────────
 * `ledgerServiceDoubleEntry.test.js` prouve que les primitives produisent des
 * lots équilibrés. Il ne prouve pas qu'elles sont APPELÉES. C'est la leçon de
 * `mongodb_pool_max_size`, qui affichait 0 pendant que ses tests unitaires
 * passaient : ils validaient un réducteur correct, le câblage perdait tout.
 *
 * ── Comment il tombe ────────────────────────────────────────────────────────
 * Retirer l'appel à une primitive de cagnotte, le sortir de
 * `runWithTransaction`, ou retirer le refus en fermeture du mode dégradé.
 *
 * Test **pur** : aucune connexion, aucun serveur, lecture de fichiers.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

/**
 * Retire commentaires de bloc et de ligne. Indispensable : ces fichiers
 * DOCUMENTENT le défaut corrigé, et le nomment. Chercher dans le texte brut
 * ferait passer les tests sur la seule présence de la documentation.
 */
function sansCommentaires(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function code(fichier) {
  return sansCommentaires(
    fs.readFileSync(path.join(SRC, "controllers", fichier), "utf8")
  );
}

const CHEMINS = [
  {
    fichier: "cagnotteSettlementController.js",
    primitive: "postCagnotteParticipationEntries",
    mouvement: "débite le portefeuille du payeur et crédite la trésorerie cagnotte",
  },
  {
    fichier: "cagnotteVaultWithdrawalSettlementController.js",
    primitive: "postCagnotteVaultWithdrawalEntries",
    mouvement: "crédite le portefeuille du bénéficiaire",
  },
  {
    fichier: "cagnotteClosureFeesSettlementController.js",
    primitive: "postCagnotteClosureFeeEntries",
    mouvement: "crédite la trésorerie cagnotte",
  },
];

/* -------------------------------------------------------------------------- */
/* 1. Chacun des trois écrit au grand livre                                   */
/* -------------------------------------------------------------------------- */

for (const { fichier, primitive, mouvement } of CHEMINS) {
  test(`${fichier} écrit au grand livre`, () => {
    const s = code(fichier);

    assert.match(
      s,
      new RegExp(`${primitive}\\s*\\(`),
      `${fichier} ne pose plus d'écriture comptable. Il ${mouvement} : de ` +
        "l'argent bougerait sans contrepartie au grand livre (invariants 2 et 4)."
    );
  });

  /**
   * ⚠️ L'APPARTENANCE À LA TRANSACTION EST LA MOITIÉ DE LA GARANTIE.
   *
   * Poser l'écriture hors de `runWithTransaction` laisserait exactement
   * l'incohérence que ce correctif ferme : un échec entre le mouvement de
   * portefeuille et l'écriture, et le solde aurait bougé sans trace.
   */
  test(`${fichier} pose l'écriture DANS la transaction, avec la session`, () => {
    const s = code(fichier);

    const debutTx = s.indexOf("runWithTransaction(session");
    assert.notEqual(debutTx, -1, `${fichier} : runWithTransaction introuvable`);

    const pose = s.indexOf(`${primitive}({`, debutTx);
    assert.notEqual(
      pose,
      -1,
      `${fichier} : l'écriture comptable est posée HORS de runWithTransaction — ` +
        "un échec entre le mouvement de portefeuille et l'écriture laisserait " +
        "le solde déplacé sans trace."
    );

    const finAppel = s.indexOf("});", pose);
    assert.notEqual(finAppel, -1, `${fichier} : appel non terminé ?`);

    assert.match(
      s.slice(pose, finAppel),
      /\bsession,/,
      `${fichier} : l'écriture ne reçoit pas la session — elle partirait hors ` +
        "de la transaction même en étant écrite à l'intérieur du bloc."
    );
  });
}

/* -------------------------------------------------------------------------- */
/* 2. Le mode dégradé est REFUSÉ, pas subi                                    */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ POURQUOI CE REFUS N'EST PAS DE LA PRUDENCE EXCESSIVE.
 *
 * `postDoubleEntry` ne transmet la session au grand livre que si
 * `canUseSharedSession()` est vrai (`maybeSessionOpts`). Sans elle, les
 * écritures comptables partent HORS de la transaction qui porte le mouvement de
 * portefeuille : une annulation laisse des écritures FANTÔMES en face d'un solde
 * remis en état.
 *
 * Un grand livre faux est pire qu'un grand livre absent — on lui fait confiance.
 * D'où le refus AVANT tout mouvement (règle B.2).
 */
for (const { fichier } of CHEMINS) {
  test(`${fichier} refuse en fermeture sans session atomique`, () => {
    const s = code(fichier);

    assert.match(
      s,
      /canUseSharedSession\(\s*getUsersConn\s*,\s*getTxConn\s*\)/,
      `${fichier} ne vérifie plus la disponibilité d'une transaction réelle.`
    );

    assert.match(
      s,
      /ATOMIC_SESSION_UNAVAILABLE/,
      `${fichier} : le refus doit porter un code explicite, sinon l'appelant ` +
        "ne peut pas le distinguer d'une panne quelconque."
    );

    assert.match(
      s,
      /status\(503\)/,
      `${fichier} : un service qui ne peut pas tenir ses garanties répond 503, ` +
        "il ne déplace pas l'argent quand même."
    );

    /**
     * Le refus doit précéder TOUT mouvement. Placé après, il ne refuserait
     * rien : l'argent aurait déjà bougé.
     */
    const refus = s.indexOf("ATOMIC_SESSION_UNAVAILABLE");
    const transaction = s.indexOf("runWithTransaction(session");

    assert.ok(
      refus < transaction,
      `${fichier} : le refus doit être évalué AVANT d'ouvrir la transaction.`
    );
  });
}

/* -------------------------------------------------------------------------- */
/* 3. L'identifiant de règlement est déterministe                             */
/* -------------------------------------------------------------------------- */

/**
 * `dedupKey` vaut `transactionId|scope|legIndex`, et `transactionId` est
 * l'identifiant du document de règlement. Tiré au hasard à chaque tentative, un
 * rejeu produirait une clé neuve : l'index unique partiel du grand livre ne
 * verrait pas le doublon. Dérivé de la référence, il est stable.
 */
for (const { fichier } of CHEMINS) {
  test(`${fichier} dérive l'identifiant de règlement de la référence`, () => {
    const s = code(fichier);

    assert.match(
      s,
      /settlementObjectIdFromReference\(/,
      `${fichier} : identifiant de règlement non dérivé — le grand livre ne ` +
        "serait plus idempotent hors transaction MongoDB."
    );

    assert.match(
      s,
      /_id:\s*settlementId,/,
      `${fichier} : l'identifiant dérivé n'est pas posé sur le document de ` +
        "règlement — il ne sert alors à rien."
    );
  });
}
