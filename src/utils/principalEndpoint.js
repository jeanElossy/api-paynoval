"use strict";

/**
 * ============================================================================
 * OÙ EST LE BACKEND PRINCIPAL, ET AVEC QUEL JETON — UNE SEULE RÉPONSE
 * ============================================================================
 *
 * ── Le défaut mesuré le 2026-09-10 ─────────────────────────────────────────
 *
 * SEPT noms de variable coexistaient dans Tx-Core pour désigner la même chose :
 *
 *     PRINCIPAL_URL              PRINCIPAL_BASE_URL       PRINCIPAL_BACKEND_URL
 *     PRINCIPAL_API_BASE_URL     PRINCIPAL_REFERRAL_BASE_URL
 *     MAIN_BACKEND_URL           MAIN_BACKEND_BASE_URL
 *
 * Chaque appelant lisait sa propre sous-liste, et les sous-listes ne se
 * recouvraient pas. Le parrainage lisait quatre noms dont aucun n'était posé :
 * **aucun bonus n'était livrable**, et rien ne le disait au démarrage — le
 * worker tournait, réclamait ses lots, et échouait à chaque tour.
 *
 * C'est exactement le défaut refermé le même jour sur le jeton interne, où trois
 * chaînes de repli disjointes faisaient rendre 500 à tout le back-office admin.
 * Le même symptôme, la même cause : plusieurs réponses à une seule question.
 *
 * ── L'union, et pourquoi pas un ordre de priorité ──────────────────────────
 *
 * Un ordre ne referme le défaut que d'un côté : renommer la variable chez
 * l'exploitant ferait revenir la panne à l'identique chez l'appelant qui lit
 * l'autre nom. L'union accepte tout ce qui a été délibérément configuré, et
 * `annoncerPrincipal()` signale au démarrage le seul vrai symptôme de mauvaise
 * configuration — deux noms portant des valeurs DIFFÉRENTES.
 *
 * ── Ce module ne devine JAMAIS d'URL par défaut ────────────────────────────
 *
 * Pas de `|| "http://localhost:5000"`. Un défaut de commodité ferait pointer un
 * service de production vers une machine qui n'existe pas, et l'échec serait un
 * délai réseau plutôt qu'une erreur de configuration lisible.
 */

const NOMS_URL = Object.freeze([
  "PRINCIPAL_URL",
  "PRINCIPAL_BASE_URL",
  "PRINCIPAL_API_BASE_URL",
  "PRINCIPAL_BACKEND_URL",
  "PRINCIPAL_REFERRAL_BASE_URL",
  "MAIN_BACKEND_URL",
  "MAIN_BACKEND_BASE_URL",
]);

const NOMS_JETON = Object.freeze([
  "PRINCIPAL_INTERNAL_TOKEN",
  "INTERNAL_TOKEN",
  "GATEWAY_INTERNAL_TOKEN",
]);

function normaliser(valeur) {
  return String(valeur || "").trim().replace(/\/+$/, "");
}

/** La première URL configurée, ou `""`. Jamais de valeur inventée. */
function basePrincipal(env = process.env) {
  for (const nom of NOMS_URL) {
    const valeur = normaliser(env[nom]);
    if (valeur) return valeur;
  }

  return "";
}

function jetonPrincipal(env = process.env) {
  for (const nom of NOMS_JETON) {
    const valeur = String(env[nom] || "").trim();
    if (valeur) return valeur;
  }

  return "";
}

/** Construit une URL complète. Lève si la base manque — jamais de repli muet. */
function urlPrincipal(chemin, env = process.env) {
  const base = basePrincipal(env);

  if (!base) {
    throw Object.assign(
      new Error(
        "Backend principal non configuré (" +
          NOMS_URL.join(", ") +
          ") — aucun appel sortant n'est possible."
      ),
      { code: "PRINCIPAL_URL_MISSING" }
    );
  }

  const suffixe = String(chemin || "");
  return `${base}${suffixe.startsWith("/") ? "" : "/"}${suffixe}`;
}

/** Règle B.6 : le démarrage dit la vérité, avec la conséquence. */
function annoncerPrincipal(env = process.env, log = console) {
  const posesUrl = NOMS_URL.filter((n) => normaliser(env[n]));
  const posesJeton = NOMS_JETON.filter((n) => String(env[n] || "").trim());

  if (!posesUrl.length) {
    log.error?.(
      "❌ Backend principal NON CONFIGURÉ (" +
        NOMS_URL.join(", ") +
        ") — CONSÉQUENCE : aucune prime de parrainage, aucune notification et " +
        "aucun rappel de cagnotte ne sera livré. Les événements ne sont PAS " +
        "perdus (ils restent dans `domain_events`), mais rien ne part."
    );

    return { ok: false, raison: "URL_MANQUANTE" };
  }

  if (!posesJeton.length) {
    log.error?.(
      "❌ Jeton du backend principal NON CONFIGURÉ (" +
        NOMS_JETON.join(", ") +
        ") — CONSÉQUENCE : les appels sortants seront tous refusés en 403."
    );

    return { ok: false, raison: "JETON_MANQUANT" };
  }

  const urlsDistinctes = new Set(posesUrl.map((n) => normaliser(env[n])));

  if (urlsDistinctes.size > 1) {
    log.warn?.(
      "⚠️ Backend principal : " +
        posesUrl.length +
        " variables posées (" +
        posesUrl.join(", ") +
        ") portant " +
        urlsDistinctes.size +
        " URL DIFFÉRENTES. La première de la liste l'emporte ; c'est " +
        "probablement une erreur de configuration."
    );

    return { ok: true, raison: "URLS_DIVERGENTES" };
  }

  log.info?.(
    `✅ Backend principal : ${basePrincipal(env)} (via ${posesUrl.join(", ")}).`
  );

  return { ok: true, raison: "" };
}

module.exports = {
  NOMS_URL,
  NOMS_JETON,
  basePrincipal,
  jetonPrincipal,
  urlPrincipal,
  annoncerPrincipal,
};
