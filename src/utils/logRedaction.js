"use strict";

/**
 * ============================================================================
 * MASQUAGE DES DONNÉES PERSONNELLES DANS LES JOURNAUX — PAR VALEUR
 * ============================================================================
 *
 * Règle B.4 : rien de sensible ne se journalise. Le masquage PAR CLÉ
 * (`redactSensitive`) ne voit pas une adresse glissée dans un message
 * (`\`[ADMIN] ${user.email} …\``) ni une métadonnée nommée `user`. Pratique de
 * référence (Stripe, Datadog Sensitive Data Scanner) : un second filet, à la
 * SORTIE du logger, qui reconnaît les valeurs elles-mêmes.
 *
 * Règles volontairement PRÉCISES — un journal doit rester exploitable :
 *  · e-mail → `[email]` ;
 *  · téléphone E.164 (`+` puis 8 à 15 chiffres, le format stocké) → `[phone:…1234]` ;
 *  · JWT, `Bearer …`, `password=…` / `token: …` → masqués ;
 *  · numéro de carte (13 à 19 chiffres isolés) → `[card]`.
 * Les identifiants Mongo, montants, dates et codes HTTP ne sont PAS touchés
 * (la règle « téléphone » du suivi d'erreurs, sans borne, les aurait abîmés).
 *
 * Module PUR, sans dépendance — copie à l'identique du backend principal
 * (`paynoval-backend/utils/logRedaction.js`).
 */

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

const SECRET_ASSIGNMENT =
  /(["']?\b(?:password|passwd|pwd|passcode|pin|pincode|otp|otpCode|twoFaCode|securityAnswer|securityCode|validationCode|cvv|cvc|token|accessToken|refreshToken|idToken|secret|clientSecret|apiKey|api_key|authorization|cookie)\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi;

const RULES = Object.freeze([
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`],
  [SECRET_ASSIGNMENT, `$1${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[jwt]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/(?<![\w+])\+\d{8,15}(?!\d)/g, (m) => `[phone:…${m.slice(-4)}]`],
  // Card PAN: network prefix (2-6) AND a valid Luhn checksum, as card-data
  // scanners do — a 13-digit millisecond timestamp is not a card.
  [/(?<![\w-])[2-6](?:[ -]?\d){12,18}(?![\w-])/g, (m) => (luhnValid(m.replace(/\D/g, "")) ? "[card]" : m)],
]);

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactLogString(value) {
  let out = String(value ?? "");
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Masque récursivement les CHAÎNES d'une valeur (objets, tableaux, erreurs).
 * PURE : ne mute jamais l'entrée. Les références circulaires sont coupées.
 */
function redactLogValue(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === "string") return redactLogString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (value instanceof Error) {
    return { name: value.name, message: redactLogString(value.message), stack: redactLogString(value.stack) };
  }
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`;

  if (Array.isArray(value)) return value.map((v) => redactLogValue(v, depth + 1, seen));

  // Mongo ObjectId and similar: keep their string form.
  if (typeof value.toHexString === "function") return value.toHexString();

  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactLogValue(v, depth + 1, seen);
  return out;
}

/**
 * Second filet pour les `console.*`, qui contournent le logger : chaque
 * argument est masqué avant d'être écrit. Installé UNE fois, au démarrage du
 * processus (jamais dans les tests). Idempotent.
 */
const INSTALLED = Symbol.for("paynoval.consoleRedaction");

function installConsoleRedaction(target = console) {
  if (target[INSTALLED]) return false;

  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = function redactedConsole(...args) {
      return original.apply(this, args.map((a) => redactLogValue(a)));
    };
  }

  Object.defineProperty(target, INSTALLED, { value: true });
  return true;
}

const WINSTON_KEYS = new Set(["level", "timestamp", "service"]);

/**
 * Transformation d'un `info` winston (à envelopper par `format(...)`) : message,
 * pile et métadonnées masqués par CLÉ (`redactSensitive`) puis par VALEUR.
 */
function redactWinstonInfo(info, redactByKey = (v) => v) {
  if (typeof info.message === "string") info.message = redactLogString(info.message);
  if (typeof info.stack === "string") info.stack = redactLogString(info.stack);

  for (const key of Object.keys(info)) {
    if (WINSTON_KEYS.has(key) || key === "message" || key === "stack") continue;
    info[key] = redactLogValue(redactByKey({ [key]: info[key] })[key]);
  }
  return info;
}

module.exports = { REDACTED, redactLogString, redactLogValue, installConsoleRedaction, redactWinstonInfo };
