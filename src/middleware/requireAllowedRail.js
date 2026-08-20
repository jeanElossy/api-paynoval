"use strict";

/**
 * Applique la politique des rails sur `/initiate`.
 *
 * La décision vit dans `services/transactions/shared/railPolicy.js` — module
 * pur, sans configuration ni Mongo, donc testable. Ce middleware ne fait que
 * lire la requête, appeler l'évaluation, et agir selon le régime.
 *
 * ── Deux régimes ───────────────────────────────────────────────────────────
 *
 * `RAIL_POLICY_STRICT=true`  → refuse en 403 avec un code exploitable.
 * absent ou `false`          → **report-only** : journalise et laisse passer.
 *
 * Le report-only est le défaut, délibérément. Ces règles sont reconstituées à
 * partir de deux écrans mobile ; les activer d'emblée sur un service qui
 * déplace de l'argent risquerait de couper des virements légitimes qu'on
 * n'avait pas anticipés. On lit d'abord `[RAIL-POLICY][WOULD-BLOCK]` pendant un
 * cycle d'usage réel, puis on bascule — exactement la démarche retenue pour
 * `AUTH_BARRIER_STRICT` dans le gateway.
 *
 * ── Le profil vient du serveur, jamais du corps de la requête ─────────────
 *
 * `requireTransactionEligibility` s'exécute avant et recharge le profil depuis
 * la base Users. On lit donc `req.user`, pas `req.body` : un client qui
 * annoncerait un autre pays contournerait sinon la règle qu'on est en train
 * d'installer.
 */

const createError = require("http-errors");
const logger = require("../utils/logger");

const {
  evaluateRailPolicy,
} = require("../services/transactions/shared/railPolicy");

function pickUserCountry(req) {
  return (
    req.user?.country ||
    req.user?.selectedCountry ||
    req.user?.residenceCountry ||
    ""
  );
}

function pickUserCurrency(req) {
  return (
    req.user?.currency ||
    req.user?.currencyCode ||
    req.user?.defaultCurrency ||
    ""
  );
}

function requireAllowedRail(req, _res, next) {
  let verdict;

  try {
    verdict = evaluateRailPolicy({
      country: pickUserCountry(req),
      currency: pickUserCurrency(req),
      funds: req.body?.funds,
      destination: req.body?.destination,
    });
  } catch (err) {
    /**
     * Une politique qui plante ne doit pas bloquer un virement : elle ajoute
     * une couche, elle ne remplace pas les contrôles existants (corridor,
     * éligibilité, AML). Fail-open est ici le bon arbitrage — l'inverse
     * transformerait un bug de configuration en panne de paiement.
     */
    logger?.warn?.(`[RAIL-POLICY][ERROR] ${err?.message || err}`);
    return next();
  }

  if (verdict.allowed) return next();

  const detail = verdict.violations
    .map((v) => `${v.side}=${v.rail} (${v.reason})`)
    .join(", ");

  const userId = req.user?._id || req.user?.id || "unknown";

  if (!verdict.strict) {
    logger?.warn?.(
      `[RAIL-POLICY][WOULD-BLOCK] user=${userId} ${detail} — laissé passer (RAIL_POLICY_STRICT non activé)`
    );
    return next();
  }

  logger?.warn?.(`[RAIL-POLICY][BLOCKED] user=${userId} ${detail}`);

  const first = verdict.violations[0];

  return next(
    createError(
      403,
      first.reason === "RAIL_NOT_AVAILABLE"
        ? "Ce moyen de paiement n’est pas encore disponible."
        : "Ce moyen de paiement n’est pas disponible depuis votre pays.",
      { code: first.reason, rail: first.rail, side: first.side }
    )
  );
}

module.exports = requireAllowedRail;
module.exports.requireAllowedRail = requireAllowedRail;
