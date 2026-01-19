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
