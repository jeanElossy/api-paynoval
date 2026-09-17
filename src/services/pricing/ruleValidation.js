"use strict";

/**
 * Validation d'un barème proposé — déplacé depuis l'API Gateway le 2026-09-10.
 *
 * Le domaine des prix appartenait à la passerelle, qui le servait à Tx-Core en
 * HTTP : le moteur d'argent dépendait donc du bord, et une panne de la
 * passerelle arrêtait les virements de l'intérieur. Les dépendances descendent
 * — bord → services → moteur, jamais l'inverse. C'est la règle que tiennent
 * Stripe, PayPal et Adyen, et la raison pour laquelle leur passerelle ne
 * possède aucun domaine et ne détient aucune base.
 * */
/**
 * VALIDATION MÉTIER D'UNE RÈGLE TARIFAIRE PROPOSÉE
 * -----------------------------------------------------------------------------
 * Ces règles n'existaient que dans le navigateur (`FXMarginRules.validate`).
 * Le serveur n'exigeait que `name` + les deux devises : un appel direct passait
 * outre. Elles sont désormais portées ici, et le navigateur n'en garde qu'un
 * miroir de confort. Toute divergence entre les deux est un bug côté navigateur.
 *
 * Fonction pure : aucun accès base, aucun accès réseau, testable seule.
 */

const { borne, validateFxModeShape } = require("./fxModes");

const FEE_MODES = ["NONE", "FIXED", "PERCENT", "MIXED"];
const FX_MODES = [
  "PASS_THROUGH",
  "OVERRIDE",
  "MARKUP_PERCENT",
  "DELTA_PERCENT",
  "DELTA_ABS",
];

/**
 * ============================================================================
 * LES BORNES — CE QUI SÉPARE UN TARIF D'UNE FAUTE DE FRAPPE
 * ============================================================================
 *
 * Jusqu'au 2026-09-16, ce module contrôlait les FORMES et les cohérences, mais
 * aucun ordre de grandeur. Quatre saisies passaient donc l'approbation :
 *
 *   · une marge NÉGATIVE — le client obtient mieux que le marché, PayNoval perd
 *     de l'argent sur chaque opération, en silence ;
 *   · une marge ≥ 100 % — le taux appliqué devient nul ou négatif, et le défaut
 *     n'apparaît qu'au premier DEVIS, en erreur 500, barème déjà publié ;
 *   · un pourcentage de frais aberrant (150 %) — chaque cotation échoue sur
 *     « les frais dépassent le montant », après publication ;
 *   · un montant fixe négatif — des « frais » qui créditent l'expéditeur.
 *
 * Le point commun : le refus arrivait APRÈS la publication, ou jamais. Une
 * borne franchie doit être refusée au moment de l'approbation, quand un humain
 * regarde encore.
 *
 * ── Ce que ces bornes ne prétendent pas faire ───────────────────────────────
 *
 * Elles ne remplacent pas le jugement : 9 % de marge est accepté ici, et serait
 * sans doute une erreur commerciale. Elles arrêtent l'accident, pas la
 * mauvaise décision.
 *
 * Deux contrôles demandent le taux du marché : un `overrideRate` mal saisi
 * (655,957 au lieu de 0,001524) et l'échelle d'un `DELTA_ABS`. Ils ne sont plus
 * laissés au seul aperçu du back-office depuis le 2026-09-16 :
 * `fxModes.assertFxWithinMarket` les juge au dépôt ET à l'approbation. Ce
 * module-ci garde ce qui se décide sans marché (`fxModes.validateFxModeShape`).
 *
 * Les bornes se lisent par `fxModes.borne` : une variable illisible rendait
 * `NaN`, et toute comparaison à `NaN` est fausse — la borne disparaissait sans
 * bruit.
 */
const BORNES = Object.freeze({
  /** Frais en pourcentage du montant. */
  FEE_PERCENT_MAX: borne("PRICING_FEE_PERCENT_MAX", 20),

  /** Marge de change prise par PayNoval sur le taux de marché. */
  FX_MARKUP_PERCENT_MAX: borne("PRICING_FX_MARKUP_PERCENT_MAX", 10),

  /** Ajustement relatif au marché — vers le bas seulement (`fxModes`). */
  FX_DELTA_PERCENT_ABS_MAX: borne("PRICING_FX_DELTA_PERCENT_MAX", 10),
});

const upper = (v) => String(v ?? "").trim().toUpperCase();
const lower = (v) => String(v ?? "").trim().toLowerCase();

/** `null` et `""` ne sont pas des zéros : un champ vide reste vide. */
function num(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isIsoCurrency(value) {
  return /^[A-Z]{3,4}$/.test(upper(value));
}

function toTime(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

const fail = (message) => ({ ok: false, message });

/**
 * @param {object} proposed
 * @returns {{ok: true} | {ok: false, message: string}}
 */
function validateProposedRule(proposed) {
  if (!proposed || typeof proposed !== "object") {
    return fail("La règle proposée est vide.");
  }

  const scope = proposed.scope || {};
  const fee = proposed.fee || {};
  const fx = proposed.fx || {};
  const amountRange = proposed.amountRange || {};

  if (!String(proposed.name ?? "").trim()) {
    return fail("Le nom de la règle est obligatoire.");
  }

  if (!isIsoCurrency(scope.fromCurrency)) {
    return fail("La devise source doit être un code ISO (EUR, XOF, XAF, CAD, USD…).");
  }

  if (!isIsoCurrency(scope.toCurrency)) {
    return fail("La devise destination doit être un code ISO (EUR, XOF, XAF, CAD, USD…).");
  }

  // Volontairement PAS de refus quand les deux devises sont identiques :
  // un transfert PayNoval → PayNoval en XOF → XOF est le cas le plus courant.

  if (upper(scope.method) === "INTERNAL" && lower(scope.provider) !== "paynoval") {
    return fail("Pour la méthode « PayNoval interne », le fournisseur doit être « paynoval ».");
  }

  const feeMode = upper(fee.mode) || "NONE";
  if (!FEE_MODES.includes(feeMode)) {
    return fail(`Mode de frais inconnu : ${feeMode}.`);
  }

  if ((feeMode === "PERCENT" || feeMode === "MIXED") && num(fee.percent) === null) {
    return fail("Un mode de frais en pourcentage exige un pourcentage.");
  }

  if ((feeMode === "FIXED" || feeMode === "MIXED") && num(fee.fixed) === null) {
    return fail("Un mode de frais avec part fixe exige un montant fixe.");
  }

  const feePercent = num(fee.percent);
  const feeFixed = num(fee.fixed);

  if (feePercent !== null && feePercent < 0) {
    return fail("Des frais en pourcentage ne peuvent pas être négatifs.");
  }

  if (feePercent !== null && feePercent > BORNES.FEE_PERCENT_MAX) {
    return fail(
      `Des frais de ${feePercent} % dépassent la borne de ${BORNES.FEE_PERCENT_MAX} %. ` +
        "Si le tarif est voulu, relevez la borne explicitement."
    );
  }

  if (feeFixed !== null && feeFixed < 0) {
    return fail(
      "Un montant fixe négatif ne serait pas des frais : il créditerait l'expéditeur."
    );
  }

  const minFee = num(fee.minFee);
  const maxFee = num(fee.maxFee);

  if (minFee !== null && minFee < 0) {
    return fail("Les frais minimum ne peuvent pas être négatifs.");
  }

  if (maxFee !== null && maxFee < 0) {
    return fail("Les frais maximum ne peuvent pas être négatifs.");
  }

  if (minFee !== null && maxFee !== null && minFee > maxFee) {
    return fail("Les frais minimum ne peuvent pas dépasser les frais maximum.");
  }

  const min = num(amountRange.min);
  const max = num(amountRange.max);
  if (min !== null && max !== null && min > max) {
    return fail("La tranche de montant est inversée : le minimum dépasse le maximum.");
  }

  const fxMode = upper(fx.mode) || "PASS_THROUGH";
  if (!FX_MODES.includes(fxMode)) {
    return fail(`Stratégie de change inconnue : ${fxMode}.`);
  }

  if (fxMode === "OVERRIDE" && !(num(fx.overrideRate) > 0)) {
    return fail("Le mode « Taux imposé » exige un taux strictement positif.");
  }

  if (fxMode === "MARKUP_PERCENT") {
    const marge = num(fx.markupPercent);

    if (marge === null) {
      return fail("Le mode « Marge plateforme » exige une marge en pourcentage.");
    }

    if (marge < 0) {
      return fail(
        "Une marge négative donnerait au client un taux MEILLEUR que le marché : " +
          "PayNoval perdrait de l'argent sur chaque opération du corridor."
      );
    }

    /**
     * Le taux appliqué vaut `marché × (1 − marge/100)`. À 100 %, il tombe à
     * zéro ; au-delà, il devient négatif. Le moteur le refuserait — mais en
     * erreur 500, au premier devis, barème déjà publié.
     */
    if (marge >= 100) {
      return fail(
        "Une marge de 100 % ou plus annulerait le taux appliqué : le " +
          "bénéficiaire ne recevrait rien."
      );
    }

    if (marge > BORNES.FX_MARKUP_PERCENT_MAX) {
      return fail(
        `Une marge de ${marge} % dépasse la borne de ${BORNES.FX_MARKUP_PERCENT_MAX} %. ` +
          "Si elle est voulue, relevez la borne explicitement."
      );
    }
  }

  if (fxMode === "DELTA_PERCENT") {
    const ajustement = num(fx.percent);

    if (ajustement === null) {
      return fail("Le mode « Ajustement (%) » exige une valeur d'ajustement.");
    }

    if (ajustement <= -100) {
      return fail(
        "Un ajustement de −100 % ou moins annulerait le taux appliqué."
      );
    }

    if (Math.abs(ajustement) > BORNES.FX_DELTA_PERCENT_ABS_MAX) {
      return fail(
        `Un ajustement de ${ajustement} % s'écarte du marché de plus de ` +
          `${BORNES.FX_DELTA_PERCENT_ABS_MAX} %. Si c'est voulu, relevez la borne explicitement.`
      );
    }
  }

  if (fxMode === "DELTA_ABS") {
    const delta = num(fx.deltaAbs);

    if (delta === null) {
      return fail("Le mode « Ajustement (valeur absolue) » exige une valeur.");
    }

    /**
     * Aucune borne numérique ici : un delta se juge à l'échelle du corridor
     * (0,01 sur EUR→USD, 10 sur EUR→XOF). Le prétendre bornable produirait
     * soit des refus absurdes, soit une borne si large qu'elle ne protège de
     * rien. L'aperçu chiffré du back-office est le contrôle qui vaut ici.
     */
  }

  if (fxMode === "PASS_THROUGH" && (num(fx.markupPercent) || 0) > 0) {
    return fail(
      "Une marge est saisie alors que le mode retenu applique le taux du marché sans marge : choisissez « Marge plateforme (%) »."
    );
  }

  const formeChange = validateFxModeShape(proposed);
  if (!formeChange.ok) {
    return fail(formeChange.message);
  }

  const startsAt = toTime(proposed.startsAt);
  const endsAt = toTime(proposed.endsAt);
  if (startsAt !== null && endsAt !== null && endsAt < startsAt) {
    return fail("La date de fin ne peut pas précéder la date de début.");
  }

  return { ok: true };
}

module.exports = { validateProposedRule, FEE_MODES, FX_MODES };
