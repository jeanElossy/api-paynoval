"use strict";

/**
 * Masquage des valeurs sensibles avant journalisation.
 *
 * ⚠️ Ce module existe à cause d'un correctif de sécurité. Le contrôleur des
 * transactions du gateway journalisait `req.body` intégralement à onze
 * endroits. Or le corps d'un `/initiate` porte la RÉPONSE À LA QUESTION DE
 * SÉCURITÉ en clair, et celui d'un `/confirm` le code de confirmation — les
 * deux valeurs qu'un audit de journal interdit d'écrire.
 *
 * Le garde-fou de production de `src/app.js` réduit `console.log` au silence
 * mais PAS `console.error` : le chemin d'erreur de `/initiate` écrivait donc la
 * réponse de sécurité dans les journaux de production à chaque échec, c'est-à-
 * dire précisément quand on est le plus enclin à aller les lire.
 *
 * Le module est volontairement SANS DÉPENDANCE et sans lecture de
 * configuration : le contrôleur qui l'utilise tire `src/config`, qui appelle
 * `process.exit(1)` hors d'un environnement complet, et serait donc
 * intestable. Même raison d'être que `userScopeQuery.js` dans TX Core.
 */

/**
 * Comparaison en minuscules, sans séparateurs : `securityAnswer`,
 * `security_answer` et `SECURITY-ANSWER` désignent la même chose et doivent
 * être masqués tous les trois. Un client qui change de convention de nommage
 * ne doit pas rouvrir la fuite.
 */
const SENSITIVE_KEYS = new Set([
  "securityanswer",
  "securitycode",
  "validationcode",
  "code",
  "pin",
  "pincode",
  "password",
  "passwordconfirm",
  "token",
  "refreshtoken",
  "accesstoken",
  "idtoken",
  "secret",
  "clientsecret",
  "apikey",
  "authorization",
  "otp",
  "otpcode",
  "twofacode",
  "twofactorcode",
  "answer",
  "securityanswerhash",
]);

const REDACTED = "[REDACTED]";

/** Profondeur maximale : une garde contre un payload hostile très imbriqué. */
const MAX_DEPTH = 8;

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[-_\s]/g, "");
}

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

/**
 * Rend une copie masquée. L'original n'est jamais muté : le corps de la requête
 * poursuit sa route vers le microservice, où la valeur réelle est nécessaire.
 *
 * On remplace la valeur mais on GARDE la clé — savoir qu'un champ était présent
 * reste une information de débogage utile, sa valeur ne l'est jamais. Une
 * valeur vide ou nulle est laissée telle quelle : elle ne révèle rien, et
 * distinguer « absent » de « masqué » aide au diagnostic.
 */
function redactSensitive(value, depth = 0) {
  if (value == null) return value;

  if (depth >= MAX_DEPTH) return "[TRUNCATED]";

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1));
  }

  if (value instanceof Date) return value;

  if (typeof value !== "object") return value;

  const out = {};

  for (const [key, val] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = val === null || val === undefined || val === "" ? val : REDACTED;
      continue;
    }

    out[key] = redactSensitive(val, depth + 1);
  }

  return out;
}

module.exports = {
  redactSensitive,
  isSensitiveKey,
  SENSITIVE_KEYS,
  REDACTED,
};
