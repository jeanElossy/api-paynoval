"use strict";

/**
 * Validation d'une transaction MongoDB avec rejeu — logique PURE.
 *
 * POURQUOI CE MODULE EXISTE À PART
 * --------------------------------
 * `runtime.js` est l'endroit naturel, mais il appelle `getTxConn()` au
 * chargement : l'importer depuis un contrôleur casse l'ordre de démarrage.
 * Sans dépendance, ce module est importable de partout — et testable sans base
 * ni configuration.
 *
 * CE QUE FAIT LE REJEU, ET POURQUOI
 * ---------------------------------
 * `UnknownTransactionCommitResult` ne signifie pas « échec ». Il signifie que la
 * RÉPONSE s'est perdue : bascule de primaire, coupure réseau. La transaction est
 * peut-être passée. Abandonner sur ce signal, c'est risquer de déclarer perdue
 * une opération réussie — et, si l'appelant réessaie, de la faire deux fois.
 *
 * Le pilote MongoDB prévoit une seule conduite juste, celle que
 * `session.withTransaction()` applique en interne : REJOUER le commit, qui est
 * idempotent côté serveur, dans une fenêtre de 120 secondes. On reprend sa règle
 * plutôt que d'en inventer une.
 */

/** Fenêtre de rejeu du pilote MongoDB pour `withTransaction()`. */
const COMMIT_RETRY_BUDGET_MS = 120_000;

function isUnknownCommitResult(err) {
  if (typeof err?.hasErrorLabel === "function") {
    return err.hasErrorLabel("UnknownTransactionCommitResult");
  }

  // Les pilotes anciens exposent la liste brute plutôt que la méthode.
  return Array.isArray(err?.errorLabels)
    ? err.errorLabels.includes("UnknownTransactionCommitResult")
    : false;
}

async function commitWithRetry(session, { budgetMs = COMMIT_RETRY_BUDGET_MS, onRetry } = {}) {
  if (!session || typeof session.commitTransaction !== "function") return;

  const deadline = Date.now() + budgetMs;

  for (;;) {
    try {
      await session.commitTransaction();
      return;
    } catch (err) {
      // Hors du budget, l'incertitude est remontée telle quelle : c'est à la
      // réconciliation de trancher, pas à une boucle d'attente sans fin.
      if (!isUnknownCommitResult(err) || Date.now() >= deadline) throw err;

      onRetry?.(err);
    }
  }
}

module.exports = {
  commitWithRetry,
  isUnknownCommitResult,
  COMMIT_RETRY_BUDGET_MS,
};
