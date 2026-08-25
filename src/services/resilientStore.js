"use strict";

/**
 * MAGASIN DE LIMITATION RÉSILIENT
 * =============================================================================
 *
 * ═══ LE PROBLÈME ══════════════════════════════════════════════════════════
 *
 * `express-rate-limit` v7 sait laisser passer une requête quand son magasin
 * échoue (`passOnStoreError`). **La v6, utilisée ici, ne le sait pas** : une
 * erreur du magasin remonte à `next(err)` et devient un 500.
 *
 * Conséquence, si on branchait Redis tel quel sur ce service : une coupure du
 * cache ferait échouer **toutes les requêtes de transaction**. Une dépendance
 * auxiliaire deviendrait un point de panne du chemin de l'argent. C'est
 * exactement l'amplification qu'il faut éviter.
 *
 * ═══ LE CHOIX, ET POURQUOI CE N'EST PAS ÉVIDENT ═══════════════════════════
 *
 * Un limiteur en panne peut soit **bloquer** (fail-closed), soit **laisser
 * passer** (fail-open). Bloquer paraît plus prudent : on refuse plutôt que de
 * risquer l'abus.
 *
 * C'est le mauvais arbitrage ici, et c'est aussi celui que font Stripe et
 * Cloudflare. La limitation de débit protège d'un ABUS ; ce n'est pas une règle
 * métier. Arrêter les paiements parce qu'un compteur est indisponible cause un
 * dommage certain pour éviter un dommage hypothétique.
 *
 * On ne laisse toutefois pas passer *sans rien compter* : on bascule sur un
 * compteur **en mémoire**. C'est dégradé — chaque instance compte pour elle —
 * mais infiniment mieux que rien pendant une panne, et cela évite qu'une
 * coupure Redis ouvre grand la porte.
 *
 * ═══ POURQUOI UNE PÉRIODE DE REPOS ════════════════════════════════════════
 *
 * Sans elle, chaque requête retenterait Redis, attendrait son délai d'expiration
 * et échouerait : la panne se paierait en latence sur tout le trafic. Après un
 * échec, on utilise directement la mémoire pendant `cooldownMs`, puis on
 * retente une fois. Un seul appel sert de sonde, pas tout le trafic.
 *
 * ═══ POURQUOI CE MODULE EST ÉCRIT EN INJECTION ════════════════════════════
 *
 * `primary`, `fallback`, `logger` et `now` sont **fournis**. On peut donc
 * vérifier le basculement, la reprise et la journalisation étranglée sans
 * qu'aucun Redis ne tourne et sans attendre une seule seconde réelle.
 */

const DEFAULT_COOLDOWN_MS = 10_000;

/** Une erreur toutes les N ms au plus : une panne ne doit pas noyer les journaux. */
const DEFAULT_LOG_EVERY_MS = 30_000;

/**
 * @param {object}   deps
 * @param {object}   deps.primary   Magasin Redis.
 * @param {object}   deps.fallback  Magasin mémoire.
 * @param {object}   [deps.logger]
 * @param {number}   [deps.cooldownMs]
 * @param {Function} [deps.now]
 */
function createResilientStore({
  primary,
  fallback,
  logger = null,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  logEveryMs = DEFAULT_LOG_EVERY_MS,
  now = () => Date.now(),
} = {}) {
  if (!primary) throw new Error("resilientStore : magasin `primary` manquant");
  if (!fallback) throw new Error("resilientStore : magasin `fallback` manquant");

  /** Instant jusqu'auquel on n'essaie plus le magasin principal. */
  let degradedUntil = 0;
  let lastLoggedAt = 0;
  let failures = 0;

  function isDegraded() {
    return now() < degradedUntil;
  }

  function noteFailure(method, err) {
    failures += 1;
    degradedUntil = now() + cooldownMs;

    const t = now();
    if (t - lastLoggedAt < logEveryMs) return;

    lastLoggedAt = t;

    logger?.warn?.(
      `[rate-limit] magasin Redis en échec (${method}) — comptage en mémoire ` +
        `pendant ${Math.round(cooldownMs / 1000)} s. ` +
        `Les requêtes ne sont PAS bloquées. Échecs cumulés : ${failures}. ` +
        `Détail : ${err?.message || err}`
    );
  }

  /**
   * Délègue au principal, bascule sur le repli en cas d'échec.
   *
   * ⚠️ Ne relance JAMAIS : c'est tout l'objet du module. Une exception ici
   * deviendrait un 500 sur le chemin de la transaction.
   */
  async function call(method, args, { fallbackValue } = {}) {
    if (!isDegraded()) {
      try {
        return await primary[method](...args);
      } catch (err) {
        noteFailure(method, err);
      }
    }

    try {
      return await fallback[method](...args);
    } catch (err) {
      logger?.error?.(
        `[rate-limit] le magasin de repli a échoué (${method}) : ${
          err?.message || err
        }`
      );

      /**
       * Dernier recours : on rend une valeur qui laisse passer. Aucune panne
       * du compteur ne doit refuser une transaction.
       */
      return fallbackValue;
    }
  }

  return {
    /** express-rate-limit lit cette propriété pour avertir en cas de mauvaise config. */
    localKeys: false,

    init(options) {
      try { primary.init?.(options); } catch {}
      try { fallback.init?.(options); } catch {}
    },

    increment(key) {
      return call("increment", [key], {
        // Un seul coup compté, fenêtre nulle : la requête passe.
        fallbackValue: { totalHits: 1, resetTime: undefined },
      });
    },

    decrement(key) {
      return call("decrement", [key]);
    },

    resetKey(key) {
      return call("resetKey", [key]);
    },

    resetAll() {
      return call("resetAll", []);
    },

    shutdown() {
      try { primary.shutdown?.(); } catch {}
      try { fallback.shutdown?.(); } catch {}
    },

    /** Diagnostic. */
    __state: () => ({ degraded: isDegraded(), failures, degradedUntil }),
  };
}

module.exports = {
  createResilientStore,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_LOG_EVERY_MS,
};
