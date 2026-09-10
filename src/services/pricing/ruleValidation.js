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

const FEE_MODES = ["NONE", "FIXED", "PERCENT", "MIXED"];
const FX_MODES = [
  "PASS_THROUGH",
  "OVERRIDE",
  "MARKUP_PERCENT",
  "DELTA_PERCENT",
  "DELTA_ABS",
];

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

  const minFee = num(fee.minFee);
  const maxFee = num(fee.maxFee);
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

  if (fxMode === "MARKUP_PERCENT" && num(fx.markupPercent) === null) {
    return fail("Le mode « Marge plateforme » exige une marge en pourcentage.");
  }

  if (fxMode === "DELTA_PERCENT" && num(fx.percent) === null) {
    return fail("Le mode « Ajustement (%) » exige une valeur d'ajustement.");
  }

  if (fxMode === "DELTA_ABS" && num(fx.deltaAbs) === null) {
    return fail("Le mode « Ajustement (valeur absolue) » exige une valeur.");
  }

  if (fxMode === "PASS_THROUGH" && (num(fx.markupPercent) || 0) > 0) {
    return fail(
      "Une marge est saisie alors que le mode retenu applique le taux du marché sans marge : choisissez « Marge plateforme (%) »."
    );
  }

  const startsAt = toTime(proposed.startsAt);
  const endsAt = toTime(proposed.endsAt);
  if (startsAt !== null && endsAt !== null && endsAt < startsAt) {
    return fail("La date de fin ne peut pas précéder la date de début.");
  }

  return { ok: true };
}

module.exports = { validateProposedRule, FEE_MODES, FX_MODES };
