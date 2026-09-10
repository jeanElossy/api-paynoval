"use strict";

/**
 * ============================================================================
 * ACCÈS AU CLIENT REDIS DU PROCESSUS
 * ============================================================================
 *
 * ── Ce que ce module résout ─────────────────────────────────────────────────
 *
 * Tx-Core construit son client Redis dans `server.js`, pour la limitation de
 * débit. Aucun accesseur partagé n'existait : un module qui voulait ce client
 * n'avait d'autre choix que d'en ouvrir un second.
 *
 * C'est devenu bloquant en accueillant le domaine de la tarification
 * (2026-09-10) : `services/pricing/fxRulesService` cache le RÉFÉRENTIEL des
 * règles de change et attendait un `getClient()` — celui de la passerelle, qui
 * n'a pas d'équivalent ici.
 *
 * ── Pourquoi un registre plutôt qu'une seconde connexion ────────────────────
 *
 * Invariant A8 : **aucune requête HTTP ne crée de connexion Redis.** Un client
 * réutilisable par processus, pas un par module. Ouvrir un second client
 * doublerait les sockets, les reconnexions et les métriques, pour la même base.
 *
 * ── Pourquoi `null` est une réponse valide ──────────────────────────────────
 *
 * Redis absent est un mode de fonctionnement documenté, pas une panne : c'est
 * le mode « une seule instance ». `cacheService` le prévoit explicitement —
 * sans client, le cache est INERTE et chaque appel relit la base, exactement
 * comme avant qu'il existe.
 *
 * Ce module ne construit donc JAMAIS de client et ne lève jamais : il rend ce
 * que le démarrage a posé, ou `null`.
 */

let _client = null;

/**
 * Enregistre le client du processus. Appelé une fois, par `server.js`.
 *
 * ⚠️ Ne fabrique rien : si le démarrage n'a pas ouvert de client, il n'y en a
 * pas, et c'est une information — pas un problème à contourner.
 */
function setClient(client) {
  _client = client || null;
  return _client;
}

/** Le client du processus, ou `null` si Redis n'est pas configuré. */
function getClient() {
  return _client;
}

/** Réservé aux tests et à l'arrêt propre. */
function __reset() {
  _client = null;
}

module.exports = { setClient, getClient, __reset };
