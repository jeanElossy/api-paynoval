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

/**
 * La clé À PERSISTER sur la transaction.
 *
 * ⚠️ Ce n'est PAS la même chose que `extractIdempotencyKey`. Celle-ci lit la
 * requête entrante ; celle-là dit ce qu'on écrit dans `Transaction.idempotencyKey`,
 * champ sur lequel reposent les index uniques partiels `{sender, idempotencyKey}`
 * et `{userId, idempotencyKey}`.
 *
 * Le défaut qu'elle ferme (trouvé le 2026-09-03) : les handlers ne lisaient la
 * clé que dans le CORPS (`body.idempotencyKey`), alors que l'application mobile
 * ne l'envoie que dans l'EN-TÊTE (`payNoval-master/tools/api.js` :
 * `headers: { "Idempotency-Key": … }`, et `buildUnifiedInitiatePayload` n'en met
 * aucune au corps). Le champ restait donc `undefined`, le
 * `partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } }`
 * excluait le document, et les deux index uniques ne mordaient JAMAIS sur le
 * trafic de production.
 *
 * Cela n'avait aucune conséquence en régime nominal — le registre
 * `idempotency_records` fait le travail. Mais quand ce registre est
 * indisponible, `middleware/idempotency.js` appelle `next()` en s'appuyant
 * explicitement sur ces index (« le risque de doublon reste couvert en aval »).
 * Le filet annoncé n'existait pas là où il comptait : deux `/initiate`
 * concurrents auraient créé deux transactions et RÉSERVÉ LES FONDS DEUX FOIS.
 *
 * Ordre de lecture : `req.idempotencyKey`, posée par le middleware après
 * validation (elle vient de l'en-tête ou du corps, en-tête prioritaire), puis
 * le corps en repli si le middleware n'est pas monté sur la route.
 *
 * @returns {string|undefined} `undefined` — jamais `null` ni `""` — quand il n'y
 *   a pas de clé : le filtre partiel de l'index exige un `$type: "string"`.
 */
function resolvePersistedIdempotencyKey(req, body) {
  const depuisMiddleware = typeof req?.idempotencyKey === "string" ? req.idempotencyKey.trim() : "";
  if (depuisMiddleware) return depuisMiddleware;

  const depuisCorps = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  return depuisCorps || undefined;
}

module.exports = {
  stableStringify,
  extractIdempotencyKey,
  resolvePersistedIdempotencyKey,
  isValidIdempotencyKey,
  buildScope,
  computeRequestFingerprint,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
};
