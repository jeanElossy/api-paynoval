"use strict";

/**
 * Exécution d'une unité de travail dans une transaction — logique PURE.
 *
 * POURQUOI CETTE FONCTION EXISTE PLUTÔT QU'UN APPEL DIRECT
 * -------------------------------------------------------
 * `session.withTransaction()` fait déjà tout le travail utile : il rejoue le
 * corps sur `TransientTransactionError` (conflit d'écriture) et rejoue le commit
 * sur `UnknownTransactionCommitResult`, dans une fenêtre de 120 s. On ne
 * réimplémente rien de cela.
 *
 * Le seul ajout est un contournement, et il est nécessaire : **le pilote
 * mongodb 5.x — celui qu'embarque Mongoose 7 — ne propage PAS la valeur
 * retournée par le corps.** Il renvoie le résultat du commit. Ce n'est qu'à
 * partir du pilote 6 que la valeur du corps est propagée.
 *
 * Vérifié, pas supposé : un `withTransaction(async () => 'x')` renvoie
 * `undefined` sur cette version. Un appelant qui fait
 * `const r = await session.withTransaction(...)` obtient donc silencieusement
 * `undefined` — et répond « succès » avec un corps vide.
 *
 * La valeur est donc capturée dans une fermeture. Le contournement reste
 * correct sur le pilote 6 : en cas de rejeu, `result` est réécrit par la
 * dernière exécution, la seule qui ait été validée.
 */
async function runWithTransaction(session, fn) {
  if (!session || typeof session.withTransaction !== "function") {
    // Aucune transaction possible : on exécute tel quel (mode dégradé).
    return fn(session);
  }

  let result;

  await session.withTransaction(async () => {
    result = await fn(session);
  });

  return result;
}

/**
 * Cette erreur relève-t-elle de la transaction elle-même, plutôt que de la
 * logique métier ?
 *
 * À QUOI ÇA SERT
 * --------------
 * Un `try/catch` posé autour d'une étape secondaire à l'intérieur d'une
 * transaction — pour ne pas faire échouer un virement légitime à cause d'un
 * accessoire — devient un piège dès lors que le corps est rejouable : il avale
 * aussi le conflit d'écriture que le pilote attend pour déclencher le rejeu. La
 * transaction est alors validée alors que l'étape avalée n'a jamais eu lieu.
 *
 * Le pilote étiquette ces erreurs (`errorLabels`) précisément pour qu'on
 * puisse les distinguer. On s'appuie sur l'étiquette, jamais sur le texte du
 * message : le texte change d'une version de serveur à l'autre, pas
 * l'étiquette.
 *
 * `WriteConflict` (code 112) est ajouté par sécurité : il porte normalement
 * l'étiquette `TransientTransactionError`, mais pas dans toutes les
 * configurations.
 */
const TRANSACTION_ERROR_LABELS = [
  "TransientTransactionError",
  "UnknownTransactionCommitResult",
];

function isTransactionLevelError(err) {
  if (!err) return false;

  if (typeof err.hasErrorLabel === "function") {
    for (const label of TRANSACTION_ERROR_LABELS) {
      if (err.hasErrorLabel(label)) return true;
    }
  }

  const labels = Array.isArray(err.errorLabels) ? err.errorLabels : [];

  if (labels.some((l) => TRANSACTION_ERROR_LABELS.includes(l))) return true;

  return err.code === 112 || err.codeName === "WriteConflict";
}

module.exports = { runWithTransaction, isTransactionLevelError, TRANSACTION_ERROR_LABELS };
