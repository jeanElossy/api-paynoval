"use strict";

/**
 * Politique des rails — la version serveur de règles qui n'existaient que dans
 * l'application mobile.
 *
 * ── Le constat ─────────────────────────────────────────────────────────────
 *
 * Deux familles de restrictions vivaient uniquement dans des écrans React
 * Native, sans aucune contrepartie serveur :
 *
 *   1. `AFRICA_DISABLED_DEBIT_METHODS` / `..._RECEPTION_METHODS`
 *      (`transactions-selector.js`) — `stripe` et `bank` interdits à un compte
 *      rattaché à un pays ou une devise d'Afrique de l'Ouest/Centrale.
 *
 *   2. Le badge « bientôt disponible » sur le rail bancaire
 *      (`deposit-options.js`, `retrait-options.js`), qui ouvre une modale au
 *      lieu de laisser passer.
 *
 * Ce ne sont pas des vecteurs de vol : une requête forgée produirait une
 * transaction sur un rail non opéré — fonds réservés, règlement impossible,
 * reprise manuelle. Mais §11 est explicite, et le principe est celui de Stripe :
 * les *capabilities* d'un compte ne sont pas une affaire d'interface. Le serveur
 * expose ce qui est activé et **refuse** le reste ; l'interface se contente
 * d'afficher.
 *
 * ── Report-only par défaut, et c'est délibéré ──────────────────────────────
 *
 * `RAIL_POLICY_STRICT` vaut `false` tant qu'on ne l'a pas posée : la politique
 * **journalise** ce qu'elle refuserait sans rien bloquer. Même démarche que
 * `AUTH_BARRIER_STRICT` dans le gateway, et pour la même raison — activer d'un
 * coup une règle déduite de deux écrans, sur un service qui déplace de l'argent,
 * c'est risquer de couper des virements légitimes qu'on n'avait pas prévus.
 *
 * On constitue l'inventaire du trafic réel avec les journaux
 * `[RAIL-POLICY][WOULD-BLOCK]`, puis on bascule.
 *
 * ── Configurable sans redéploiement ───────────────────────────────────────
 *
 * La liste de pays vivait en dur dans un écran mobile, donc figée jusqu'à la
 * prochaine soumission en magasin. Ici elle se pilote par variables
 * d'environnement — une restriction opérationnelle doit pouvoir se lever le
 * jour où le partenaire ouvre le corridor.
 *
 * Aucune de ces variables ne doit aller dans `.env.example` : ce fichier pilote
 * le contrôle de présence de `dotenv-safe`, les y mettre les rendrait
 * obligatoires et casserait le démarrage en développement.
 */

/** Reprend exactement la liste du mobile — normalisée, accents et casse compris. */
const DEFAULT_RESTRICTED_COUNTRIES = [
  "cote d'ivoire",
  "cote divoire",
  "ci",
  "ivory coast",
  "burkina faso",
  "bf",
  "mali",
  "ml",
  "senegal",
  "sn",
  "cameroun",
  "cameroon",
  "cm",
];

const DEFAULT_RESTRICTED_CURRENCIES = ["XOF", "XAF"];

/** Rails refusés à un compte de la zone ci-dessus, en débit comme en réception. */
const DEFAULT_RESTRICTED_RAILS = ["stripe", "bank"];

/**
 * Rails non encore ouverts, quel que soit le pays — le pendant serveur du
 * badge « bientôt disponible ». Vide par défaut : c'est une décision produit,
 * et l'activer sans le dire couperait le rail bancaire pour tout le monde.
 */
const DEFAULT_UNAVAILABLE_RAILS = [];

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeRail(value) {
  return String(value || "").trim().toLowerCase();
}

function parseList(raw, fallback) {
  const text = String(raw || "").trim();
  if (!text) return fallback;

  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * La politique effective, relue à chaque appel : une variable modifiée sur la
 * plateforme prend effet au redémarrage sans qu'il faille toucher au code.
 */
function loadPolicy(env = process.env) {
  return {
    strict: String(env.RAIL_POLICY_STRICT || "").trim().toLowerCase() === "true",

    restrictedCountries: parseList(
      env.RAIL_POLICY_RESTRICTED_COUNTRIES,
      DEFAULT_RESTRICTED_COUNTRIES
    ).map(normalizeText),

    restrictedCurrencies: parseList(
      env.RAIL_POLICY_RESTRICTED_CURRENCIES,
      DEFAULT_RESTRICTED_CURRENCIES
    ).map((c) => String(c).trim().toUpperCase()),

    restrictedRails: parseList(
      env.RAIL_POLICY_RESTRICTED_RAILS,
      DEFAULT_RESTRICTED_RAILS
    ).map(normalizeRail),

    unavailableRails: parseList(
      env.RAIL_POLICY_UNAVAILABLE_RAILS,
      DEFAULT_UNAVAILABLE_RAILS
    ).map(normalizeRail),
  };
}

/**
 * Un compte relève-t-il de la zone restreinte ?
 *
 * Le pays OU la devise suffit — c'est la règle du mobile, et elle est la bonne :
 * un compte dont la devise est XOF opère dans la zone même si son pays est mal
 * renseigné.
 */
function isRestrictedProfile({ country, currency }, policy) {
  const c = normalizeText(country);
  const cur = String(currency || "").trim().toUpperCase();

  if (c && policy.restrictedCountries.includes(c)) return true;
  if (cur && policy.restrictedCurrencies.includes(cur)) return true;

  return false;
}

/**
 * Évalue une demande. **Aucun effet de bord** : rend un verdict, l'appelant
 * décide d'appliquer ou de journaliser selon `strict`.
 *
 * @returns {{allowed: boolean, strict: boolean, violations: Array<{rail: string, side: string, reason: string}>}}
 */
function evaluateRailPolicy({
  country,
  currency,
  funds,
  destination,
  env = process.env,
} = {}) {
  const policy = loadPolicy(env);
  const violations = [];

  const sides = [
    { side: "funds", rail: normalizeRail(funds) },
    { side: "destination", rail: normalizeRail(destination) },
  ];

  for (const { side, rail } of sides) {
    if (!rail) continue;

    if (policy.unavailableRails.includes(rail)) {
      violations.push({ rail, side, reason: "RAIL_NOT_AVAILABLE" });
      continue;
    }

    if (
      policy.restrictedRails.includes(rail) &&
      isRestrictedProfile({ country, currency }, policy)
    ) {
      violations.push({ rail, side, reason: "RAIL_RESTRICTED_FOR_REGION" });
    }
  }

  return {
    allowed: violations.length === 0,
    strict: policy.strict,
    violations,
  };
}

module.exports = {
  evaluateRailPolicy,
  loadPolicy,
  isRestrictedProfile,
  normalizeRail,
  normalizeText,
  DEFAULT_RESTRICTED_COUNTRIES,
  DEFAULT_RESTRICTED_CURRENCIES,
  DEFAULT_RESTRICTED_RAILS,
};
