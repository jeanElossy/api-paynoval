"use strict";

/**
 * SEAUX DE LIMITATION DE DÉBIT — par utilisateur, jamais par adresse IP
 * -----------------------------------------------------------------------------
 * ═══ POURQUOI L'IP NE PEUT PAS MARCHER ICI ═════════════════════════════════
 *
 * Tx-Core n'est jamais joint directement : tout son trafic utilisateur arrive
 * par la passerelle, donc d'une poignée d'adresses. Un plafond par IP y compte
 * donc les requêtes de TOUS les clients dans un seul seau. Le 2026-08-19, un
 * utilisateur seul a suffi à atteindre les 100 requêtes / 15 min et à faire
 * répondre 429 à `GET /api/v1/transactions` — pour tout le monde.
 *
 * ═══ CE QUE FONT STRIPE, PAYPAL ET WISE ════════════════════════════════════
 *
 * Ils comptent par COMPTE (clé d'API, jeton), jamais par adresse réseau, et
 * renvoient un 429 avec `Retry-After`. La défense contre les inondations
 * réseau appartient à la couche qui voit les vraies adresses — chez nous, la
 * passerelle. Chaque étage protège ce qu'il est seul à pouvoir observer.
 *
 * ═══ CONFIANCE ET DÉGRADATION ══════════════════════════════════════════════
 *
 * L'identité vient du jeton, donc d'une source que l'appelant contrôle. Elle
 * n'est retenue comme telle que si la SIGNATURE est valide ; sinon l'appelant
 * retombe dans un seau restreint. Un jeton forgé n'ouvre donc pas un quota
 * neuf à volonté, et un jeton légitime n'est jamais puni pour le trafic d'un
 * autre. On ne rejette pas ici pour autant : l'authentification a son propre
 * étage, et la doubler ne ferait que dupliquer une règle qui divergerait.
 *
 * Ce module est PUR — aucun accès au réseau, aucune horloge, aucune
 * dépendance à Express. La vérification cryptographique lui est injectée, ce
 * qui le rend testable sans secret ni jeton réel.
 */

/** Plafonds par fenêtre, surchargeables par l'environnement. */
const DEFAULT_AUTH_MAX = 600;
const DEFAULT_ANON_MAX = 100;

/**
 * Extrait le jeton d'un en-tête `Authorization`.
 * Rend `null` sur tout ce qui n'est pas un `Bearer` exploitable.
 */
function bearerToken(header) {
  if (typeof header !== "string") return null;

  const match = header.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

/**
 * Identifiant utilisateur porté par les claims.
 *
 * L'ordre reproduit celui de `authMiddleware` : les deux doivent désigner le
 * même utilisateur, sans quoi le quota s'appliquerait à une identité et les
 * droits à une autre.
 */
function userIdFromClaims(claims) {
  if (!claims || typeof claims !== "object") return null;

  const raw =
    claims.sub || claims.id || claims.userId || claims._id || null;

  if (raw == null) return null;

  const value = String(raw).trim();
  return value === "" ? null : value;
}

/**
 * Identifie l'appelant à partir de sa requête.
 *
 * @param {object}   req
 * @param {function} verify  (token) => claims | null  — DOIT vérifier la
 *                           signature ; toute exception vaut « non vérifié »
 * @returns {{ userId: string|null, verified: boolean }}
 */
function identify(req, verify) {
  const token = bearerToken(req?.headers?.authorization);
  if (!token || typeof verify !== "function") {
    return { userId: null, verified: false };
  }

  let claims = null;

  try {
    claims = verify(token);
  } catch {
    claims = null;
  }

  const userId = userIdFromClaims(claims);
  return userId ? { userId, verified: true } : { userId: null, verified: false };
}

/**
 * Seau de comptage.
 *
 * Le préfixe évite qu'un utilisateur dont l'identifiant ressemble à une
 * adresse IP ne partage le seau d'une adresse — collision improbable, mais
 * gratuite à écarter.
 */
function bucketFor({ userId, verified, ip }) {
  if (userId && verified) return `u:${userId}`;
  return `ip:${ip || "unknown"}`;
}

/** Plafond applicable au seau. */
function limitFor({ verified }, { authMax = DEFAULT_AUTH_MAX, anonMax = DEFAULT_ANON_MAX } = {}) {
  return verified ? authMax : anonMax;
}

module.exports = {
  DEFAULT_AUTH_MAX,
  DEFAULT_ANON_MAX,
  bearerToken,
  userIdFromClaims,
  identify,
  bucketFor,
  limitFor,
};
