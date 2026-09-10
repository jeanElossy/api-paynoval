"use strict";

/**
 * ── Déplacé depuis l'API Gateway le 2026-09-10 ──────────────────────────────
 *
 * Ce module suit `fxRulesService`, son unique consommateur applicatif, parti
 * avec le domaine de la tarification. Le laisser dans la passerelle en aurait
 * fait du code mort tout en gardant, côté Tx-Core, un `require` non résolu —
 * défaut invisible à `node --check`, qui ne suit pas les `require`, et attrapé
 * par un test de CHARGEMENT réel des modules.
 *
 * Le module est injecté (`client` en paramètre) et reste inerte sans client
 * Redis : il ne suppose donc rien de l'hôte qui l'accueille.
 */


/**
 * Cache de référentiel — étage CACHE du §65.
 *
 * ── Trois propriétés, dans cet ordre ──────────────────────────────────────
 *
 * 1. IL NE LÈVE JAMAIS. Un cache est une optimisation ; une optimisation qui
 *    peut faire tomber une requête n'en est pas une. Toute erreur Redis, toute
 *    valeur illisible, toute ressource refusée par la politique retombe sur le
 *    producteur — c'est-à-dire sur la base, qui fait foi.
 *
 * 2. IL S'EFFACE QUAND REDIS VA MAL. Sans disjoncteur, un Redis injoignable
 *    ferait payer un délai d'expiration à CHAQUE requête : le cache rendrait
 *    le service plus lent que s'il n'existait pas. Après quelques échecs, on
 *    cesse d'essayer pendant un temps et on lit directement la base.
 *
 * 3. IL NE DÉCIDE PAS DE CE QU'IL CACHE. C'est `cacheKeys.js` qui tranche, par
 *    allowlist. Un solde, une écriture de grand livre, un état de transaction
 *    ne peuvent pas entrer ici, même par erreur d'appel.
 *
 * ── Ce que ce module n'est pas ────────────────────────────────────────────
 * Ce n'est pas un magasin. Rien ne doit être LU ici sans pouvoir être relu
 * ailleurs. Si une valeur n'existe qu'en cache, c'est un défaut de conception,
 * pas une optimisation — voir §13 et §15.
 */

const { construireCle, motifRessource, politique } = require("./cacheKeys");

const COOLDOWN_MS_DEFAUT = 30_000;
const ECHECS_AVANT_OUVERTURE = 3;

/**
 * @param {object}   deps
 * @param {object}   [deps.client]   Client Redis (ioredis). Absent = cache inerte.
 * @param {string}   deps.env        `development` | `staging` | `production`
 * @param {string}   deps.service    ex. `tx-core`
 * @param {object}   [deps.logger]
 * @param {number}   [deps.cooldownMs]
 * @param {Function} [deps.now]
 */
function createCache({
  client = null,
  env,
  service,
  logger = null,
  cooldownMs = COOLDOWN_MS_DEFAUT,
  now = () => Date.now(),
} = {}) {
  if (!env) throw new Error("[cache] `env` manquant");
  if (!service) throw new Error("[cache] `service` manquant");

  let ouvertJusqua = 0;
  let echecsConsecutifs = 0;

  const stats = { hits: 0, misses: 0, erreurs: 0, refus: 0, contournements: 0 };

  const actif = () => Boolean(client) && now() >= ouvertJusqua;

  function noterEchec(operation, err) {
    stats.erreurs += 1;
    echecsConsecutifs += 1;

    if (echecsConsecutifs < ECHECS_AVANT_OUVERTURE) return;

    ouvertJusqua = now() + cooldownMs;
    echecsConsecutifs = 0;
    logger?.warn?.(
      `[cache] Redis en échec (${operation}) — cache CONTOURNÉ pendant ` +
        `${Math.round(cooldownMs / 1000)} s, lectures directes en base. ` +
        `Aucune requête n'échoue. Détail : ${err?.message || err}`
    );
  }

  function noterSucces() {
    echecsConsecutifs = 0;
  }

  /**
   * Lit une valeur. Rend `undefined` sur absence, erreur, ou cache contourné —
   * l'appelant ne doit pas pouvoir distinguer « absent » de « indisponible »,
   * les deux se traitent pareil : relire la source.
   */
  async function lire(ressource, id) {
    if (!actif()) {
      stats.contournements += 1;
      return undefined;
    }

    let cle;
    try {
      cle = construireCle({ env, service, ressource, id });
    } catch (err) {
      // Politique refusée : ce n'est PAS une panne, c'est un garde-fou qui a
      // fait son travail. On le journalise fort — un appelant qui tente de
      // cacher un solde doit être corrigé, pas silencieusement toléré.
      stats.refus += 1;
      logger?.warn?.(err.message);
      return undefined;
    }

    try {
      const brut = await client.get(cle);
      noterSucces();

      if (brut === null || brut === undefined) {
        stats.misses += 1;
        return undefined;
      }

      stats.hits += 1;
      return JSON.parse(brut);
    } catch (err) {
      // Un JSON illisible est traité comme une absence, pas comme une panne :
      // une valeur écrite par une version antérieure du code ne doit pas
      // ouvrir le disjoncteur.
      if (err instanceof SyntaxError) {
        stats.misses += 1;
        return undefined;
      }
      noterEchec("get", err);
      return undefined;
    }
  }

  /**
   * Écrit une valeur avec le TTL DÉCLARÉ pour la ressource. Rend `true` si
   * l'écriture a eu lieu — les tests s'en servent, le code métier l'ignore.
   */
  async function ecrire(ressource, id, valeur) {
    if (valeur === undefined || valeur === null) return false;
    if (!actif()) return false;

    const p = politique(ressource);
    if (!p.cachable) {
      stats.refus += 1;
      logger?.warn?.(`[cache] écriture refusée : ${p.raison}`);
      return false;
    }

    let cle;
    try {
      cle = construireCle({ env, service, ressource, id });
    } catch (err) {
      stats.refus += 1;
      logger?.warn?.(err.message);
      return false;
    }

    try {
      // `EX` est NON NÉGOCIABLE : une clé sans expiration finit par occuper la
      // mémoire pour toujours et par servir une valeur périmée indéfiniment.
      // Le TTL vient de la déclaration, jamais du site d'appel.
      await client.set(cle, JSON.stringify(valeur), "EX", p.ttl);
      noterSucces();
      return true;
    } catch (err) {
      noterEchec("set", err);
      return false;
    }
  }

  /**
   * Motif READ-THROUGH. C'est le seul point d'entrée que le code métier
   * devrait utiliser.
   *
   * Le producteur est appelé sur absence ET sur panne : la base fait foi, le
   * cache n'est qu'un raccourci. Une exception du producteur REMONTE — c'est
   * une vraie erreur métier, pas une affaire de cache.
   */
  async function getOrSet(ressource, id, producteur) {
    const enCache = await lire(ressource, id);
    if (enCache !== undefined) return enCache;

    const valeur = await producteur();
    await ecrire(ressource, id, valeur);
    return valeur;
  }

  /** Invalide une entrée. À appeler APRÈS le commit, jamais avant. */
  async function invalider(ressource, id) {
    if (!actif()) return false;
    try {
      await client.del(construireCle({ env, service, ressource, id }));
      noterSucces();
      return true;
    } catch (err) {
      if (/\[cache\]/.test(err?.message || "")) {
        stats.refus += 1;
        logger?.warn?.(err.message);
        return false;
      }
      noterEchec("del", err);
      return false;
    }
  }

  /**
   * Invalide toute une ressource. Utilise SCAN, jamais KEYS : `KEYS` bloque le
   * serveur Redis le temps du parcours — sur une base chargée, c'est une
   * interruption de service pour tous les autres usages, dont la limitation
   * de débit.
   */
  async function invaliderRessource(ressource) {
    if (!actif()) return 0;

    let motif;
    try {
      motif = motifRessource({ env, service, ressource });
    } catch (err) {
      stats.refus += 1;
      logger?.warn?.(err.message);
      return 0;
    }

    let curseur = "0";
    let supprimees = 0;

    try {
      do {
        const [suivant, cles] = await client.scan(curseur, "MATCH", motif, "COUNT", 100);
        curseur = suivant;
        if (cles.length) {
          await client.del(...cles);
          supprimees += cles.length;
        }
      } while (curseur !== "0");

      noterSucces();
      return supprimees;
    } catch (err) {
      noterEchec("scan", err);
      return supprimees;
    }
  }

  return {
    lire,
    ecrire,
    getOrSet,
    invalider,
    invaliderRessource,
    /** Pour `/metrics` et les tests. Copie : l'appelant ne doit pas muter l'état. */
    stats: () => ({ ...stats, contourne: !actif() }),
  };
}

module.exports = { createCache, COOLDOWN_MS_DEFAUT, ECHECS_AVANT_OUVERTURE };
