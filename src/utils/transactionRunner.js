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

module.exports = { runWithTransaction };
