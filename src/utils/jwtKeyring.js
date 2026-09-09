"use strict";

/**
 * TROUSSEAU DE CLÉS JWT — POUR QUE LA ROTATION SOIT POSSIBLE
 * ============================================================================
 *
 * ⚠️ FICHIER RÉPLIQUÉ À L'IDENTIQUE DANS LES TROIS SERVICES :
 * `paynoval-backend/utils/jwtKeyring.js`,
 * `api-gateway/api-gateway/src/utils/jwtKeyring.js`,
 * `api-paynoval/src/utils/jwtKeyring.js`.
 * Toute correction se porte dans les trois — comme pour `redisStoreSafety.js`
 * et `requestId.js`. Une divergence ici rendrait des jetons valides d'un côté
 * et refusés de l'autre.
 *
 * ── Le problème que ce module résout ──────────────────────────────────────
 *
 * Jusqu'au 2026-09-03, un unique `JWT_SECRET` signait et vérifiait tous les
 * jetons, dans les trois services. Conséquence : **le secret ne pouvait pas
 * tourner.** Le remplacer invalidait d'un coup tous les jetons en circulation,
 * donc déconnectait tous les utilisateurs simultanément.
 *
 * Ce qui veut dire, en pratique, qu'il ne tournait jamais. Et qu'en cas de
 * compromission, le choix se résumait à : laisser un secret compromis en place,
 * ou couper le service. Aucune des deux options n'est acceptable pour une
 * plateforme de paiement.
 *
 * ── Le mécanisme ──────────────────────────────────────────────────────────
 *
 * Chaque jeton porte un identifiant de clé (`kid`) dans son EN-TÊTE — c'est un
 * champ standard, JWS RFC 7515 §4.1.4. La vérification lit ce `kid` et choisit
 * la clé correspondante dans le trousseau.
 *
 * Une rotation devient alors : ajouter une clé, la désigner active, garder la
 * précédente le temps que les jetons émis avec elle expirent. Les jetons
 * d'accès de PayNoval vivant 2 heures, cette fenêtre est courte et le
 * basculement est insensible pour les utilisateurs.
 *
 * ── Configuration ─────────────────────────────────────────────────────────
 *
 *   JWT_KEYS='{"2026-09":"<secret courant>","2026-06":"<précédent>"}'
 *   JWT_ACTIVE_KID='2026-09'
 *
 * `JWT_KEYS` est un objet JSON `kid -> secret`. `JWT_ACTIVE_KID` désigne celle
 * qui SIGNE ; toutes les autres restent acceptées en VÉRIFICATION.
 *
 * ── Rétrocompatibilité — la partie qui compte ─────────────────────────────
 *
 * Sans ces variables, le module retombe sur `JWT_SECRET` : rien ne change, et
 * aucun déploiement n'est requis pour continuer à fonctionner.
 *
 * Et surtout : **un jeton SANS `kid` est vérifié avec `JWT_SECRET`**. C'est
 * indispensable — tous les jetons en circulation au moment du déploiement n'en
 * portent aucun. Sans cette branche, activer ce module déconnecterait
 * exactement tout le monde, c'est-à-dire le problème qu'il vient résoudre.
 *
 * ── Procédure de rotation ─────────────────────────────────────────────────
 *
 *   1. Poser `JWT_KEYS` avec l'ancienne clé sous un kid, et la nouvelle sous un
 *      autre. `JWT_ACTIVE_KID` = l'ANCIENNE. Déployer les trois services.
 *      → rien ne change ; on a seulement appris à lire les `kid`.
 *   2. `JWT_ACTIVE_KID` = la NOUVELLE. Déployer le backend seul (il est le seul
 *      émetteur).
 *      → les nouveaux jetons portent la nouvelle clé, les anciens restent
 *        acceptés.
 *   3. Après expiration du plus long jeton d'accès (2 h par défaut), retirer
 *      l'ancienne clé de `JWT_KEYS`. Déployer les trois.
 *
 * Chaque étape est réversible, et aucune ne déconnecte personne.
 */

/** Cache de processus : `JWT_KEYS` est du JSON, on ne le reparse pas à chaque jeton. */
let cache = null;
let cacheSource = null;

function parseKeys(raw) {
  if (!raw) return {};

  let objet;
  try {
    objet = JSON.parse(raw);
  } catch {
    /**
     * Échec en FERMETURE : un `JWT_KEYS` illisible ne se traite pas comme un
     * `JWT_KEYS` absent. La distinction compte — l'absence est un régime
     * nominal (on retombe sur `JWT_SECRET`), une syntaxe cassée est une erreur
     * de déploiement qui doit se voir tout de suite, pas dégrader en silence
     * vers un secret que l'opérateur croyait avoir remplacé.
     */
    const err = new Error(
      "JWT_KEYS n'est pas un JSON valide. Format attendu : " +
        '{"<kid>":"<secret>", …}. Aucun repli n\'est appliqué.'
    );
    err.code = "JWT_KEYS_INVALID";
    throw err;
  }

  if (!objet || typeof objet !== "object" || Array.isArray(objet)) {
    const err = new Error("JWT_KEYS doit être un objet JSON { kid: secret }.");
    err.code = "JWT_KEYS_INVALID";
    throw err;
  }

  const clefs = {};
  for (const [kid, secret] of Object.entries(objet)) {
    const s = String(secret || "").trim();
    if (kid && s) clefs[kid] = s;
  }

  return clefs;
}

function keyring() {
  const raw = String(process.env.JWT_KEYS || "").trim();

  if (cache && cacheSource === raw) return cache;

  cache = parseKeys(raw);
  cacheSource = raw;
  return cache;
}

/** Vide le cache — pour les tests, qui changent l'environnement. */
function resetKeyringCache() {
  cache = null;
  cacheSource = null;
}

/**
 * La clé qui SIGNE. Rend `{ kid, secret }`, ou `{ kid: null, secret }` en régime
 * hérité (pas de trousseau configuré).
 */
function getSigningKey() {
  const clefs = keyring();
  const actif = String(process.env.JWT_ACTIVE_KID || "").trim();

  if (Object.keys(clefs).length > 0) {
    if (!actif) {
      const err = new Error(
        "JWT_KEYS est configuré mais JWT_ACTIVE_KID est absent : on ne sait pas " +
          "quelle clé doit signer. Aucun repli — poser JWT_ACTIVE_KID."
      );
      err.code = "JWT_ACTIVE_KID_MISSING";
      throw err;
    }

    if (!clefs[actif]) {
      const err = new Error(
        `JWT_ACTIVE_KID vaut "${actif}", absent de JWT_KEYS. ` +
          `Clés connues : ${Object.keys(clefs).join(", ") || "(aucune)"}.`
      );
      err.code = "JWT_ACTIVE_KID_UNKNOWN";
      throw err;
    }

    return { kid: actif, secret: clefs[actif] };
  }

  // Régime hérité : un seul secret, pas de kid. Le module est transparent.
  const legacy = String(process.env.JWT_SECRET || "").trim();
  if (!legacy) {
    const err = new Error(
      "Ni JWT_KEYS ni JWT_SECRET ne sont posés : aucun jeton ne peut être signé."
    );
    err.code = "JWT_NO_KEY";
    throw err;
  }

  return { kid: null, secret: legacy };
}

/**
 * La clé qui VÉRIFIE un jeton donné, choisie d'après le `kid` de son en-tête.
 *
 * @param {string|null|undefined} kid lu dans l'en-tête JWS
 * @returns {string|null} le secret, ou `null` si ce `kid` est inconnu
 */
function getVerificationKey(kid) {
  const clefs = keyring();

  if (kid) {
    // Une clé retirée du trousseau rend `null` : le jeton est refusé, ce qui
    // est exactement l'effet recherché à l'étape 3 d'une rotation.
    return clefs[kid] || null;
  }

  /**
   * Pas de `kid` : jeton émis avant l'activation du trousseau. On le vérifie
   * avec `JWT_SECRET`. C'est la branche qui rend le déploiement insensible —
   * sans elle, activer ce module déconnecterait tous les utilisateurs.
   */
  return String(process.env.JWT_SECRET || "").trim() || null;
}

/**
 * Lit le `kid` de l'en-tête d'un jeton SANS le vérifier.
 *
 * ⚠️ Le `kid` est une donnée NON AUTHENTIFIÉE : il vient d'un en-tête que
 * n'importe qui peut fabriquer. Il ne sert qu'à CHOISIR une clé dans un
 * trousseau fermé — jamais à décider si le jeton est valide. Un `kid` inconnu
 * rend `null`, donc aucune clé, donc un refus. Un `kid` connu ne prouve rien :
 * c'est la vérification de signature qui tranche, ensuite.
 */
function readKid(token) {
  try {
    const entete = String(token || "").split(".")[0];
    if (!entete) return null;

    const json = JSON.parse(Buffer.from(entete, "base64url").toString("utf8"));
    const kid = json && typeof json.kid === "string" ? json.kid.trim() : "";

    return kid || null;
  } catch {
    // En-tête illisible : le jeton est de toute façon invalide, la vérification
    // le refusera. On ne lève pas ici pour ne pas masquer sa vraie erreur.
    return null;
  }
}

/** Décrit le régime effectif — pour les journaux de démarrage (règle B.6). */
function describeKeyring() {
  try {
    const clefs = keyring();
    const kids = Object.keys(clefs);

    if (kids.length === 0) {
      return {
        mode: "legacy",
        rotatable: false,
        message:
          "🔑 JWT : clé unique JWT_SECRET, sans trousseau. CONSÉQUENCE : le secret " +
          "ne peut pas tourner sans déconnecter tous les utilisateurs. " +
          "Poser JWT_KEYS et JWT_ACTIVE_KID pour rendre la rotation possible.",
      };
    }

    const actif = String(process.env.JWT_ACTIVE_KID || "").trim();
    const legacyEncoreAccepte = Boolean(String(process.env.JWT_SECRET || "").trim());

    return {
      mode: "keyring",
      rotatable: true,
      activeKid: actif,
      kids,
      legacyAccepted: legacyEncoreAccepte,
      message:
        `🔑 JWT : trousseau de ${kids.length} clé(s) [${kids.join(", ")}], ` +
        `signature par "${actif}". ` +
        (legacyEncoreAccepte
          ? "Les jetons SANS kid restent acceptés via JWT_SECRET — retirer cette " +
            "variable une fois la transition terminée."
          : "Les jetons sans kid sont refusés."),
    };
  } catch (err) {
    return {
      mode: "error",
      rotatable: false,
      message: `❌ Trousseau JWT illisible : ${err.message}`,
    };
  }
}

module.exports = {
  getSigningKey,
  getVerificationKey,
  readKid,
  describeKeyring,
  resetKeyringCache,
};
