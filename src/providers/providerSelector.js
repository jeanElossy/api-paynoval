"use strict";

const waveAdapter = require("./mobilemoney/waveAdapter");
const orangeAdapter = require("./mobilemoney/orangeAdapter");
const mtnAdapter = require("./mobilemoney/mtnAdapter");
const moovAdapter = require("./mobilemoney/moovAdapter");

/**
 * ⚠️ AUCUN ADAPTER BANCAIRE. Le rail « bank » a été RETIRÉ le 2026-08-26.
 *
 * Le §1 de l'architecture cible est explicite : il n'y a aucun rail bancaire
 * direct, et il ne faut en créer un que si cela devient explicitement
 * nécessaire. Du code bancaire existait pourtant — un adapter générique, un
 * exécuteur, et un routage. Il contredisait la cible et donnait l'illusion
 * d'un rail disponible.
 *
 * PayNoval démarre sur trois rails, et trois seulement : transferts internes,
 * mobile money, cartes.
 *
 * Ne pas « remettre au cas où » : un rail présent dans le code finit par être
 * proposé, et un rail proposé sans contrat accepte des ordres que personne
 * n'exécute — le défaut n°1 de l'audit d'architecture.
 */

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

function getCardAdapter(provider) {
  switch (norm(provider)) {
    case "stripe":
      /**
       * REFUS EXPLICITE, comme pour le rail bancaire retiré avant lui.
       *
       * Stripe est sorti du périmètre le 2026-09-08 et son adapter a été
       * SUPPRIMÉ. Une transaction héritée peut encore porter ce prestataire :
       * elle doit lever ici, bruyamment, plutôt que d'être routée vers un
       * adapter de remplacement. Router un ordre Stripe vers Visa Direct
       * déplacerait de l'argent par un chemin que personne n'a choisi.
       */
      throw new Error(
        "Stripe a été retiré de PayNoval (2026-09-08) — aucun adapter ne le sert. " +
          "Le rail carte est servi par Visa Direct, et le sera par le partenaire " +
          "multi-réseaux à venir."
      );

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
      /**
       * REFUS EXPLICITE, et non un repli silencieux.
       *
       * Une transaction héritée peut encore porter ce rail. Elle doit lever
       * ici, bruyamment, plutôt que d'être routée vers un adapter de
       * remplacement : router un ordre bancaire vers un autre rail déplacerait
       * de l'argent par un chemin que personne n'a choisi.
       */
      throw new Error(
        "Le rail bancaire a été retiré de PayNoval (§1) — aucun adapter ne le sert. " +
          "PayNoval opère sur trois rails : interne, mobile money, cartes."
      );

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
  // Pas de `getBankAdapter` : le rail bancaire a été retiré le 2026-08-26 (§1).
  getCardAdapter,
};