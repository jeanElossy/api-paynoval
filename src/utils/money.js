"use strict";

/**
 * ============================================================================
 * L'ARRONDI MONÉTAIRE — UNE SEULE DÉFINITION POUR TOUT LE SERVICE
 * ============================================================================
 *
 * ── Le défaut fermé le 2026-09-16 ───────────────────────────────────────────
 *
 * Ce service portait CINQ implémentations de `roundMoney` et SIX listes de
 * devises sans décimale. Ce n'était pas une simple duplication : elles
 * DIVERGEAIENT, de deux façons mesurées.
 *
 * **1. Deux méthodes d'arrondi différentes.**
 *
 *     `pricingEngine`, `feesController`, `pricingSnapshotNormalizer`
 *         → Math.round((n + Number.EPSILON) * p) / p
 *     `shared/helpers`, `config/cancellationFees`
 *         → Number(n.toFixed(2))
 *
 * Sur 1,005 la première rend **1,01**, la seconde **1,00** — parce que 1,005
 * n'existe pas exactement en binaire et que `toFixed` arrondit la valeur
 * réellement stockée (1,00499999…). Le devis et l'écriture comptable pouvaient
 * donc différer d'un centime sur le même montant, chacun ayant « raison ».
 *
 * **2. Des listes de devises différentes.**
 *
 *     moteur / normalisateur / frais    → XOF, XAF, JPY
 *     validation du devis               → XOF, XAF, JPY, KRW, CLP, VND, ISK
 *
 * Un montant en KRW était donc arrondi à deux décimales par le moteur, puis
 * contrôlé avec une tolérance d'UNE UNITÉ par le validateur : deux couches qui
 * ne parlaient pas de la même monnaie.
 *
 * ── Ce qui est retenu, et pourquoi ──────────────────────────────────────────
 *
 * · **La méthode du moteur** (`Math.round` + `Number.EPSILON`), parce que c'est
 *   elle qui FACTURE aujourd'hui : l'aligner sur l'autre aurait changé des prix
 *   sans que personne ne l'ait décidé. L'`EPSILON` corrige le cas où la
 *   multiplication décale la valeur juste sous la moitié.
 * · **La liste la plus complète**, parce qu'une devise oubliée produit un
 *   arrondi à deux décimales sur une monnaie qui n'en a pas — des centimes de
 *   won ou de dong qui n'existent pas.
 *
 * ── Ce que ce module N'EST PAS ──────────────────────────────────────────────
 *
 * Il ne fait pas de PayNoval un système à virgule flottante assumé : les
 * montants persistés restent des `Decimal128`. Il donne la règle d'arrondi
 * unique appliquée AU MOMENT de produire un montant présentable. Passer le
 * chemin du prix en unités mineures entières (le modèle Stripe) reste un
 * chantier à part, et il sera d'autant plus simple qu'il n'y aura qu'un seul
 * endroit à changer.
 *
 * Module **PUR** : aucune dépendance, aucun accès base ni réseau.
 */

/**
 * Devises sans sous-unité. Union de toutes les listes qui coexistaient.
 *
 * ⚠️ Toute devise ajoutée ici change des MONTANTS. Elle se vérifie contre la
 * norme ISO 4217, pas contre une intuition.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  // Franc CFA — les deux zones.
  "XOF",
  "XAF",
  // Afrique de l'Est et centrale.
  "GNF",
  "RWF",
  "UGX",
  "BIF",
  "KMF",
  // Hors zone franc.
  "JPY",
  "KRW",
  "CLP",
  "VND",
  "ISK",
]);

function normaliserCode(currency) {
  return String(currency || "").trim().toUpperCase();
}

/** Nombre de décimales d'une devise. Inconnue ⇒ 2, le cas majoritaire. */
function decimalsForCurrency(currency) {
  return ZERO_DECIMAL_CURRENCIES.has(normaliserCode(currency)) ? 0 : 2;
}

function currencyHasDecimals(currency) {
  return decimalsForCurrency(currency) === 2;
}

/**
 * Arrondit un montant à la précision de sa devise.
 *
 * Rend 0 sur une entrée illisible — et c'est un choix qui mérite d'être dit :
 * ce module est une FONCTION DE PRÉSENTATION, pas une frontière financière. Le
 * refus d'un montant absent ou illisible appartient aux frontières qui, elles,
 * échouent en fermeture (`utils/montant.js`, `pricingValidation.js`). Les y
 * dupliquer ici ferait lever des endroits qui n'ont pas à décider.
 */
function roundMoney(amount, currency = "CAD") {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;

  const p = 10 ** decimalsForCurrency(currency);
  return Math.round((n + Number.EPSILON) * p) / p;
}

/**
 * ============================================================================
 * LE TAUX RÉELLEMENT APPLIQUÉ — DÉDUIT, JAMAIS INVENTÉ
 * ============================================================================
 *
 * ── Le défaut fermé le 2026-09-16 ───────────────────────────────────────────
 *
 * Trois endroits du chemin d'annulation écrivaient `convertedRate || 1` : quand
 * le fournisseur de change rendait un montant converti mais pas de taux
 * lisible, on inscrivait **1 pour 1** dans un champ d'AUDIT.
 *
 * C'est un mensonge doublement gênant. D'abord parce qu'un taux de 1 est
 * plausible — il franchit tous les contrôles de « nombre fini et positif ».
 * Ensuite parce qu'il est ici manifestement FAUX : on venait justement de
 * convertir un montant entre deux devises différentes. La trace affirmait donc
 * le contraire de ce que la ligne d'à côté montrait.
 *
 * ── Pourquoi déduire, plutôt que refuser ────────────────────────────────────
 *
 * La règle B.2 dit qu'une donnée financière illisible arrête l'opération. Mais
 * refuser ici reviendrait à bloquer une ANNULATION, c'est-à-dire à retenir les
 * fonds d'un utilisateur qui demande à les libérer — le mal qu'on cherche à
 * éviter.
 *
 * Or il n'y a pas à choisir entre inventer et refuser : la conversion a réussi,
 * on détient le montant AVANT et le montant APRÈS. Le taux effectif n'est pas
 * une valeur à deviner, c'est un quotient. On l'écrit.
 *
 * @param {number} converti  Montant après conversion.
 * @param {number} base      Montant avant conversion.
 * @param {number} [annonce] Taux rendu par le fournisseur, s'il est lisible.
 * @returns {number|null} le taux, ou `null` si rien ne permet de l'établir.
 */
function tauxEffectif(converti, base, annonce) {
  const t = Number(annonce);
  if (Number.isFinite(t) && t > 0) return t;

  const apres = Number(converti);
  const avant = Number(base);

  if (!Number.isFinite(apres) || !Number.isFinite(avant) || avant <= 0) {
    /**
     * `null` et non 1 : « je ne sais pas » doit rester distinct de « un pour
     * un ». L'appelant décide quoi en faire — mais il ne peut plus le
     * confondre avec un taux réel.
     */
    return null;
  }

  return apres / avant;
}

module.exports = {
  ZERO_DECIMAL_CURRENCIES,
  decimalsForCurrency,
  currencyHasDecimals,
  roundMoney,
  tauxEffectif,
};
