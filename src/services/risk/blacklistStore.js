"use strict";

const { TYPES, normalizeFor } = require("./normalizeIdentifiers");

/**
 * ============================================================================
 * MAGASIN DE LISTE NOIRE — CACHE MÉMOIRE, INVALIDATION PAR PUB/SUB
 * ============================================================================
 *
 * Interroger MongoDB à chaque virement pour six types d'identifiants serait
 * absurde : la liste tient en mémoire et change rarement. Mais un cache pose
 * deux questions, et la seconde est celle qui compte.
 *
 * **1. Quand se rafraîchit-il ?** Un TTL seul suffirait si l'on acceptait que
 * la fraude passe pendant la fenêtre. On ajoute donc une invalidation par
 * PUB/SUB Redis : l'instance qui inscrit une entrée publie, toutes les autres
 * rechargent dans la seconde. Le TTL reste comme filet — un message perdu ne
 * doit pas figer la liste pour toujours.
 *
 * **2. Que fait-il quand la base ne répond pas ?**
 *
 * ⚠️ C'EST LA PROPRIÉTÉ DE SÛRETÉ CENTRALE DE CE MODULE, ET ELLE EST
 * CONTRE-INTUITIVE : **une lecture ratée ne vide JAMAIS le cache.**
 *
 * Le réflexe — repartir d'une liste vide en cas d'erreur — est ici le pire
 * choix possible : une liste noire vide veut dire « tout le monde est
 * autorisé ». Une panne de base deviendrait donc une levée automatique de tous
 * les blocages antifraude, silencieuse, et d'autant plus probable qu'un attaquant
 * a intérêt à la provoquer.
 *
 * On conserve donc la dernière liste connue et on marque son âge (`stale`). Une
 * liste noire un peu vieille protège ; une liste noire vide ne protège de rien.
 */

const DEFAULT_TTL_MS = 60 * 1000;
const INVALIDATION_CHANNEL = "aml:blacklist:invalidate";

function emptySets() {
  const sets = {};
  for (const t of TYPES) sets[t] = new Set();
  return sets;
}

/**
 * @param {object} options
 * @param {Function} options.loadEntries  `async () => [{type, value}]`
 * @param {object|null} options.seed      liste statique de départ (migration)
 */
function createBlacklistStore({
  loadEntries,
  seed = null,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  logger = null,
} = {}) {
  let sets = emptySets();
  let loadedAt = 0;
  let lastError = null;
  let everLoaded = false;

  /**
   * Amorçage depuis l'ancienne liste statique.
   *
   * Sans lui, la première seconde d'exécution — avant le premier chargement —
   * se ferait avec une liste VIDE. Le fichier JSON reste donc la valeur de
   * repli tant que la base n'a pas répondu au moins une fois.
   */
  if (seed && typeof seed === "object") {
    const alias = {
      emails: "email",
      ibans: "iban",
      phones: "phone",
      userIds: "userId",
      countries: "country",
      names: "name",
    };

    for (const [cle, type] of Object.entries(alias)) {
      for (const brut of Array.isArray(seed[cle]) ? seed[cle] : []) {
        const v = normalizeFor(type, brut);
        if (v) sets[type].add(v);
      }
    }
  }

  function isExpired() {
    return now() - loadedAt > ttlMs;
  }

  /**
   * @returns {Promise<{ok: boolean, count: number, stale: boolean}>}
   *   Ne lève jamais : appelé sur le chemin d'un paiement.
   */
  async function refresh({ force = false } = {}) {
    if (!force && everLoaded && !isExpired()) {
      return { ok: true, count: size(), stale: false };
    }

    try {
      const entries = await loadEntries();

      if (!Array.isArray(entries)) {
        throw new Error("chargement invalide : tableau attendu");
      }

      const frais = emptySets();
      for (const e of entries) {
        const type = String(e?.type || "").trim();
        if (!frais[type]) continue;

        const v = normalizeFor(type, e?.value);
        if (v) frais[type].add(v);
      }

      sets = frais;
      loadedAt = now();
      everLoaded = true;
      lastError = null;

      return { ok: true, count: size(), stale: false };
    } catch (err) {
      /**
       * ⚠️ ON NE TOUCHE PAS À `sets`. Voir l'en-tête : une liste vide autorise
       * tout le monde. On garde la précédente, on note l'échec, et on laisse
       * l'appelant savoir qu'elle est périmée.
       */
      lastError = err;

      try {
        logger?.warn?.(
          `[AML] rechargement de la liste noire impossible (${err?.message || err}) — ` +
            `la liste précédente (${size()} entrée(s)) reste appliquée.`
        );
      } catch {}

      return { ok: false, count: size(), stale: true };
    }
  }

  function size() {
    return TYPES.reduce((total, t) => total + sets[t].size, 0);
  }

  /**
   * Le contrôle proprement dit. SYNCHRONE : il est appelé plusieurs fois par
   * virement, et le rendre asynchrone inviterait à oublier un `await` — un
   * oubli qui rendrait le contrôle toujours faux, sans erreur visible.
   */
  function has(type, value) {
    const set = sets[String(type || "").trim()];
    if (!set || !set.size) return false;

    const v = normalizeFor(type, value);
    return Boolean(v) && set.has(v);
  }

  function snapshot() {
    return {
      loadedAt,
      ageMs: loadedAt ? now() - loadedAt : null,
      count: size(),
      everLoaded,
      stale: !everLoaded || isExpired() || Boolean(lastError),
      lastError: lastError ? String(lastError.message || lastError) : null,
      byType: TYPES.reduce((acc, t) => ({ ...acc, [t]: sets[t].size }), {}),
    };
  }

  /**
   * Abonnement à l'invalidation. Le client Redis doit être DÉDIÉ : un client en
   * mode abonné ne peut plus exécuter de commandes ordinaires, et réutiliser
   * celui de la limitation de débit la casserait silencieusement.
   *
   * ⚠️ ASYNCHRONE, ET IL FAUT L'ATTENDRE.
   *
   * Une première version appelait `subscriber.subscribe()` sans attendre et
   * rendait `true` dans la foulée. Mesuré sur l'infrastructure réelle
   * (2026-08-26) : l'abonnement met **plus de 700 ms** à s'enregistrer, parce
   * qu'un client dupliqué doit d'abord établir sa propre connexion — poignée de
   * main TLS comprise. Pendant cette fenêtre, `publish` touchait **zéro
   * abonné** alors que le démarrage journalisait « invalidation par pub/sub ».
   *
   * C'est la même famille de défaut qu'un index déclaré mais jamais construit :
   * une garantie affichée que le système ne porte pas. Et la fenêtre tombe au
   * démarrage du service — précisément le moment où une entrée ajoutée pendant
   * un incident doit se propager.
   *
   * @returns {Promise<boolean>} vrai UNIQUEMENT si le serveur a confirmé.
   */
  async function subscribe(subscriber) {
    if (!subscriber?.subscribe) return false;

    /**
     * Le gestionnaire est posé AVANT la souscription : dans l'autre ordre, un
     * message arrivé entre les deux serait perdu.
     */
    try {
      subscriber.on("message", (channel) => {
        if (channel !== INVALIDATION_CHANNEL) return;
        refresh({ force: true });
      });
    } catch {
      return false;
    }

    try {
      // ioredis rend le nombre de canaux souscrits ; node-redis rend undefined.
      // Dans les deux cas, l'absence d'exception vaut confirmation du serveur.
      await subscriber.subscribe(INVALIDATION_CHANNEL);
      return true;
    } catch (err) {
      // Sans pub/sub, le TTL reste : la liste se rafraîchit, plus lentement.
      try {
        logger?.warn?.(
          `[AML] abonnement à l'invalidation impossible (${err?.message || err}) — ` +
            "la liste noire se rafraîchira par TTL seul."
        );
      } catch {}
      return false;
    }
  }

  return { refresh, has, snapshot, subscribe, size };
}

/**
 * Prévient les autres instances qu'une entrée a changé. Best-effort : si la
 * publication échoue, le TTL rattrapera — plus lentement, mais sûrement.
 */
async function publishInvalidation(publisher) {
  if (!publisher?.publish) return false;

  try {
    await publisher.publish(INVALIDATION_CHANNEL, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  INVALIDATION_CHANNEL,
  DEFAULT_TTL_MS,
  createBlacklistStore,
  publishInvalidation,
};
