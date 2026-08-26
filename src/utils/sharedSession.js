"use strict";

/**
 * ============================================================================
 * « Y A-T-IL UNE VRAIE TRANSACTION ? » — UNE SEULE RÉPONSE POUR TOUT LE SERVICE
 * ============================================================================
 *
 * Ce module existe parce que la réponse était donnée à DEUX endroits, avec deux
 * définitions différentes :
 *
 *   runtime.js        →  canUseSharedSession() && session ? { session } : {}
 *   ledgerService.js  →                          session ? { session } : {}
 *
 * En mode dégradé (les deux bases sur des clients Mongo distincts),
 * `startTxSession()` rend quand même un objet session — il est simplement
 * inutile, puisque `runInTransaction` n'ouvre aucune transaction. La session est
 * donc TRUTHY sans qu'aucune transaction n'existe.
 *
 * La version de `ledgerService` prenait cette session pour la preuve d'une
 * transaction. Deux conséquences mesurées :
 *
 *   1. les écritures du grand livre partaient avec une session, pendant que la
 *      sauvegarde de la transaction elle-même n'en portait pas — deux régimes
 *      pour un même mouvement ;
 *   2. le rattrapage idempotent de `postDoubleEntry`, conçu POUR le mode
 *      dégradé, s'y désactivait — il testait `session` et concluait « une
 *      transaction annulera tout », ce qui était faux.
 *
 * Le prédicat vit désormais ici, en un seul exemplaire. `sameMongoClient` est
 * PUR — deux connexions en entrée, un booléen en sortie — donc testable sans
 * base ni serveur, ce qui est la contrainte des suites de ce dépôt.
 *
 * ⚠️ Ne pas importer `runtime.js` depuis `ledgerService` : `runtime` importe
 * déjà `ledgerService` (dépendance circulaire). C'est aussi pourquoi ce module
 * ne dépend de rien.
 */

/**
 * Deux connexions Mongoose partagent-elles le même `MongoClient` ?
 *
 * C'est la condition NÉCESSAIRE à une transaction couvrant les deux bases : une
 * session appartient à un client, et une transaction ne franchit pas la
 * frontière entre deux clients.
 */
function sameMongoClient(connA, connB) {
  try {
    const a = connA?.getClient?.();
    const b = connB?.getClient?.();

    return !!a && !!b && a === b;
  } catch {
    return false;
  }
}

/**
 * @param {Function} getUsersConn accesseur, appelé au moment de la question
 * @param {Function} getTxConn    idem
 *
 * Des ACCESSEURS et non des connexions : elles n'existent qu'après
 * `connectTransactionsDB()`, et les résoudre au chargement ferait échouer
 * l'import du module appelant.
 */
function canUseSharedSession(getUsersConn, getTxConn) {
  try {
    return sameMongoClient(getUsersConn?.(), getTxConn?.());
  } catch {
    return false;
  }
}

/**
 * La question que le code appelant se pose RÉELLEMENT : « cette session
 * couvre-t-elle une transaction qui annulera mes écritures en cas d'échec ? »
 *
 * Une session seule ne suffit pas à répondre oui.
 */
function hasRealTransaction(session, getUsersConn, getTxConn) {
  return Boolean(session) && canUseSharedSession(getUsersConn, getTxConn);
}

module.exports = {
  sameMongoClient,
  canUseSharedSession,
  hasRealTransaction,
};
