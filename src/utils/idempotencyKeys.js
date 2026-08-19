"use strict";

/**
 * Clés et empreintes d'idempotence — logique PURE, testable sans base.
 *
 * `utils/idempotency.js` existait déjà avec des briques voisines, mais
 * `pickIdempotencyKey` n'était **appelée nulle part** : la lecture de l'en-tête
 * `Idempotency-Key` n'était branchée sur aucun endpoint de création. Ce module
 * reprend le rôle avec ce qui manquait — l'empreinte de requête et la portée —
 * et sert de socle au middleware.
 */

const crypto = require("crypto");

/** Longueurs acceptées : assez pour un UUID, trop court = collision facile. */
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 255;

/**
 * Sérialisation STABLE : deux objets équivalents doivent produire la même
 * chaîne, quel que soit l'ordre d'écriture des champs par le client. Sans cela,
 * `{a:1,b:2}` et `{b:2,a:1}` donneraient deux empreintes différentes, et un
 * rejeu légitime serait pris pour une réutilisation abusive de la clé.
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const keys = Object.keys(value).sort();

  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

/** Lit la clé : en-tête d'abord (la norme), corps ensuite (compatibilité). */
function extractIdempotencyKey(req) {
  const headers = req?.headers || {};

  for (const name of ["idempotency-key", "x-idempotency-key"]) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) {
        const value = String(headers[key] || "").trim();
        if (value) return value;
      }
    }
  }

  const fromBody =
    req?.body?.idempotencyKey || req?.body?.metadata?.idempotencyKey || "";

  return String(fromBody || "").trim();
}

function isValidIdempotencyKey(key) {
  const value = String(key || "").trim();

  return (
    value.length >= MIN_KEY_LENGTH &&
    value.length <= MAX_KEY_LENGTH &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

/**
 * La portée isole les clés par utilisateur ET par endpoint.
 *
 * Sans l'utilisateur, deux clients qui choisissent la même clé se voleraient
 * mutuellement leurs réponses. Sans le chemin, une clé consommée sur `/initiate`
 * rendrait la réponse d'un virement à une requête d'annulation.
 */
function buildScope({ userId, method, path }) {
  return [
    String(userId || "anonymous"),
    String(method || "").toUpperCase(),
    String(path || ""),
  ].join("|");
}

/**
 * Empreinte de la requête d'origine.
 *
 * Elle permet de distinguer un vrai rejeu (même clé, même contenu → on rend la
 * réponse d'origine) d'une réutilisation abusive (même clé, contenu différent →
 * on refuse). Sans elle, un client qui recycle une clé croirait son second
 * virement effectué alors qu'il n'a rien fait.
 */
function computeRequestFingerprint({ method, path, body }) {
  const payload = stableStringify({
    method: String(method || "").toUpperCase(),
    path: String(path || ""),
    body: body ?? null,
  });

  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

module.exports = {
  stableStringify,
  extractIdempotencyKey,
  isValidIdempotencyKey,
  buildScope,
  computeRequestFingerprint,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
};
