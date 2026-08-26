"use strict";

/**
 * ============================================================================
 * VÉLOCITÉ — DÉTECTER LA RAFALE, PAS TENIR LES COMPTES
 * ============================================================================
 *
 * ⚠️ REDIS N'EST PAS UNE SOURCE DE VÉRITÉ FINANCIÈRE (§13 de la commande).
 *
 * Ce module compte des ÉVÉNEMENTS pour alimenter un score de risque. Il ne
 * décide d'aucun solde, ne plafonne aucune limite réglementaire, et ses
 * montants sont des flottants — ce qui serait inacceptable pour un grand livre
 * et sans conséquence pour un signal. Les limites qui engagent restent
 * calculées sur MongoDB (`services/aml.js`, `getUserTransactionsStats`).
 *
 * Le partage des rôles :
 *   - **MongoDB** dit la vérité, mais coûte des agrégations à chaque virement ;
 *   - **Redis** dit le RYTHME, en O(1), et détecte la rafale que la base ne
 *     verrait qu'après coup.
 *
 * ⚠️ FENÊTRES GLISSANTES APPROCHÉES, ET C'EST DÉLIBÉRÉ.
 *
 * Les compteurs vivent dans des seaux horodatés (`…:<numéro de seau>`) plutôt
 * que dans des ensembles triés. Un ensemble trié donnerait la fenêtre exacte,
 * au prix d'un `ZREMRANGEBYSCORE` à chaque lecture et d'une mémoire qui croît
 * avec le trafic. Le seau coûte un `INCR` et s'efface tout seul par TTL.
 *
 * Le défaut connu du seau fixe — une rafale à cheval sur deux seaux est
 * sous-comptée — est corrigé en lisant le seau COURANT **et** le précédent :
 * c'est le motif « sliding window counter ». L'approximation restante est
 * majorante côté sécurité, jamais minorante.
 *
 * ⚠️ CE MODULE NE LÈVE JAMAIS. Une panne du cache doit dégrader le SIGNAL, pas
 * refuser un paiement ni en laisser passer un. `read()` rend `null` — et
 * `riskScore` traduit ce `null` en `SIGNAL_UNAVAILABLE`, jamais en zéro.
 */

/** Fenêtres, en secondes. */
const WINDOWS = Object.freeze({
  COUNT_LAST_HOUR: 3600,
  AMOUNT_LAST_24H: 86400,
  SAME_DESTINATION: 600,
});

/**
 * Marge de conservation : le TTL couvre deux seaux, puisqu'on lit toujours le
 * courant et le précédent. Sans elle, le seau précédent aurait déjà disparu au
 * moment où on en a besoin.
 */
const TTL_FACTOR = 2;

/** Numéro du seau contenant cet instant, pour une fenêtre donnée. */
function bucketOf(nowMs, windowSeconds) {
  return Math.floor(nowMs / 1000 / windowSeconds);
}

/**
 * Les deux clés à sommer : le seau courant et le précédent.
 *
 * Volontairement PUR — c'est la partie où une erreur passerait inaperçue (un
 * mauvais découpage sous-compte une rafale sans que rien ne le signale), donc
 * c'est la partie qu'il faut pouvoir tester sans Redis.
 */
function windowKeys(prefix, identity, windowSeconds, nowMs) {
  const b = bucketOf(nowMs, windowSeconds);
  return [`${prefix}:${identity}:${b}`, `${prefix}:${identity}:${b - 1}`];
}

/**
 * Normalise un bénéficiaire en une clé stable.
 *
 * Un e-mail en majuscules et le même en minuscules doivent produire la MÊME
 * clé : sinon il suffirait de varier la casse pour réinitialiser le compteur.
 */
function destinationKey(destination) {
  const raw = String(destination || "").trim().toLowerCase();
  if (!raw) return null;
  // Les caractères hors jeu simple sont remplacés : une clé Redis ne doit pas
  // dépendre de ce qu'un utilisateur a saisi.
  return raw.replace(/[^a-z0-9@._+-]/g, "_").slice(0, 120);
}

const P = Object.freeze({
  COUNT: "vel:c",
  AMOUNT: "vel:a",
  DEST: "vel:d",
});

/**
 * @param {object} options
 * @param {object|null} options.client client ioredis, ou `null` (aucun cache)
 */
function createVelocityTracker({ client = null, now = () => Date.now() } = {}) {
  const usable = () =>
    Boolean(client) && (client.status === undefined || client.status === "ready");

  /**
   * Enregistre un virement. BEST-EFFORT, sans exception possible.
   *
   * Perdre un incrément dégrade un signal ; faire échouer un paiement parce que
   * le cache n'a pas répondu serait un défaut bien plus grave.
   */
  async function record({ userId, amount = 0, destination = null } = {}) {
    const uid = String(userId || "").trim();
    if (!uid || !usable()) return false;

    const t = now();
    const dest = destinationKey(destination);

    try {
      const pipe = client.pipeline();

      /**
       * On n'incrémente QUE le seau courant. `windowKeys` en rend deux — le
       * précédent n'existe que pour la LECTURE, où l'on somme les deux afin de
       * ne pas sous-compter une rafale à cheval sur une frontière.
       */
      const current = (prefix, identity, windowSeconds) =>
        `${prefix}:${identity}:${bucketOf(t, windowSeconds)}`;

      const bump = (key, ttlWindow) => {
        pipe.incr(key);
        pipe.expire(key, ttlWindow * TTL_FACTOR);
      };

      bump(current(P.COUNT, uid, WINDOWS.COUNT_LAST_HOUR), WINDOWS.COUNT_LAST_HOUR);

      const amountKey = current(P.AMOUNT, uid, WINDOWS.AMOUNT_LAST_24H);
      pipe.incrbyfloat(amountKey, Number(amount) || 0);
      pipe.expire(amountKey, WINDOWS.AMOUNT_LAST_24H * TTL_FACTOR);

      if (dest) {
        bump(
          current(P.DEST, `${uid}:${dest}`, WINDOWS.SAME_DESTINATION),
          WINDOWS.SAME_DESTINATION
        );
      }

      await pipe.exec();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @returns {Promise<object|null>} `null` quand le cache n'a rien pu dire —
   *   ce que `riskScore` traduit en `SIGNAL_UNAVAILABLE`, jamais en zéro.
   */
  async function read({ userId, destination = null } = {}) {
    const uid = String(userId || "").trim();
    if (!uid || !usable()) return null;

    const t = now();
    const dest = destinationKey(destination);

    const countKeys = windowKeys(P.COUNT, uid, WINDOWS.COUNT_LAST_HOUR, t);
    const amountKeys = windowKeys(P.AMOUNT, uid, WINDOWS.AMOUNT_LAST_24H, t);
    const destKeys = dest
      ? windowKeys(P.DEST, `${uid}:${dest}`, WINDOWS.SAME_DESTINATION, t)
      : [];

    try {
      const values = await client.mget([...countKeys, ...amountKeys, ...destKeys]);
      if (!Array.isArray(values)) return null;

      const sum = (slice) =>
        slice.reduce((total, v) => total + (Number(v) || 0), 0);

      return {
        countLastHour: sum(values.slice(0, 2)),
        amountLast24h: sum(values.slice(2, 4)),
        sameDestinationLast10min: destKeys.length ? sum(values.slice(4, 6)) : 0,
      };
    } catch {
      return null;
    }
  }

  return { record, read, usable };
}

module.exports = {
  WINDOWS,
  TTL_FACTOR,
  bucketOf,
  windowKeys,
  destinationKey,
  createVelocityTracker,
};
