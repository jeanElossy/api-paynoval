"use strict";

/**
 * ============================================================================
 * VALIDATION D'UN DEVIS DE TARIFICATION — LA FRONTIÈRE AVEC LA PASSERELLE
 * ============================================================================
 *
 * CE QUE CE MODULE CORRIGE
 * ------------------------
 * TX Core ne calcule pas les prix : il les DEMANDE à la passerelle, qui en est
 * la seule source de vérité. C'est la bonne architecture — mais la frontière
 * entre les deux services **échouait en ouverture sur chaque champ** :
 *
 *     const fee = roundMoney(toFloat(result?.fee, 0), fromCurrency);
 *     const netTo = Number.isFinite(rawNetTo) ? roundMoney(...) : 0;
 *     const appliedRate = toFloat(result?.appliedRate, 0);
 *     const fromCurrency = pickCurrency(…, "CAD");
 *
 * Une réponse incomplète ne produisait donc aucune erreur : elle produisait un
 * virement. Frais à 0 (PayNoval ne gagne rien, et personne n'est prévenu),
 * montant reçu à 0, taux enregistré à 0 — et, pour la devise, un repli en dur
 * sur le dollar canadien, c'est-à-dire un virement libellé dans une monnaie que
 * personne n'a demandée.
 *
 * ⚠️ CE N'EST PAS UN DÉFAUT ACTIF AUJOURD'HUI. Le moteur de la passerelle est
 * rigoureux : il lève sur un taux invalide et remplit toujours les six champs.
 * Le fail-open se déclencherait sur une réponse partielle, un renommage de
 * champ lors d'une évolution, un intermédiaire qui altère le corps, ou un devis
 * verrouillé relu depuis la base dans une forme plus ancienne.
 *
 * C'est exactement la classe de défaut déjà corrigée sur les rails prestataire
 * (`providers/providerMode.js`) : **un chemin de l'argent qui se dégrade en
 * silence au lieu de refuser.** Un devis qu'on ne sait pas lire n'est pas un
 * devis à zéro : c'est une absence de devis.
 *
 * CE QUI RESTE LÉGITIMEMENT ABSENT OU NUL — ET POURQUOI ON NE L'EXIGE PAS
 * ----------------------------------------------------------------------
 *   - `fee: 0` est un vrai prix. Un corridor sans frais existe. C'est pourquoi
 *     ce module distingue « absent » de « zéro », ce que `toFloat(x, 0)` était
 *     par construction incapable de faire.
 *   - `marketRate: null` est un vrai cas : quand une règle impose un taux
 *     (`fx.overrideRate`), il n'y a pas de taux de marché à citer. L'exiger
 *     casserait tous les corridors à taux imposé.
 */

/**
 * ⚠️ Liste déléguée à `utils/money` depuis le 2026-09-16.
 *
 * Elle comptait sept devises quand le moteur de tarification en connaissait
 * trois : un montant en franc guinéen était arrondi au centime par le moteur,
 * puis contrôlé ici avec une tolérance d'une unité. Deux couches qui ne
 * parlaient pas de la même monnaie ne peuvent pas se vérifier l'une l'autre.
 *
 * `utils/money` est PUR — aucune base, aucun réseau : ce module le reste.
 */
const {
  ZERO_DECIMAL_CURRENCIES: ZERO_DECIMAL,
  decimalsForCurrency: decimalsFor,
} = require("../../../utils/money");

/**
 * Tolérance de cohérence : UNE unité minimale de la devise.
 *
 * Elle n'est pas arbitraire. La passerelle arrondit CHAQUE champ séparément
 * (`grossFrom`, `fee`, `netFrom`, `netTo`), donc `netFrom` peut légitimement
 * différer de `grossFrom - fee` du dernier centime — ou du dernier franc en
 * XOF, où l'arrondi est à l'unité. Une tolérance plus serrée ferait échouer des
 * devis parfaitement corrects ; plus large, elle laisserait passer une vraie
 * erreur de calcul.
 */
function toleranceFor(currency) {
  return decimalsFor(currency) === 0 ? 1 : 0.01;
}

/**
 * Lit un nombre SANS jamais inventer de valeur de repli.
 *
 * C'est toute la différence avec `toFloat(value, 0)` : ici, « absent » et
 * « zéro » sont deux réponses distinctes. Sur un chemin financier, les
 * confondre revient à facturer zéro parce qu'on n'a pas su lire le prix.
 *
 * @returns {number|null} `null` si la valeur est absente ou illisible.
 */
function readNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  const n = typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Un code ISO, ou rien. Jamais une devise devinée. */
function readCurrency(...values) {
  for (const value of values) {
    const code = String(value || "").trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(code)) return code;
  }
  return null;
}

const FIELDS = Object.freeze({
  GROSS: "result.grossFrom",
  FEE: "result.fee",
  NET_FROM: "result.netFrom",
  NET_TO: "result.netTo",
  RATE: "result.appliedRate",
  FROM_CURRENCY: "request.fromCurrency",
  TO_CURRENCY: "request.toCurrency",
});

/**
 * Le devis est-il exploitable ?
 *
 * Pure : ni horloge, ni base, ni réseau. Rend TOUTES les erreurs et pas
 * seulement la première — un message qui ne cite qu'un champ sur quatre fait
 * corriger la configuration en quatre allers-retours.
 *
 * @param {object} payload  Réponse de la passerelle (`{request, result}`).
 * @param {object} input    Entrée envoyée, pour les devises de repli.
 * @returns {{ok: boolean, errors: string[], values: object|null}}
 */
function validatePricingQuote(payload, input) {
  /**
   * ⚠️ LES VALEURS PAR DÉFAUT DE PARAMÈTRE NE COUVRENT PAS `null`.
   *
   * `function f(input = {})` ne s'applique qu'à `undefined`. Un appel avec
   * `null` — ce que rend une réponse HTTP au corps vide — passait donc `null`
   * tel quel, et la première lecture levait un `TypeError`. Un validateur qui
   * lève sur une entrée aberrante ne valide plus rien : il doit répondre
   * « inexploitable », c'est précisément son travail.
   */
  const source = payload && typeof payload === "object" ? payload : {};
  const entree = input && typeof input === "object" ? input : {};

  const result = source.result || {};
  const request = source.request || {};
  const errors = [];

  /* ----------------------------------------------------------- devises */
  /**
   * Les devises peuvent venir de l'entrée : c'est NOUS qui les avons
   * demandées, elles ne sont pas une invention. Ce qui est interdit, c'est le
   * repli en dur sur une devise que personne n'a nommée.
   */
  const fromCurrency = readCurrency(
    request.fromCurrency,
    request.currency,
    entree.fromCurrency,
    entree.currency
  );

  const toCurrency = readCurrency(request.toCurrency, entree.toCurrency) || fromCurrency;

  if (!fromCurrency) errors.push(`${FIELDS.FROM_CURRENCY} absente ou non ISO`);
  if (!toCurrency) errors.push(`${FIELDS.TO_CURRENCY} absente ou non ISO`);

  /* ----------------------------------------------------------- montants */
  const grossFrom = readNumber(result.grossFrom);
  const fee = readNumber(result.fee);
  const netFrom = readNumber(result.netFrom);
  const netTo = readNumber(result.netTo);
  const appliedRate = readNumber(result.appliedRate);

  if (grossFrom === null) errors.push(`${FIELDS.GROSS} absent`);
  else if (grossFrom <= 0) errors.push(`${FIELDS.GROSS} doit être strictement positif`);

  // Zéro est un prix valide ; négatif ne l'est pas.
  if (fee === null) errors.push(`${FIELDS.FEE} absent`);
  else if (fee < 0) errors.push(`${FIELDS.FEE} négatif`);

  if (netFrom === null) errors.push(`${FIELDS.NET_FROM} absent`);
  else if (netFrom < 0) errors.push(`${FIELDS.NET_FROM} négatif`);

  if (netTo === null) errors.push(`${FIELDS.NET_TO} absent`);
  else if (netTo <= 0) errors.push(`${FIELDS.NET_TO} doit être strictement positif`);

  if (appliedRate === null) errors.push(`${FIELDS.RATE} absent`);
  else if (appliedRate <= 0) errors.push(`${FIELDS.RATE} doit être strictement positif`);

  /* --------------------------------------------------------- cohérence */
  /**
   * ⚠️ L'ARITHMÉTIQUE DU DEVIS SE VÉRIFIE, ELLE NE SE SUPPOSE PAS.
   *
   * Même esprit que la balance de vérification du grand livre : on ne contrôle
   * pas que les champs existent, on contrôle qu'ils racontent la même
   * histoire. Un devis interne­ment incohérent signale un défaut de calcul chez
   * l'émetteur — et il vaut mieux refuser un virement que d'en exécuter un dont
   * les montants ne s'additionnent pas.
   */
  if (grossFrom !== null && fee !== null && netFrom !== null) {
    const attendu = grossFrom - fee;
    if (Math.abs(netFrom - attendu) > toleranceFor(fromCurrency)) {
      errors.push(
        `incohérence : netFrom=${netFrom} ≠ grossFrom-fee=${attendu} (${fromCurrency})`
      );
    }
  }

  if (netFrom !== null && netTo !== null && appliedRate !== null && netFrom > 0) {
    const attendu = netFrom * appliedRate;
    if (Math.abs(netTo - attendu) > toleranceFor(toCurrency)) {
      errors.push(
        `incohérence : netTo=${netTo} ≠ netFrom×appliedRate=${attendu} (${toCurrency})`
      );
    }
  }

  if (errors.length) return { ok: false, errors, values: null };

  return {
    ok: true,
    errors: [],
    values: { fromCurrency, toCurrency, grossFrom, fee, netFrom, netTo, appliedRate },
  };
}

module.exports = {
  FIELDS,
  ZERO_DECIMAL,
  decimalsFor,
  toleranceFor,
  readNumber,
  readCurrency,
  validatePricingQuote,
};
