"use strict";

/**
 * ============================================================================
 * ÉTAT DES RAILS AU DÉMARRAGE — DIRE LA VÉRITÉ, TÔT
 * ============================================================================
 *
 * `resolveProviderMode()` protège le chemin de l'argent : un rail non configuré
 * refuse de payer au lieu d'accepter. Mais il ne le fait qu'**au moment du
 * premier paiement** — c'est-à-dire devant un utilisateur.
 *
 * Ce module déplace la découverte au démarrage. C'est la même distinction
 * qu'entre `/healthz` et `/readyz` : savoir que le processus tourne ne dit pas
 * qu'il peut servir.
 *
 * DEUX SORTIES, ET ELLES NE FONT PAS LA MÊME CHOSE
 * ------------------------------------------------
 *   • `describeProviderRails()` — inventaire, ne lève jamais. Sert au journal
 *     de démarrage et à la sonde de disponibilité.
 *   • `assertProviderRails()` — lève si un rail ACTIVÉ est mal configuré. Sert
 *     au démarrage en production.
 *
 * ⚠️ « ACTIVÉ » — LE MOT QUI MANQUAIT, ET QUI A BLOQUÉ UN DÉPLOIEMENT
 * ------------------------------------------------------------------
 * Ce module exigeait que les SEPT rails soient configurés en production. Le
 * 2026-08-26, TX Core n'a pas pu démarrer sur Render : aucun contrat
 * prestataire n'étant encore signé, aucune variable `WAVE_*`, `ORANGE_*`… n'est
 * définie, et les sept rails étaient donc « cassés ».
 *
 * L'exigence était mal posée. PayNoval n'offrira jamais les sept rails à la
 * fois : un rail qu'on ne propose pas n'est pas EN PANNE, il est ÉTEINT. C'est
 * la distinction que faisait défaut, et c'est celle qu'appliquent Stripe et
 * Adyen — on ACTIVE explicitement les moyens de paiement qu'on offre.
 *
 *     PROVIDER_RAILS_ENABLED=wave,orange
 *
 *   • variable renseignée → ces rails DOIVENT être configurés, sinon le
 *     démarrage échoue. La propriété de sûreté est intégralement conservée
 *     pour les rails qu'on prétend offrir ;
 *   • variable absente → aucun rail n'est exigé. Le démarrage passe, avec un
 *     avertissement appuyé.
 *
 * ⚠️ CE N'EST PAS UN AFFAIBLISSEMENT DU CHEMIN DE L'ARGENT. `resolveProviderMode`
 * continue de REFUSER tout ordre sur un rail non configuré en production (503).
 * Un rail éteint n'accepte donc rien — il empêche simplement de démarrer un
 * service qui n'avait jamais l'intention de le proposer.
 *
 * POURQUOI L'INVENTAIRE NE S'ARRÊTE PAS AU PREMIER ÉCHEC
 * -----------------------------------------------------
 * Un démarrage qui meurt sur `ORANGE_BASE_URL manquante` fait corriger Orange,
 * redéployer, puis mourir sur MTN. Trois déploiements pour trois variables.
 * L'inventaire complet permet de tout corriger d'un coup.
 *
 * CE QUE CE MODULE NE JOURNALISE JAMAIS
 * -------------------------------------
 * Ni clé d'API, ni secret de webhook, ni URL complète — une URL de base porte
 * parfois un jeton dans son chemin. On journalise le NOM du rail, son MODE, et
 * la RAISON. Rien d'autre.
 */

const { inspectProviderMode } = require("./providerMode");

/**
 * Les sept rails, avec leur préfixe d'environnement.
 *
 * Cette liste doit rester alignée sur `providerSelector.js`. Elle est explicite
 * plutôt que dérivée des adapters : un adapter oublié ici doit se voir en
 * relecture, pas disparaître silencieusement de l'inventaire.
 */
const RAILS = Object.freeze([
  { rail: "mobilemoney", provider: "orange",       envPrefix: "ORANGE" },
  { rail: "mobilemoney", provider: "mtn",          envPrefix: "MTN" },
  { rail: "mobilemoney", provider: "moov",         envPrefix: "MOOV" },
  { rail: "mobilemoney", provider: "wave",         envPrefix: "WAVE" },
  { rail: "card",        provider: "stripe",       envPrefix: "STRIPE" },
  { rail: "card",        provider: "visa_direct",  envPrefix: "VISA_DIRECT" },
  { rail: "bank",        provider: "bank_generic", envPrefix: "BANK_GENERIC" },
]);

/**
 * Quels rails prétendons-nous offrir ?
 *
 * Pure. Rend `null` — et non un ensemble vide — quand rien n'est déclaré : les
 * deux situations sont différentes. `null` veut dire « on n'exige rien » ;
 * un ensemble vide voudrait dire « on exige explicitement zéro rail », ce qui
 * n'a pas de sens et masquerait une variable mal orthographiée.
 *
 * @returns {Set<string>|null}
 */
function resolveEnabledRails(env = process.env) {
  const brut = String(env.PROVIDER_RAILS_ENABLED || "").trim();
  if (!brut) return null;

  const noms = brut
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);

  return noms.length ? new Set(noms) : null;
}

/**
 * Inventaire complet. Ne lève jamais.
 *
 * @param {object} [env] source des variables (défaut `process.env`)
 * @returns {{ rails: Array, live: Array, mocked: Array, broken: Array, ok: boolean }}
 */
function describeProviderRails(env = process.env) {
  const actives = resolveEnabledRails(env);

  const rails = RAILS.map(({ rail, provider, envPrefix }) => {
    const baseURL = String(env[`${envPrefix}_BASE_URL`] || "").trim();

    const state = inspectProviderMode({ provider, envPrefix, baseURL, env });

    /**
     * Sans liste déclarée, aucun rail n'est « activé » : on n'exige rien, et
     * `assertProviderRails` ne bloquera aucun démarrage.
     */
    const enabled = actives ? actives.has(provider) : false;

    return {
      rail,
      provider,
      envPrefix,
      enabled,
      ok: state.ok,
      mock: state.mock,
      reason: state.reason,
      // On garde le message, jamais l'objet Error complet : il porte une pile
      // qui n'apporte rien ici et alourdit les journaux structurés.
      error: state.error ? state.error.message : null,
      code: state.error ? state.error.code : null,
    };
  });

  /**
   * ⚠️ `broken` NE RETIENT QUE LES RAILS ACTIVÉS.
   *
   * Un rail éteint et non configuré est l'état NORMAL — le signaler comme cassé
   * remplirait le journal de démarrage de sept erreurs permanentes, et un
   * journal toujours rouge est un journal qu'on cesse de lire.
   */
  return {
    rails,
    enabled: rails.filter((r) => r.enabled),
    disabled: rails.filter((r) => !r.enabled),
    live: rails.filter((r) => r.ok && r.mock === false),
    mocked: rails.filter((r) => r.ok && r.mock === true),
    broken: rails.filter((r) => r.enabled && !r.ok),
    ok: rails.every((r) => !r.enabled || r.ok),
    declared: actives !== null,
  };
}

/**
 * Rend les lignes à journaliser au démarrage.
 *
 * Fonction **pure** : elle rend des chaînes, elle n'écrit pas. Le site d'appel
 * choisit son journal — et les tests n'ont rien à intercepter.
 */
function formatProviderRailsReport(report) {
  const lines = [];

  if (report.live.length) {
    lines.push(
      `[providers] RÉELS (${report.live.length}) : ` +
        report.live.map((r) => `${r.provider}[${r.rail}]`).join(", ")
    );
  }

  if (report.mocked.length) {
    lines.push(
      `[providers] ⚠️  SIMULÉS (${report.mocked.length}) : ` +
        report.mocked.map((r) => `${r.provider}[${r.rail}]`).join(", ") +
        " — ces rails ACCEPTENT les ordres sans jamais payer."
    );
  }

  for (const r of report.broken) {
    lines.push(`[providers] ❌ ${r.provider}[${r.rail}] : ${r.error}`);
  }

  /**
   * ⚠️ « AUCUN RAIL DÉCLARÉ » DOIT SE DIRE, ET SE DIRE FORT.
   *
   * C'est l'état normal tant qu'aucun contrat prestataire n'est signé, mais il
   * a une conséquence que personne ne doit découvrir devant un utilisateur :
   * aucun paiement externe ne peut aboutir. Le taire ferait passer un service
   * incapable de payer pour un service en bon ordre.
   */
  if (!report.declared) {
    lines.push(
      "[providers] ⚠️  AUCUN rail activé (PROVIDER_RAILS_ENABLED absente). " +
        "Les virements internes fonctionnent ; tout paiement EXTERNE sera " +
        "refusé en 503. Déclarer les rails offerts, ex. " +
        "PROVIDER_RAILS_ENABLED=wave,orange"
    );

    return lines;
  }

  lines.push(
    `[providers] rails activés : ${report.enabled.map((r) => r.provider).join(", ") || "aucun"}`
  );

  if (!report.live.length && !report.broken.length) {
    lines.push(
      "[providers] ⚠️  AUCUN rail réel. Aucun paiement externe n'aboutira."
    );
  }

  return lines;
}

/**
 * Vérifie la configuration et lève si un rail est cassé.
 *
 * Le message rassemble TOUS les rails en défaut — voir l'en-tête du fichier.
 */
function assertProviderRails(env = process.env) {
  const report = describeProviderRails(env);

  if (!report.ok) {
    const details = report.broken
      .map((r) => `  • ${r.provider} [${r.rail}] : ${r.error}`)
      .join("\n");

    const err = new Error(
      `Configuration des rails de paiement invalide ` +
        `(${report.broken.length}/${report.rails.length}) :\n${details}`
    );
    err.code = "PROVIDER_CONFIG_INVALID";
    err.rails = report.broken.map((r) => r.provider);
    throw err;
  }

  return report;
}

module.exports = {
  RAILS,
  resolveEnabledRails,
  describeProviderRails,
  formatProviderRailsReport,
  assertProviderRails,
};
