"use strict";

/**
 * Normalise devise -> ISO (EUR, USD, CAD, XOF, XAF, GBP...)
 * - symboles: €, $, £
 * - CFA: "F CFA" / "FCFA" / "CFA" -> XOF ou XAF (selon countryHint)
 * - "$CAD", "CAD$", "USD$" -> CAD / USD
 */
function normalizeCurrency(input, countryHint = "") {
  if (!input) return "";

  const raw = String(input).trim().toUpperCase();
  const compact = raw.replace(/\s+/g, "");
  const lettersOnly = raw.replace(/[^A-Z]/g, "");

  const KNOWN_ISO = ["EUR", "USD", "CAD", "XOF", "XAF", "GBP"];

  const normCountry = String(countryHint || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  const isCentralAfrica =
    normCountry.includes("cameroun") ||
    normCountry.includes("cameroon") ||
    normCountry.includes("gabon") ||
    normCountry.includes("tchad") ||
    normCountry.includes("chad") ||
    normCountry.includes("congo") ||
    normCountry.includes("guinee equatoriale") ||
    normCountry.includes("equatorial guinea") ||
    normCountry.includes("centrafrique") ||
    normCountry.includes("central african") ||
    normCountry.includes("republique centrafricaine");

  // CFA
  const cfaKeywords = ["F CFA", "FCFA", "F.CFA", "FRANC CFA", "FRANCS CFA", "CFA"];
  if (cfaKeywords.includes(raw) || cfaKeywords.includes(compact)) {
    return isCentralAfrica ? "XAF" : "XOF";
  }

  // ISO direct
  if (KNOWN_ISO.includes(raw)) return raw;

  // "$CAD", "CAD$", "USD$"
  if (lettersOnly.length === 3 && KNOWN_ISO.includes(lettersOnly)) return lettersOnly;

  // symboles simples
  if (raw === "€") return "EUR";
  if (raw === "£") return "GBP";
  if (raw === "$") return "USD"; // défaut

  // fallback
  if (/^[A-Z]{3}$/.test(raw)) return raw;
  return lettersOnly || compact;
}

function normCur(v, countryHint = "") {
  const out = normalizeCurrency(v, countryHint);
  const s = out ? String(out).trim().toUpperCase() : "";
  return s || null;
}

module.exports = { normalizeCurrency, normCur };

/**
 * ============================================================================
 * DEVISE DE COMPTE — LA SEULE NORMALISATION QUI FAIT FOI POUR L'ARGENT
 * ============================================================================
 *
 * ── Le défaut qu'elle corrige ────────────────────────────────────────────────
 * Il existait **trois** normalisations de devise dans ce service, et elles ne
 * s'accordaient pas :
 *
 *   1. `normalizeCurrency` ci-dessus — riche, tolérante, dépendante du pays
 *      (CFA → XOF **ou** XAF selon `countryHint`) ;
 *   2. `TxWalletBalance.normCurrency` — traduisait `FCFA`/`CFA` → `XOF` ;
 *   3. `ledgerService.normalizeCurrency` — **majusculait, et rien de plus**.
 *
 * Conséquence, constatée le 2026-08-28 : un appel en `FCFA` créait un
 * portefeuille en **XOF** et des écritures de grand livre sur
 * `user_wallet:<id>:**FCFA**`. Deux comptes pour un seul argent, dont un que
 * plus aucun contrôle ne réconcilie — le portefeuille et sa projection
 * comptable cessaient silencieusement de parler de la même chose.
 *
 * L'invariant 2 dit que le grand livre fait foi et que le solde en est une
 * projection. Une projection qui ne porte pas le même nom de compte que sa
 * source n'est pas une projection.
 *
 * ── Pourquoi une fonction séparée, et pas `normalizeCurrency` ci-dessus ─────
 * Parce qu'elles ne répondent pas à la même question. Celle du dessus sert à
 * INTERPRÉTER une saisie humaine (« F CFA », « $ », un indice de pays) et rend
 * `""` quand elle ne sait pas. Celle-ci désigne un **compte**, et une devise de
 * compte illisible doit ARRÊTER l'opération (règle B.2) : un repli produirait un
 * mouvement d'argent sur le mauvais compte.
 *
 * Elle est donc volontairement **stricte et sans indice de pays** : le même
 * texte rend toujours le même code, quel que soit l'appelant. Une ambiguïté
 * `XOF`/`XAF` se tranche EN AMONT, à la saisie, pas au moment d'écrire.
 *
 * ⚠️ `TxWalletBalance.js` et `ledgerService.js` l'appellent tous les deux. Ne
 * pas réintroduire une normalisation locale dans l'un des deux : c'est
 * exactement ce qui a produit le défaut.
 */
const ALIAS_DEVISE_COMPTE = Object.freeze({
  FCFA: "XOF",
  CFA: "XOF",
  "F CFA": "XOF",
  "$CAD": "CAD",
  "CAD$": "CAD",
  "$USD": "USD",
  "USD$": "USD",
});

function normalizeAccountCurrency(value) {
  const brut = String(value ?? "").trim().toUpperCase();

  if (!brut) {
    throw new Error(
      "Devise absente pour une opération de compte. Aucune valeur par défaut " +
        "n'est appliquée : un repli ferait porter l'opération au mauvais compte " +
        "sans qu'aucune erreur ne le signale."
    );
  }

  const code = ALIAS_DEVISE_COMPTE[brut] || brut;

  if (!/^[A-Z]{3,6}$/.test(code)) {
    throw new Error(
      `Devise de compte invalide : « ${value} ». Attendu un code ISO de 3 à 6 ` +
        "lettres, ou un alias connu (" +
        Object.keys(ALIAS_DEVISE_COMPTE).join(", ") +
        ")."
    );
  }

  return code;
}

module.exports.normalizeAccountCurrency = normalizeAccountCurrency;
module.exports.ALIAS_DEVISE_COMPTE = ALIAS_DEVISE_COMPTE;

