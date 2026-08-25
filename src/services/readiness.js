"use strict";

/**
 * VIVACITÉ ET DISPONIBILITÉ — DEUX QUESTIONS DIFFÉRENTES
 * =============================================================================
 *
 * ═══ CE QUI MANQUAIT ══════════════════════════════════════════════════════
 *
 * `/healthz` et `/health` répondaient `status: "UP"` **quoi qu'il arrive** :
 * l'état Mongo était calculé, mis dans le corps de la réponse… et jamais
 * utilisé pour décider du code HTTP. Un répartiteur de charge recevait donc 200
 * d'une instance dont la base est déconnectée, et continuait de lui envoyer du
 * trafic. Chaque requête échouait ensuite en 500.
 *
 * Tant qu'il n'y avait qu'une instance, cela ne changeait rien — il n'y avait
 * nulle part où rediriger. Maintenant qu'on peut en ajouter, c'est le premier
 * mécanisme qui manque.
 *
 * ═══ POURQUOI DEUX SONDES, ET PAS UNE ════════════════════════════════════
 *
 * C'est la distinction que font Kubernetes, Render et tous les répartiteurs
 * sérieux, et la confondre cause des dégâts dans les deux sens.
 *
 *   • VIVACITÉ (`/healthz`) — « ce processus est-il vivant ? »
 *     Elle ne doit dépendre d'AUCUNE dépendance externe. Si `/healthz`
 *     retournait 503 parce que Mongo est tombé, l'orchestrateur tuerait et
 *     redémarrerait l'instance — ce qui ne répare pas Mongo, et provoque une
 *     tempête de redémarrages pendant l'incident, au pire moment.
 *     Elle répond donc 200 tant que la boucle d'événements répond.
 *
 *   • DISPONIBILITÉ (`/readyz`) — « dois-je recevoir du trafic ? »
 *     Elle dépend, elle, des dépendances critiques. 503 retire l'instance de la
 *     rotation **sans la tuer** : elle reste en vie, se reconnecte, et revient
 *     d'elle-même.
 *
 * ═══ LE VIDAGE, QUI EST LE VRAI GAIN ═════════════════════════════════════
 *
 * À l'arrêt (SIGTERM), la disponibilité bascule à faux AVANT que le serveur ne
 * ferme. Le répartiteur cesse d'envoyer du trafic, les requêtes en cours se
 * terminent, puis on ferme. Sans cela, un redéploiement coupe des requêtes en
 * vol — sur un service de paiement, ce sont des transactions interrompues à
 * chaque mise en production.
 *
 * ═══ CE QUI COMPTE COMME CRITIQUE ════════════════════════════════════════
 *
 * Les deux connexions Mongo, et elles seules. Redis n'y figure PAS
 * délibérément : la plateforme fonctionne sans lui (limitation de débit en
 * mémoire, Socket.IO local). Le déclarer critique retirerait toutes les
 * instances de la rotation pendant une panne du cache — exactement
 * l'amplification qu'on évite partout ailleurs dans ce dossier.
 *
 * Module **pur** : `evaluateReadiness` ne lit ni `process`, ni l'horloge, ni
 * une connexion. Tout lui est fourni, donc tout se teste.
 */

/** États d'une connexion Mongoose, dans l'ordre des `readyState`. */
const CONNECTED = "connected";

const STATUS = Object.freeze({
  READY: "ready",
  STARTING: "starting",
  DRAINING: "draining",
  DEGRADED: "degraded",
});

/**
 * Décide si l'instance doit recevoir du trafic.
 *
 * @param {object}  input
 * @param {object}  input.connections   ex. `{ main: "connected", tx: "connecting" }`
 * @param {string[]} [input.required]   connexions dont dépend la disponibilité
 * @param {boolean} [input.draining]    arrêt en cours
 * @param {boolean} [input.started]     bootstrap terminé
 * @returns {{ ready: boolean, status: string, httpStatus: number,
 *             checks: object, failing: string[] }}
 */
function evaluateReadiness({
  connections = {},
  required = ["main", "tx"],
  draining = false,
  started = true,
} = {}) {
  const checks = {};
  const failing = [];

  for (const name of required) {
    const state = connections[name] || "unknown";
    const ok = state === CONNECTED;

    checks[name] = { state, ok };
    if (!ok) failing.push(name);
  }

  /**
   * L'ordre des tests compte. Le vidage l'emporte sur tout : pendant un arrêt,
   * l'instance peut très bien avoir toutes ses connexions — elle ne doit
   * pourtant plus recevoir la moindre requête.
   */
  if (draining) {
    return { ready: false, status: STATUS.DRAINING, httpStatus: 503, checks, failing };
  }

  if (!started) {
    return { ready: false, status: STATUS.STARTING, httpStatus: 503, checks, failing };
  }

  if (failing.length) {
    return { ready: false, status: STATUS.DEGRADED, httpStatus: 503, checks, failing };
  }

  return { ready: true, status: STATUS.READY, httpStatus: 200, checks, failing };
}

/**
 * Enveloppe la fonction pure d'un état de cycle de vie.
 *
 * `readConnections` est injecté : les tests n'ont pas besoin de Mongo, et
 * `server.js` reste le seul endroit qui sait comment lire l'état réel.
 */
function createReadiness({ readConnections, required, logger = null } = {}) {
  if (typeof readConnections !== "function") {
    throw new Error("readiness : `readConnections` doit être une fonction");
  }

  let started = false;
  let draining = false;

  return {
    STATUS,

    markStarted() {
      started = true;
    },

    /**
     * Bascule la disponibilité à faux. À appeler AVANT `server.close()` :
     * c'est ce délai qui laisse le répartiteur retirer l'instance pendant que
     * les requêtes en cours se terminent.
     */
    beginDraining() {
      if (draining) return;
      draining = true;
      logger?.info?.("[readiness] vidage engagé — l'instance ne prend plus de trafic");
    },

    snapshot() {
      let connections = {};

      try {
        connections = readConnections() || {};
      } catch (err) {
        /**
         * Lire l'état ne doit jamais lever : une sonde qui plante est pire
         * qu'une sonde qui dit « pas prêt ».
         */
        logger?.warn?.(`[readiness] lecture d'état impossible : ${err?.message || err}`);
      }

      return evaluateReadiness({ connections, required, draining, started });
    },

    isDraining: () => draining,
  };
}

module.exports = { evaluateReadiness, createReadiness, STATUS, CONNECTED };
