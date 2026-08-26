"use strict";

/**
 * ============================================================================
 * DÉMARRAGE SÛR DU MAGASIN REDIS — CORRIGE UN CRASH AU DÉPLOIEMENT
 * ============================================================================
 *
 * ⚠️ FICHIER RÉPLIQUÉ À L'IDENTIQUE DANS LES TROIS SERVICES
 * (`paynoval-backend`, `api-gateway`, `api-paynoval`). Dépôts séparés, pas de
 * paquet commun : toute correction ici doit être reportée dans les deux autres.
 *
 * LE DÉFAUT, OBSERVÉ EN PRODUCTION LE 2026-08-26
 * ----------------------------------------------
 * Au déploiement, les trois services ont produit la même erreur en rafale :
 *
 *     Error: Stream isn't writeable and enableOfflineQueue options is false
 *         at new RedisStore (rate-limit-redis/dist/index.cjs:95)
 *
 * Sur la passerelle, elle a **tué le processus**.
 *
 * L'enchaînement, vérifié dans le code des deux bibliothèques :
 *
 *   1. `new Redis(url)` se connecte de façon ASYNCHRONE — la socket n'est pas
 *      encore ouverte quand la ligne suivante s'exécute ;
 *   2. les magasins sont construits AU CHARGEMENT DES MODULES (`require` d'un
 *      fichier de routes, ou du serveur lui-même) ;
 *   3. le constructeur de `RedisStore` envoie immédiatement deux `SCRIPT LOAD`
 *      pour compiler ses scripts Lua ;
 *   4. `enableOfflineQueue: false` fait REJETER ces commandes au lieu de les
 *      mettre en attente — la socket n'est pas encore écrivable ;
 *   5. `rate-limit-redis` STOCKE ces promesses sans jamais les attendre :
 *
 *          this.incrementScriptSha = this.loadIncrementScript();
 *
 *      Un rejet non géré fait donc tomber le processus sous Node 15+, sauf si
 *      le service a déclaré un gestionnaire `unhandledRejection` — ce que la
 *      passerelle ne faisait pas au moment du `require`.
 *
 * ⚠️ `enableOfflineQueue: false` N'ÉTAIT PAS UNE ERREUR — il l'est seulement AU
 * DÉMARRAGE. Le réglage existe pour une raison juste : pendant une COUPURE, la
 * file d'attente ferait patienter chaque requête HTTP jusqu'au délai de
 * connexion, au lieu d'échouer vite et de laisser le repli s'appliquer. Le
 * supprimer purement et simplement remplacerait un crash au démarrage par des
 * requêtes suspendues en incident — un échange perdant.
 *
 * LA CORRECTION : LE RÉGLAGE DEVIENT CONDITIONNEL AU MOMENT
 * --------------------------------------------------------
 *   • pendant la connexion initiale, la file est OUVERTE — les deux
 *     `SCRIPT LOAD` attendent la socket au lieu d'échouer ;
 *   • dès la première connexion établie, elle se FERME — le comportement voulu
 *     en régime permanent est rétabli, et une coupure ultérieure échoue vite.
 *
 * ioredis relit `options.enableOfflineQueue` à CHAQUE commande (vérifié dans
 * `Redis.js`, `sendCommand`) : la bascule à chaud est donc effective, ce n'est
 * pas un contournement.
 *
 * ET UNE CEINTURE : LES PROMESSES DE SCRIPT SONT NEUTRALISÉES
 * ----------------------------------------------------------
 * Si Redis est réellement injoignable au démarrage — mauvaise URL, service
 * éteint — les deux `SCRIPT LOAD` rejetteront quand même, quelle que soit la
 * file d'attente. On marque donc ces promesses comme gérées.
 *
 * ⚠️ `p.catch(() => {})` NE LES RÉSOUT PAS : il crée une promesse dérivée qui,
 * elle, se résout. La promesse d'origine reste rejetée, et le `await` que fait
 * `increment()` lèvera toujours — donc le repli mémoire s'applique comme prévu.
 * On supprime le crash, pas le signal.
 */

/**
 * Ouvre la file d'attente hors ligne le temps de la connexion initiale, puis la
 * ferme.
 *
 * @param {object} client   Client ioredis.
 * @param {object} [options]
 * @param {object} [options.logger]
 * @param {string} [options.label] Nom du service, pour le journal.
 */
function closeOfflineQueueWhenReady(client, { logger = null, label = "rate-limit" } = {}) {
  if (!client || typeof client.once !== "function") return client;

  client.once("ready", () => {
    try {
      if (client.options) client.options.enableOfflineQueue = false;

      logger?.info?.(
        `[${label}] Redis connecté — file d'attente hors ligne fermée : ` +
          "une coupure échouera vite au lieu de suspendre les requêtes."
      );
    } catch {
      // Une version d'ioredis qui n'exposerait plus `options` ne doit pas
      // faire échouer le démarrage pour autant.
    }
  });

  return client;
}

/**
 * Empêche les promesses de chargement de script de faire tomber le processus.
 *
 * Elles restent rejetées — c'est ce qui déclenche le repli mémoire au premier
 * appel. Elles ne sont simplement plus « non gérées ».
 *
 * @param {object} store  Instance de `RedisStore` (rate-limit-redis).
 */
function neutralizeScriptLoadRejections(store, { logger = null, label = "rate-limit" } = {}) {
  if (!store) return store;

  for (const champ of ["incrementScriptSha", "getScriptSha"]) {
    const promesse = store[champ];

    if (promesse && typeof promesse.catch === "function") {
      promesse.catch((err) => {
        logger?.debug?.(
          `[${label}] chargement du script Redis « ${champ} » en échec ` +
            `(${err?.message || err}) — repli mémoire au premier appel.`
        );
      });
    }
  }

  return store;
}

/**
 * Les deux protections en un appel, pour que l'une ne soit pas posée sans
 * l'autre.
 */
function makeStoreStartupSafe(store, client, options = {}) {
  closeOfflineQueueWhenReady(client, options);
  neutralizeScriptLoadRejections(store, options);
  return store;
}

module.exports = {
  closeOfflineQueueWhenReady,
  neutralizeScriptLoadRejections,
  makeStoreStartupSafe,
};
