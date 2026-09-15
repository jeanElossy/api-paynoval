"use strict";

/**
 * ============================================================================
 * DEVISES DE CAGNOTTE — UNE SEULE LISTE, CONFIGURABLE, QUI ÉCHOUE EN FERMETURE
 * ============================================================================
 *
 * Une cagnotte est tenue dans la devise de son propriétaire, et une
 * participation peut venir de n'importe quelle devise supportée : la matrice
 * des corridors (A→A, A→B, B→A) se DÉRIVE de cette liste, elle ne se code pas
 * en dur. Ajouter une devise, c'est poser `CAGNOTTE_SUPPORTED_CURRENCIES` —
 * aucune ligne de code métier ne connaît « CAD → XOF ».
 *
 * Module pur : aucune entrée-sortie, testable sans base.
 */

/** Devises activées par défaut — alignées sur `Vault.ALLOWED_CURRENCIES` du backend. */
const DEFAULT_CAGNOTTE_CURRENCIES = Object.freeze([
  "XOF",
  "XAF",
  "CAD",
  "USD",
  "EUR",
  "GBP",
]);

const ISO_4217 = /^[A-Z]{3}$/;

function cagnotteCurrencyError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.code = code;
  if (details) err.details = details;
  return err;
}

/**
 * Liste effective. Une variable mal formée LÈVE : un repli silencieux sur la
 * liste par défaut ferait accepter une devise que l'exploitation croit avoir
 * retirée (règle B.2).
 */
function supportedCagnotteCurrencies(env = process.env) {
  const raw = String(env?.CAGNOTTE_SUPPORTED_CURRENCIES || "").trim();

  if (!raw) return DEFAULT_CAGNOTTE_CURRENCIES.slice();

  const list = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const invalid = list.filter((c) => !ISO_4217.test(c));

  if (!list.length || invalid.length) {
    throw cagnotteCurrencyError(
      500,
      "CAGNOTTE_CURRENCIES_MISCONFIGURED",
      `CAGNOTTE_SUPPORTED_CURRENCIES illisible (« ${raw} »). Attendu : codes ` +
        "ISO 4217 séparés par des virgules. Aucune liste par défaut n'est " +
        "substituée à une configuration fausse.",
      { invalid }
    );
  }

  return Array.from(new Set(list));
}

function normalizeCagnotteCurrency(value) {
  return String(value ?? "").trim().toUpperCase();
}

function isSupportedCagnotteCurrency(value, env = process.env) {
  const code = normalizeCagnotteCurrency(value);
  return ISO_4217.test(code) && supportedCagnotteCurrencies(env).includes(code);
}

/**
 * Rend le code normalisé, ou LÈVE `CURRENCY_NOT_SUPPORTED` (422). Aucune
 * normalisation « intelligente » (`FCFA`, `$CAD`…) : une devise de cagnotte
 * est déjà un code ISO propre, lu en base ; tout le reste est une anomalie.
 */
function assertSupportedCagnotteCurrency(value, env = process.env, label = "devise") {
  const code = normalizeCagnotteCurrency(value);

  if (!ISO_4217.test(code)) {
    throw cagnotteCurrencyError(
      422,
      "CURRENCY_NOT_SUPPORTED",
      `${label} illisible : « ${value} ». Attendu un code ISO 4217.`
    );
  }

  const supported = supportedCagnotteCurrencies(env);

  if (!supported.includes(code)) {
    throw cagnotteCurrencyError(
      422,
      "CURRENCY_NOT_SUPPORTED",
      `${label} ${code} non activée pour les cagnottes.`,
      { supported }
    );
  }

  return code;
}

/**
 * Tous les corridors d'une liste de devises, y compris A→A.
 * @returns {Array<{from: string, to: string, fxRequired: boolean}>}
 */
function cagnotteCurrencyMatrix(currencies = supportedCagnotteCurrencies()) {
  const out = [];

  for (const from of currencies) {
    for (const to of currencies) {
      out.push({ from, to, fxRequired: from !== to });
    }
  }

  return out;
}

module.exports = {
  DEFAULT_CAGNOTTE_CURRENCIES,
  supportedCagnotteCurrencies,
  normalizeCagnotteCurrency,
  isSupportedCagnotteCurrency,
  assertSupportedCagnotteCurrency,
  cagnotteCurrencyMatrix,
  cagnotteCurrencyError,
};
