"use strict";

/**
 * ============================================================================
 * MODE D'UN COMPTE — LIVE OU SANDBOX (MODÈLE `livemode` DE STRIPE)
 * ============================================================================
 *
 * Chaque objet financier porte son mode : utilisateur, portefeuille,
 * transaction, écriture du grand livre, trésorerie. C'est le modèle de Stripe
 * (`livemode` sur chaque objet) : les données de simulation vivent dans les
 * mêmes bases que la production, et c'est le MODE qui les sépare.
 *
 * Ce module est la SEULE définition du mode. Fonctions pures : aucune base,
 * aucun réseau, testables sans rien démarrer.
 *
 * ── Trois règles ──────────────────────────────────────────────────────────
 *  1. La base fait foi. Le jeton porte le mode, mais seulement comme contrôle
 *     de cohérence : `authMiddleware` relit l'utilisateur à chaque requête.
 *  2. Un mode illisible sur le chemin de l'argent ARRÊTE l'opération
 *     (règle B.2) : `requireMode` lève, il ne choisit jamais « live ».
 *  3. Deux objets de modes différents n'interagissent jamais :
 *     `assertSameMode` lève `MODE_MISMATCH`.
 *
 * ── Le seul repli, et pourquoi il est sûr ─────────────────────────────────
 * `resolveUserMode` rend « live » pour un utilisateur SANS champ `mode` et sans
 * aucun des anciens drapeaux de simulation : c'est un compte antérieur à la
 * migration (`scripts/migrateAccountMode.js`), donc un vrai client. Un compte
 * qui porte un ancien drapeau (`isSandbox`, `isReviewerAccount`) est classé
 * « sandbox » — la direction sûre : jamais un compte de démonstration ne
 * retombe sur un prestataire réel faute de migration.
 */

const ACCOUNT_MODES = Object.freeze({
  LIVE: "live",
  SANDBOX: "sandbox",
});

const MODE_VALUES = Object.freeze([ACCOUNT_MODES.LIVE, ACCOUNT_MODES.SANDBOX]);

function isAccountMode(value) {
  return MODE_VALUES.includes(value);
}

function modeError(message, { code, status, details } = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.statusCode = status;
  if (details) err.details = details;
  return err;
}

/**
 * Exige un mode valide. Aucun repli : un objet financier dont le mode est
 * inconnu ne doit ni être écrit, ni être routé vers un prestataire.
 */
function requireMode(value, context = "objet") {
  if (isAccountMode(value)) return value;

  throw modeError(
    `Mode de compte illisible pour ${context} (${JSON.stringify(value ?? null)}) : ` +
      "opération refusée (règle B.2).",
    { code: "MODE_REQUIRED", status: 500, details: { context } }
  );
}

function hasLegacySandboxFlag(user) {
  return user?.isSandbox === true || user?.isReviewerAccount === true;
}

/** Mode d'un document utilisateur. Voir l'en-tête pour l'unique repli. */
function resolveUserMode(user) {
  if (!user) {
    throw modeError("Utilisateur absent : mode indéterminable.", {
      code: "MODE_REQUIRED",
      status: 500,
    });
  }

  if (user.mode !== undefined && user.mode !== null) {
    return requireMode(user.mode, "utilisateur");
  }

  return hasLegacySandboxFlag(user) ? ACCOUNT_MODES.SANDBOX : ACCOUNT_MODES.LIVE;
}

function isSandboxMode(mode) {
  return mode === ACCOUNT_MODES.SANDBOX;
}

/**
 * Deux objets de modes différents n'interagissent jamais.
 *
 * `403` : ce n'est pas une erreur de saisie, c'est une tentative de franchir
 * la frontière entre simulation et production — exactement ce que Stripe
 * refuse quand une clé de test vise un objet live.
 */
function assertSameMode(expected, actual, what = "ressource") {
  const left = requireMode(expected, `${what} (attendu)`);
  const right = requireMode(actual, what);

  if (left !== right) {
    throw modeError(
      `Mode incompatible : ${what} en mode ${right}, opération en mode ${left}.`,
      { code: "MODE_MISMATCH", status: 403, details: { what } }
    );
  }

  return left;
}

/**
 * Une contrepartie est-elle visible depuis ce compte ?
 *
 * - même mode, toujours ;
 * - en simulation, même GROUPE en plus : chaque jeu de comptes de démonstration
 *   (le compte principal et son bénéficiaire) forme un espace clos. Deux
 *   tournages menés avec deux jeux distincts ne se voient pas.
 *
 * Hors portée, l'appelant répond « introuvable » — jamais « existe, mais dans
 * l'autre mode », qui révélerait l'existence du compte.
 */
function sandboxGroupOf(user) {
  const raw = user?.sandboxGroupId;
  return raw ? String(raw) : null;
}

function isCounterpartyInScope(actor, counterparty) {
  if (!actor || !counterparty) return false;

  const actorMode = resolveUserMode(actor);
  if (actorMode !== resolveUserMode(counterparty)) return false;
  if (actorMode === ACCOUNT_MODES.LIVE) return true;

  const group = sandboxGroupOf(actor);
  return Boolean(group && group === sandboxGroupOf(counterparty));
}

/** Champs utilisateur nécessaires aux décisions de mode. */
const USER_MODE_FIELDS = Object.freeze([
  "mode",
  "isSandbox",
  "isReviewerAccount",
  "sandboxGroupId",
]);

/**
 * Filtre « production seulement », pour TOUTE lecture qui alimente un rapport,
 * une réconciliation, un règlement ou un tableau de bord.
 *
 * `$ne: "sandbox"` et non `"live"` : un document antérieur à la migration n'a
 * pas de champ `mode` et c'est un document de production. `{ mode: "live" }`
 * l'écarterait en silence — un rapport qui perd des transactions réelles est
 * pire qu'un rapport qui en compte trop.
 */
function liveOnlyFilter() {
  return { mode: { $ne: ACCOUNT_MODES.SANDBOX } };
}

/**
 * Filtre d'un document (portefeuille…) appartenant au mode donné. Un document
 * sans `mode` est antérieur à la migration : production.
 */
function modeMatchFilter(mode) {
  return requireMode(mode, "filtre de mode") === ACCOUNT_MODES.SANDBOX
    ? { mode: ACCOUNT_MODES.SANDBOX }
    : { mode: { $ne: ACCOUNT_MODES.SANDBOX } };
}

/** Mode d'un document déjà écrit ; absent ⇒ production (antérieur à la migration). */
function storedModeOf(doc) {
  return doc?.mode === ACCOUNT_MODES.SANDBOX ? ACCOUNT_MODES.SANDBOX : ACCOUNT_MODES.LIVE;
}

/** Portée de lecture demandée par le back-office : live (défaut), sandbox, all. */
const MODE_SCOPES = Object.freeze(["live", "sandbox", "all"]);

function normalizeModeScope(value) {
  const scope = String(value ?? "").trim().toLowerCase();
  if (!scope) return "live";
  if (MODE_SCOPES.includes(scope)) return scope;

  throw modeError(`Portée de mode invalide : ${value}`, {
    code: "INVALID_MODE_SCOPE",
    status: 400,
  });
}

function modeScopeFilter(value) {
  const scope = normalizeModeScope(value);
  if (scope === "all") return {};
  if (scope === "sandbox") return { mode: ACCOUNT_MODES.SANDBOX };
  return liveOnlyFilter();
}

/**
 * Le parrainage (et ses primes, payées en argent réel) n'existe pas en
 * simulation. Les producteurs d'activité de parrainage le vérifient ici —
 * une seule définition de la règle.
 */
function isReferralEligibleMode(mode) {
  return mode !== ACCOUNT_MODES.SANDBOX;
}

/**
 * Interrupteur général de la simulation. ÉTEINT par défaut : un environnement
 * qui n'a rien déclaré ne sert aucun compte de simulation. Après un tournage,
 * le couper suffit à fermer toutes les sessions sandbox d'un geste.
 */
function isSandboxEnabled(env = process.env) {
  const raw = String(env.SANDBOX_MODE_ENABLED ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(raw);
}

module.exports = {
  ACCOUNT_MODES,
  MODE_VALUES,
  MODE_SCOPES,
  isAccountMode,
  requireMode,
  resolveUserMode,
  isSandboxMode,
  assertSameMode,
  isCounterpartyInScope,
  sandboxGroupOf,
  USER_MODE_FIELDS,
  liveOnlyFilter,
  modeMatchFilter,
  storedModeOf,
  normalizeModeScope,
  modeScopeFilter,
  isSandboxEnabled,
  isReferralEligibleMode,
};
