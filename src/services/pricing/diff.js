"use strict";

/**
 * Différentiel entre deux versions de barème — déplacé depuis l'API Gateway le 2026-09-10.
 *
 * Le domaine des prix appartenait à la passerelle, qui le servait à Tx-Core en
 * HTTP : le moteur d'argent dépendait donc du bord, et une panne de la
 * passerelle arrêtait les virements de l'intérieur. Les dépendances descendent
 * — bord → services → moteur, jamais l'inverse. C'est la règle que tiennent
 * Stripe, PayPal et Adyen, et la raison pour laquelle leur passerelle ne
 * possède aucun domaine et ne détient aucune base.
 * */
/**
 * DIFF ENTRE L'ÉTAT PUBLIÉ ET L'ÉTAT PROPOSÉ D'UNE RÈGLE
 * -----------------------------------------------------------------------------
 * Le valideur doit voir ce qu'il approuve, champ par champ. Approuver un objet
 * JSON entier n'est pas une validation.
 *
 * Le résultat est figé au dépôt de la demande. Il est INFORMATIF : c'est le
 * contrôle de `baseVersion` qui empêche l'application d'une demande devenue
 * obsolète, jamais le diff.
 *
 * Fonction pure.
 */

/**
 * Champs pilotés par le serveur, pas par l'opérateur : les faire apparaître
 * dans un diff noierait les vraies modifications.
 */
const IGNORED_PATHS = new Set([
  "_id",
  "id",
  "__v",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "currentVersion",
  "version",
  "lastChangeRequestId",
  "fxPreview",
]);

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/** Une date, une chaîne ISO et un timestamp désignant le même instant sont égaux. */
function normalize(value) {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "string") {
    // Seules les chaînes de forme ISO sont réinterprétées : « XOF » ne doit
    // jamais être confondu avec une date.
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const t = Date.parse(value);
      if (Number.isFinite(t)) return new Date(t).toISOString();
    }
  }

  return value;
}

function sameValue(a, b) {
  const na = normalize(a);
  const nb = normalize(b);

  if (Array.isArray(na) && Array.isArray(nb)) {
    return na.length === nb.length && na.every((v, i) => sameValue(v, nb[i]));
  }

  return na === nb;
}

function walk(before, after, prefix, out) {
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);

  for (const key of keys) {
    if (IGNORED_PATHS.has(key)) continue;

    const path = prefix ? `${prefix}.${key}` : key;
    const a = before ? before[key] : undefined;
    const b = after ? after[key] : undefined;

    if (isPlainObject(a) || isPlainObject(b)) {
      walk(isPlainObject(a) ? a : {}, isPlainObject(b) ? b : {}, path, out);
      continue;
    }

    if (!sameValue(a, b)) {
      out.push({
        path,
        before: a === undefined ? null : normalize(a),
        after: b === undefined ? null : normalize(b),
      });
    }
  }
}

/**
 * @param {object|null} before  État publié. `null` pour une création.
 * @param {object} after        État proposé.
 * @returns {Array<{path: string, before: any, after: any}>} trié par `path`.
 */
function computeRuleDiff(before, after) {
  const out = [];
  walk(before || {}, after || {}, "", out);
  out.sort((x, y) => x.path.localeCompare(y.path));
  return out;
}

module.exports = { computeRuleDiff, IGNORED_PATHS };
