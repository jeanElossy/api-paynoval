"use strict";

/**
 * ============================================================================
 * SCÉNARIOS DE SIMULATION — CE QUE « RÉPOND » LE PRESTATAIRE FICTIF
 * ============================================================================
 *
 * Le compte sandbox choisit, depuis l'application, l'issue de ses prochaines
 * opérations prestataire : succès, échec, en attente, fonds insuffisants, et le
 * délai de confirmation. C'est le principe des cartes et numéros de test de
 * Stripe et d'Adyen (une carte qui échoue toujours, un 3DS à valider), rendu
 * pilotable sans changer de moyen de paiement — le monteur filme les cas
 * d'erreur sans intervention de l'équipe.
 *
 * Module PUR : aucune base, aucun réseau. Il décide ; `sandboxAdapters` et
 * `services/sandbox/` exécutent.
 *
 * ⚠️ Ce module ne décide QUE de la réponse du prestataire. Il ne touche jamais
 * aux contrôles du moteur : un « solde insuffisant » du portefeuille PayNoval
 * se produit par le VRAI contrôle de solde (le robinet « vider le solde »
 * l'amène), jamais par une condition ajoutée au moteur.
 */

const SANDBOX_OUTCOMES = Object.freeze({
  SUCCESS: "success",
  FAILURE: "failure",
  PENDING: "pending",
  INSUFFICIENT_FUNDS: "insufficient_funds",
});

const OUTCOME_VALUES = Object.freeze(Object.values(SANDBOX_OUTCOMES));

/** Délai de confirmation, en secondes. Borné : un tournage, pas un test de charge. */
const DELAY_BOUNDS = Object.freeze({ min: 0, max: 120 });

const DEFAULT_SCENARIO = Object.freeze({
  outcome: SANDBOX_OUTCOMES.SUCCESS,
  confirmationDelaySeconds: 3,
});

function scenarioError(message) {
  const err = new Error(message);
  err.code = "INVALID_SANDBOX_SCENARIO";
  err.status = 400;
  err.statusCode = 400;
  return err;
}

/**
 * Valide un scénario. Rien n'est deviné : une issue inconnue ou un délai hors
 * bornes est REFUSÉ, pas ramené à une valeur par défaut.
 */
function normalizeScenario(input = {}) {
  const outcome = String(input?.outcome ?? "").trim().toLowerCase();

  if (!OUTCOME_VALUES.includes(outcome)) {
    throw scenarioError(
      `Issue de simulation inconnue : ${JSON.stringify(input?.outcome ?? null)}.`
    );
  }

  const delay = Number(input?.confirmationDelaySeconds);

  if (
    !Number.isInteger(delay) ||
    delay < DELAY_BOUNDS.min ||
    delay > DELAY_BOUNDS.max
  ) {
    throw scenarioError(
      `Délai de confirmation invalide : entier de ${DELAY_BOUNDS.min} à ${DELAY_BOUNDS.max} secondes attendu.`
    );
  }

  return { outcome, confirmationDelaySeconds: delay };
}

/**
 * Codes de refus — le vocabulaire d'un vrai prestataire, pour que l'écran
 * d'erreur filmé soit celui qu'un client verrait.
 */
const FAILURE_CODES = Object.freeze({
  DECLINED: "PROVIDER_DECLINED",
  PAYER_INSUFFICIENT_FUNDS: "PAYER_INSUFFICIENT_FUNDS",
  CARD_INSUFFICIENT_FUNDS: "CARD_DECLINED_INSUFFICIENT_FUNDS",
  PROVIDER_INSUFFICIENT_FUNDS: "PROVIDER_INSUFFICIENT_FUNDS",
  THREE_DS_FAILED: "THREE_DS_AUTHENTICATION_FAILED",
});

const FAILURE_MESSAGES = Object.freeze({
  [FAILURE_CODES.DECLINED]: "Opération refusée par le prestataire.",
  [FAILURE_CODES.PAYER_INSUFFICIENT_FUNDS]:
    "Solde mobile money insuffisant pour ce paiement.",
  [FAILURE_CODES.CARD_INSUFFICIENT_FUNDS]:
    "Paiement refusé par la banque : fonds insuffisants.",
  [FAILURE_CODES.PROVIDER_INSUFFICIENT_FUNDS]:
    "Le prestataire n'a pas pu exécuter le versement.",
  [FAILURE_CODES.THREE_DS_FAILED]: "Authentification 3-D Secure refusée.",
});

function insufficientFundsCode({ kind, rail }) {
  if (kind === "collect") {
    return rail === "card"
      ? FAILURE_CODES.CARD_INSUFFICIENT_FUNDS
      : FAILURE_CODES.PAYER_INSUFFICIENT_FUNDS;
  }
  return FAILURE_CODES.PROVIDER_INSUFFICIENT_FUNDS;
}

/**
 * Plan de réponse d'un ordre prestataire.
 *
 * Un ordre est TOUJOURS accepté de façon synchrone (`PENDING`), et son issue
 * arrive par un rappel simulé — c'est le comportement des rails réels (le
 * mobile money confirme après la validation USSD du payeur, la carte après
 * l'authentification). Le refus passe donc par le même chemin de règlement
 * qu'un vrai rappel d'échec, qui libère ou rembourse les fonds réservés.
 *
 * @param {object} p
 * @param {object} p.scenario  scénario normalisé (ou `DEFAULT_SCENARIO`)
 * @param {"payout"|"collect"} p.kind
 * @param {"mobilemoney"|"card"} p.rail
 * @returns {{
 *   settle: "success"|"failure"|null,
 *   failureCode: string|null,
 *   failureMessage: string|null,
 *   delaySeconds: number,
 *   requiresThreeDS: boolean
 * }}
 */
function planProviderOutcome({ scenario, kind, rail }) {
  const { outcome, confirmationDelaySeconds } = normalizeScenario(
    scenario || DEFAULT_SCENARIO
  );

  if (kind !== "payout" && kind !== "collect") {
    throw scenarioError(`Opération prestataire inconnue : ${kind}`);
  }

  // Un encaissement par carte passe par l'authentification forte, comme en
  // production (DSP2) : l'issue n'est planifiée qu'après la décision 3DS.
  const requiresThreeDS = kind === "collect" && rail === "card";

  if (outcome === SANDBOX_OUTCOMES.PENDING) {
    return {
      settle: null,
      failureCode: null,
      failureMessage: null,
      delaySeconds: confirmationDelaySeconds,
      requiresThreeDS,
    };
  }

  if (outcome === SANDBOX_OUTCOMES.SUCCESS) {
    return {
      settle: "success",
      failureCode: null,
      failureMessage: null,
      delaySeconds: confirmationDelaySeconds,
      requiresThreeDS,
    };
  }

  const failureCode =
    outcome === SANDBOX_OUTCOMES.INSUFFICIENT_FUNDS
      ? insufficientFundsCode({ kind, rail })
      : FAILURE_CODES.DECLINED;

  return {
    settle: "failure",
    failureCode,
    failureMessage: FAILURE_MESSAGES[failureCode],
    delaySeconds: confirmationDelaySeconds,
    requiresThreeDS,
  };
}

/** Issue d'un 3DS refusé : échec immédiat, quel que soit le scénario. */
function planThreeDSDecline() {
  return {
    settle: "failure",
    failureCode: FAILURE_CODES.THREE_DS_FAILED,
    failureMessage: FAILURE_MESSAGES[FAILURE_CODES.THREE_DS_FAILED],
    delaySeconds: 0,
    requiresThreeDS: false,
  };
}

module.exports = {
  SANDBOX_OUTCOMES,
  OUTCOME_VALUES,
  DELAY_BOUNDS,
  DEFAULT_SCENARIO,
  FAILURE_CODES,
  FAILURE_MESSAGES,
  normalizeScenario,
  planProviderOutcome,
  planThreeDSDecline,
};
