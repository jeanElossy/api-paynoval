"use strict";

const waveAdapter = require("./mobilemoney/waveAdapter");
const orangeAdapter = require("./mobilemoney/orangeAdapter");
const mtnAdapter = require("./mobilemoney/mtnAdapter");
const moovAdapter = require("./mobilemoney/moovAdapter");

const bankGenericAdapter = require("./bank/bankGenericAdapter");

const stripeAdapter = require("./card/stripeAdapter");
const visaDirectAdapter = require("./card/visaDirectAdapter");

const { getTxMetrics } = require("../services/txMetrics");

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function getMobileMoneyAdapter(provider) {
  switch (norm(provider)) {
    case "wave":
      return waveAdapter;
    case "orange":
      return orangeAdapter;
    case "mtn":
      return mtnAdapter;
    case "moov":
      return moovAdapter;
    default:
      throw new Error(`Unsupported mobile money provider: ${provider}`);
  }
}

function getBankAdapter(provider) {
  switch (norm(provider)) {
    case "bank":
    case "generic":
    case "bank_generic":
    case "bankgeneric":
    case "bank-transfer":
    case "bank_transfer":
      return bankGenericAdapter;
    default:
      return bankGenericAdapter;
  }
}

function getCardAdapter(provider) {
  switch (norm(provider)) {
    case "stripe":
      return stripeAdapter;
    case "visa_direct":
    case "visadirect":
    case "visa-direct":
      return visaDirectAdapter;
    default:
      throw new Error(`Unsupported card provider: ${provider}`);
  }
}

/**
 * Résout l'adapter d'un couple {rail, prestataire}.
 *
 * ═══ POINT UNIQUE D'INSTRUMENTATION ══════════════════════════════════════
 *
 * Tout appel prestataire réel passe par ici. C'est ce qui permet de mesurer la
 * latence et le taux d'erreur des prestataires en enveloppant **un seul**
 * endroit, plutôt que sept adapters atteints par cinq exécuteurs et plusieurs
 * chemins (confirmation, webhook, relance administrative).
 *
 * Instrumenter les sites d'appel garantirait d'en oublier un — et un chemin non
 * mesuré est pire qu'aucune mesure : il fausse les moyennes sans se signaler.
 *
 * ⚠️ L'enveloppe mesure et relaie, elle ne change rien : la valeur de retour est
 * rendue telle quelle, une exception est comptée puis relancée. Tant que
 * `server.js` n'a pas posé l'instance de métriques, `instrumentAdapter` est
 * l'identité — les appels fonctionnent exactement comme avant, simplement non
 * mesurés. Voir `services/txMetrics.js`.
 */
function getProviderAdapter({ rail, provider }) {
  const normalizedRail = norm(rail);

  let adapter;

  switch (normalizedRail) {
    case "mobilemoney":
    case "mobile_money":
    case "mobile-money":
      adapter = getMobileMoneyAdapter(provider);
      break;

    case "bank":
    case "bank_transfer":
    case "bank-transfer":
      adapter = getBankAdapter(provider);
      break;

    case "card":
      adapter = getCardAdapter(provider);
      break;

    default:
      throw new Error(`Unsupported rail: ${rail}`);
  }

  return getTxMetrics().instrumentAdapter(adapter, {
    rail: normalizedRail,
    // `adapter.provider` est le nom CANONIQUE ("visa_direct"), là où l'argument
    // peut être un alias ("visa-direct"). Étiqueter avec l'alias créerait deux
    // séries pour un même prestataire.
    provider: adapter?.provider || provider,
  });
}

module.exports = {
  getProviderAdapter,
  getMobileMoneyAdapter,
  getBankAdapter,
  getCardAdapter,
};