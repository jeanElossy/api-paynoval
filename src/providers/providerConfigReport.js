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
 *   • `assertProviderRails()` — lève si un rail est mal configuré. Sert au
 *     démarrage en production.
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
 * Inventaire complet. Ne lève jamais.
 *
 * @param {object} [env] source des variables (défaut `process.env`)
 * @returns {{ rails: Array, live: Array, mocked: Array, broken: Array, ok: boolean }}
 */
function describeProviderRails(env = process.env) {
  const rails = RAILS.map(({ rail, provider, envPrefix }) => {
    const baseURL = String(env[`${envPrefix}_BASE_URL`] || "").trim();

    const state = inspectProviderMode({ provider, envPrefix, baseURL, env });

    return {
      rail,
      provider,
      envPrefix,
      ok: state.ok,
      mock: state.mock,
      reason: state.reason,
      // On garde le message, jamais l'objet Error complet : il porte une pile
      // qui n'apporte rien ici et alourdit les journaux structurés.
      error: state.error ? state.error.message : null,
      code: state.error ? state.error.code : null,
    };
  });

  return {
    rails,
    live: rails.filter((r) => r.ok && r.mock === false),
    mocked: rails.filter((r) => r.ok && r.mock === true),
    broken: rails.filter((r) => !r.ok),
    ok: rails.every((r) => r.ok),
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
  describeProviderRails,
  formatProviderRailsReport,
  assertProviderRails,
};
