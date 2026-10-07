"use strict";

/**
 * ============================================================================
 * ADAPTERS DE SIMULATION — MOBILE MONEY ET CARTE (ACQUISITION + VERSEMENT)
 * ============================================================================
 *
 * Même INTERFACE que les adapters réels — `{ provider, payout, collect,
 * parseWebhook, mapStatus }` —, mêmes formes de résultat (`ok`,
 * `providerReference`, `externalStatus`, `status`, `raw`), même statut
 * canonique. Le moteur ne voit aucune différence : c'est la condition pour que
 * le parcours filmé soit le parcours réel. `test/sandboxAdapters.test.js`
 * vérifie la parité de surface avec chaque adapter réel.
 *
 * Ce qui diffère, c'est ce qu'il y a derrière :
 *   - aucun appel réseau, jamais ;
 *   - l'ordre est ENREGISTRÉ (`SandboxProviderEvent`) avec l'issue choisie par
 *     le scénario du compte, et le rappel de règlement est livré plus tard par
 *     le worker de simulation, au MÊME moteur de règlement que les vrais
 *     rappels (`settleExternalTransaction`) ;
 *   - un encaissement par carte rend une action suivante `redirect_to_url`
 *     vers la page 3-D Secure de test, comme le `next_action` de Stripe.
 *
 * Seule la fabrique (`providerSelector.getProviderAdapter`) construit ces
 * adapters, et seulement pour `mode: "sandbox"`. Par défense en profondeur,
 * l'adapter refuse lui-même une transaction live.
 */

const crypto = require("crypto");

const { ACCOUNT_MODES } = require("../../utils/accountMode");
const { planProviderOutcome } = require("./sandboxScenario");

function defaultDeps() {
  // Paresseux : le service touche la base, l'adapter doit rester chargeable
  // (et testable) sans connexion.
  const events = require("../../services/sandbox/sandboxProviderEvents");
  const scenarios = require("../../services/sandbox/sandboxScenarioStore");

  return {
    loadScenario: scenarios.loadScenario,
    scheduleProviderEvent: events.scheduleProviderEvent,
  };
}

function buildRef(rail, kind) {
  return `SBX_${String(rail).toUpperCase()}_${String(kind).toUpperCase()}_${Date.now()}_${crypto
    .randomBytes(4)
    .toString("hex")}`;
}

function sandboxError(message, code, status = 500) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.statusCode = status;
  return err;
}

function makeSandboxAdapter({ rail, realAdapter, deps = null }) {
  if (!realAdapter || typeof realAdapter.mapStatus !== "function") {
    throw sandboxError(
      `Adapter réel absent pour le rail ${rail} : simulation impossible.`,
      "SANDBOX_ADAPTER_UNAVAILABLE"
    );
  }

  const provider = realAdapter.provider;
  const mapStatus = realAdapter.mapStatus;

  async function execute(kind, input = {}) {
    const tx = input.tx;

    if (!tx || !tx._id) {
      throw sandboxError(
        `Ordre de simulation ${kind} sans transaction : refusé.`,
        "SANDBOX_TRANSACTION_REQUIRED"
      );
    }

    if (tx.mode !== ACCOUNT_MODES.SANDBOX) {
      throw sandboxError(
        "Adapter de simulation appelé pour une transaction live : refusé.",
        "MODE_MISMATCH",
        403
      );
    }

    const { loadScenario, scheduleProviderEvent } = deps || defaultDeps();

    const scenario = await loadScenario(tx.userId);
    const plan = planProviderOutcome({ scenario, kind, rail });
    const providerReference = buildRef(rail, kind);

    const scheduled = await scheduleProviderEvent({
      transaction: tx,
      rail,
      provider,
      kind,
      providerReference,
      plan,
    });

    const externalStatus = scheduled.requiresAction ? "REQUIRES_ACTION" : "PENDING";

    return {
      ok: true,
      provider,
      providerReference: scheduled.providerReference || providerReference,
      externalStatus,
      status: mapStatus(externalStatus),
      message: `Ordre de simulation ${provider} ${kind} accepté`,
      // `mock` : la référence est fabriquée — c'est le seul champ que la liste
      // blanche de `submitExternalExecution` garde pour le dire.
      raw: { mock: true, sandbox: true },
      nextAction: scheduled.nextAction || null,
    };
  }

  return Object.freeze({
    provider,
    sandbox: true,
    payout: (input) => execute("payout", input),
    collect: (input) => execute("collect", input),

    /**
     * Les rappels de simulation ne passent JAMAIS par HTTP : ils sont livrés
     * en interne par le worker. Un rappel « sandbox » reçu sur la route
     * publique est donc forcément forgé — on le refuse.
     */
    async parseWebhook() {
      throw sandboxError(
        "Aucun rappel HTTP n'existe pour un prestataire de simulation.",
        "SANDBOX_WEBHOOK_FORBIDDEN",
        400
      );
    },

    mapStatus,
  });
}

/**
 * Point d'entrée de la fabrique. `realAdapter` a déjà été résolu par
 * `providerSelector` (qui valide rail et prestataire) : l'homologue de
 * simulation porte le même nom canonique de prestataire, pour que l'écran,
 * l'historique et le reçu soient identiques au réel.
 */
function getSandboxAdapter({ rail, realAdapter, deps = null }) {
  const normalizedRail =
    rail === "mobile_money" || rail === "mobile-money" ? "mobilemoney" : rail;

  if (normalizedRail !== "mobilemoney" && normalizedRail !== "card") {
    throw sandboxError(
      `Rail ${rail} non simulé.`,
      "SANDBOX_RAIL_UNSUPPORTED",
      400
    );
  }

  return makeSandboxAdapter({ rail: normalizedRail, realAdapter, deps });
}

module.exports = {
  getSandboxAdapter,
  makeSandboxAdapter,
};
