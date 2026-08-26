"use strict";

/**
 * ============================================================================
 * NORMALISATION DES IDENTIFIANTS DE LISTE NOIRE — UNE SEULE DÉFINITION
 * ============================================================================
 *
 * Ces fonctions vivaient dans `middleware/aml.js`. Les recopier dans le magasin
 * de liste noire aurait créé deux définitions du mot « identique » — et une
 * liste noire n'a de valeur que si CELUI QUI INSCRIT et CELUI QUI COMPARE
 * normalisent pareil.
 *
 * Le scénario concret : un opérateur inscrit `Ada@Paynoval.COM`, le contrôle
 * compare `ada@paynoval.com`. Si les deux normalisations divergent d'un
 * caractère, l'inscription ne bloque rien — et personne ne s'en aperçoit, parce
 * qu'une liste noire qui ne bloque pas ressemble en tout point à une liste noire
 * vide.
 */

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeIban(value) {
  // Les espaces de présentation d'un IBAN ne font pas partie de l'identifiant.
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

function normalizePhone(value) {
  // On conserve le `+` : il distingue le format international du national.
  return String(value || "").trim().replace(/[^\d+]/g, "");
}

function normalizeName(value) {
  /**
   * Décomposition Unicode puis retrait des diacritiques : « Müller » et
   * « Muller » désignent la même personne sur une liste de sanctions, et un
   * fraudeur n'aurait qu'à retirer un tréma pour passer.
   */
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

function normalizeCountry(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeUserId(value) {
  return String(value || "").trim();
}

/** Types de liste noire, et le normaliseur qui fait autorité pour chacun. */
const NORMALIZERS = Object.freeze({
  email: normalizeEmail,
  iban: normalizeIban,
  phone: normalizePhone,
  name: normalizeName,
  country: normalizeCountry,
  userId: normalizeUserId,
});

const TYPES = Object.freeze(Object.keys(NORMALIZERS));

/**
 * @returns {string} valeur normalisée, ou `""` si le type est inconnu.
 *   Rendre `""` plutôt que la valeur brute est délibéré : une valeur non
 *   normalisée inscrite en base ne serait jamais retrouvée, donc autant refuser
 *   l'inscription que créer une entrée qui ne protège de rien.
 */
function normalizeFor(type, value) {
  const fn = NORMALIZERS[String(type || "").trim()];
  return fn ? fn(value) : "";
}

module.exports = {
  TYPES,
  NORMALIZERS,
  normalizeFor,
  normalizeEmail,
  normalizeIban,
  normalizePhone,
  normalizeName,
  normalizeCountry,
  normalizeUserId,
};
