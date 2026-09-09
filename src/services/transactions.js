// src/services/transactions.js
"use strict";

/**
 * PRIMITIVES D'ARGENT RETIRÉES — elles écrivaient hors du grand livre
 * ============================================================================
 *
 * Ce module exposait `debitUser`, `creditUserByEmail` et `transfer`, qui
 * appelaient `TxWalletBalance.debit` / `.credit` EN DIRECT, sans jamais écrire
 * une seule `LedgerEntry`. `transfer` allait jusqu'à envelopper les deux dans
 * une transaction Mongo — un virement atomique, complet, et invisible du grand
 * livre.
 *
 * L'invariant 2 dit que le grand livre fait foi et que le solde d'un
 * portefeuille est une PROJECTION, jamais la référence. Ces trois fonctions
 * inversaient exactement cela : elles écrivaient la projection sans jamais
 * écrire ce qu'elle est censée projeter. Un solde ainsi modifié n'est
 * réconciliable avec rien, et la balance de vérification
 * (`services/ledger/doubleEntry.js`) ne peut pas le rattraper — elle vérifie
 * que les écritures s'équilibrent, pas qu'un solde a bougé sans écriture.
 *
 * Seul `src/routes/pay.js` les importait, et cette route est retirée depuis le
 * 2026-09-03 (voir son en-tête). Le module ne compte donc plus AUCUN appelant.
 *
 * ── Pourquoi le fichier subsiste ──────────────────────────────────────────
 *
 * Le supprimer effacerait la raison. Ces fonctions étaient exportées : n'importe
 * quel développeur pouvait les importer de bonne foi — les noms sont naturels,
 * la signature est propre, rien n'annonçait qu'elles court-circuitaient le
 * grand livre. Elles échouent désormais en FERMETURE, en nommant le chemin
 * légitime. Un import futur produit une erreur immédiate et explicite, pas un
 * mouvement d'argent silencieux.
 *
 * ── Le chemin légitime ────────────────────────────────────────────────────
 *
 * Tout mouvement de fonds passe par `src/services/ledgerService.js`, appelé
 * depuis les handlers de `src/services/transactions/handlers/` — lesquels
 * écrivent le grand livre et projettent ensuite le solde, dans cet ordre.
 *
 * ⚠️ Ne pas « réparer » ces fonctions. Ce n'était pas un bug : c'était un
 * chemin parallèle. Le rétablir violerait les invariants 2, 3, 4 et 12.
 * `test/noLedgerlessMoneyPath.test.js` échoue si on les rétablit.
 */

/** Erreur unique, explicite, pour tout appel à une primitive retirée. */
function cheminRetire(nomFonction) {
  const err = new Error(
    `${nomFonction}() a été retirée : elle déplaçait des fonds sans écriture ` +
      "au grand livre (invariant 2). Passer par les handlers de " +
      "src/services/transactions/handlers/, qui appellent ledgerService."
  );
  err.status = 500;
  err.code = "LEDGERLESS_MONEY_PATH_REMOVED";
  throw err;
}

const debitUser = () => cheminRetire("debitUser");
const creditUserByEmail = () => cheminRetire("creditUserByEmail");
const transfer = () => cheminRetire("transfer");
const findUserByEmail = () => cheminRetire("findUserByEmail");
const findWalletByUserId = () => cheminRetire("findWalletByUserId");

module.exports = {
  findUserByEmail,
  findWalletByUserId,
  findBalanceByUserId: findWalletByUserId,
  debitUser,
  creditUserByEmail,
  transfer,
};
