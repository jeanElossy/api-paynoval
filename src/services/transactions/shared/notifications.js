"use strict";

/**
 * NOTIFICATION DES PARTIES D'UN RÈGLEMENT EXTERNE — SIMPLE DÉLÉGATION
 * =============================================================================
 *
 * ⚠️ CE FICHIER NE CONTIENT PLUS NI MODÈLE, NI CONSTRUCTION DE MESSAGE, NI
 *    LECTURE DE PRÉFÉRENCE. Tout cela a été supprimé le 2026-09-23 avec
 *    l'écriture directe qu'il portait (voir le bloc devant `notifyParties`).
 *
 * Ce qui a disparu, et pourquoi le laisser aurait été dangereux :
 *
 *   · `runtime.lazyModels(["User","Notification","NotificationOutbox"])` — les
 *     modèles des collections DU BACKEND, résolus ici. Les garder sous la main
 *     rendait la réécriture directe à portée d'une ligne ;
 *
 *   · `buildOutboxIdempotencyKey`, `buildSenderCurrency`, `buildReceiverCurrency`,
 *     `buildSenderAmount`, `buildReceiverAmount`, `buildTxDateIso`,
 *     `getEmailPreference` — SEPT fonctions qui dupliquaient, à la virgule près,
 *     celles de `transactionNotificationService`. Deux lectures parallèles des
 *     mêmes champs d'argent, libres de diverger sans lever d'erreur : le motif
 *     de défaut le plus coûteux de ce projet. La construction de la clé y était
 *     déjà signalée comme « même construction que
 *     `transactionNotificationService` » — un commentaire qui décrit une
 *     duplication ne la corrige pas ;
 *
 *   · `getEmailPreference` lisait `notificationPreferences.email` et
 *     `wantsEmail`, **deux champs absents de tout schéma** : elle rendait donc
 *     toujours `true`. Elle n'était même pas appelée — le tableau `channels`
 *     n'était jamais construit. Aucun e-mail n'a jamais été envoyé par ce
 *     chemin.
 */

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * ⚠️ `notifyParties` NE CONSTRUIT PLUS RIEN — ELLE DÉLÈGUE. 2026-09-23
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ── Ce qu'elle faisait, et pourquoi c'était grave ───────────────────────────
 *
 * Elle écrivait DIRECTEMENT dans deux collections du backend principal :
 * `notifications` (la boîte de réception de l'application) et `outboxes` (la
 * file de livraison), avec **le schéma de Tx-Core**. C'est le dernier écrivain
 * direct qui subsistait : `transactionNotificationService` avait été converti au
 * bus le 2026-09-10, celui-ci avait été oublié. Le chemin concerné est celui des
 * **règlements externes — mobile money et carte** (`externalSettlementController`,
 * trois appels : deux `confirmed`, un `failed`).
 *
 * Quatre défauts mesurés, tous invisibles dans les journaux :
 *
 * 1. **NOTIFICATION IN-APP VIDE.** Le document créé ne portait ni `title` ni
 *    `message` — seulement `type` et `data`. Le schéma de Tx-Core les déclare
 *    optionnels avec `default: ""`, celui du backend les déclare **requis**.
 *    Deux schémas pour une collection : l'écriture passait, et l'utilisateur
 *    voyait une carte vide dans sa liste après avoir reçu de l'argent.
 *
 * 2. **PUSH ANONYME.** L'item d'outbox ne portait pas de `title`/`message` non
 *    plus. Le worker retombe sur ses valeurs par défaut : l'utilisateur recevait
 *    « PayNoval — Nouvelle notification » pour une confirmation d'encaissement.
 *
 * 3. **AUCUN E-MAIL.** Le champ `channels` était absent, et
 *    `outboxPolicy.normalizeChannels()` retombe sur `['push']`. Aucun e-mail
 *    n'est jamais parti pour un règlement mobile money ou carte.
 *
 * 4. **AUCUNE PRÉFÉRENCE, AUCUN GABARIT, AUCUN JOURNAL** — l'écriture directe
 *    contourne par construction `dispatchNotification`.
 *
 * ── Ce qui la remplace ─────────────────────────────────────────────────────
 *
 * Exactement le chemin des transferts internes : `notifyTransactionEvent`,
 * qui publie `notification.requested.v1` DANS la transaction, avec le type du
 * catalogue, le titre, le message, les variables et les métadonnées. Un seul
 * chemin de notification pour tous les règlements, interne ou externe.
 *
 * ⚠️ `scope: "settlement"` PRÉSERVE LA DÉDUPLICATION HISTORIQUE.
 * Les clés d'idempotence écrites par l'ancienne version dérivaient de
 * `settlement:${txId}:${userId}:${status}`. Le paramètre `scope` fait produire
 * le même préfixe : un rappel prestataire rejoué — ce que fait `settlementReplay`
 * — reste dédoublonné comme avant. Sans lui, une confirmation d'encaissement
 * déjà envoyée serait repartie une seconde fois au premier rejeu.
 *
 * ⚠️ NE PAS REMETTRE D'ÉCRITURE DIRECTE ICI. `runtime.Outbox` lève déjà une
 * erreur explicite pour empêcher de retomber dans la confusion des deux bases ;
 * ce commentaire est la garde contre la variante suivante — écrire dans la bonne
 * base, mais sans passer par le moteur.
 */
async function notifyParties(tx, status, session, senderCurrencySymbol) {
  const { notifyTransactionEvent } = require("../transactionNotificationService");

  return notifyTransactionEvent(tx, status, session, senderCurrencySymbol, {
    scope: "settlement",
  });
}

module.exports = {
  notifyParties,
};