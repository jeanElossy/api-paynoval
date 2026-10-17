"use strict";

/**
 * ============================================================================
 * PLAFONDS — RÈGLES PURES (2026-10-08)
 * ============================================================================
 *
 * Trois questions, une réponse chacune, sans base ni réseau :
 *
 *   validatePolicy  — une politique proposée est-elle cohérente ? (refusée
 *                     sinon : un plafond 24 h sous le plafond par opération
 *                     ferait échouer chaque opération au second contrôle)
 *   resolveLimit    — quels plafonds pour (opération, rail, devise) ? Absent ⇒
 *                     REFUS (règle B.2) : jamais un plafond deviné ;
 *   evaluateLimit   — l'opération passe-t-elle ? Sinon, lequel bloque, ce qui
 *                     reste, et quand ça se libère.
 */

const { OPERATIONS, RAILS_BY_OPERATION, WINDOWS, catalogOperation, catalogRail } = require("./limitCatalog");

const LIMIT_CODES = Object.freeze({
  UNDEFINED: "LIMIT_UNDEFINED",
  PER_TRANSACTION: "LIMIT_PER_TRANSACTION",
  ROLLING_24H: "LIMIT_ROLLING_24H",
  ROLLING_30D: "LIMIT_ROLLING_30D",
});

const CURRENCY_RE = /^[A-Z]{3}$/;

class LimitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LimitError";
    this.code = code;
    this.details = details;
  }
}

const positiveInt = (v) => Number.isInteger(v) && v > 0;

/**
 * Une politique : `{ [operation]: { [rail]: { [ISO]: { perTransaction,
 * rolling24h, rolling30d } } } }`. Renvoie la liste des erreurs (vide = valide).
 */
function validatePolicy(limits) {
  const errors = [];

  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    return ["La politique doit être un objet."];
  }

  for (const operation of Object.keys(limits)) {
    if (!OPERATIONS.includes(operation)) {
      errors.push(`Opération inconnue : ${operation}.`);
      continue;
    }
    const rails = limits[operation] || {};
    for (const rail of Object.keys(rails)) {
      if (!RAILS_BY_OPERATION[operation].includes(rail)) {
        errors.push(`Rail « ${rail} » hors périmètre pour ${operation}.`);
        continue;
      }
      for (const [currency, l] of Object.entries(rails[rail] || {})) {
        const where = `${operation}/${rail}/${currency}`;
        if (!CURRENCY_RE.test(currency)) errors.push(`${where} : devise invalide.`);
        if (!l || !positiveInt(l.perTransaction) || !positiveInt(l.rolling24h) || !positiveInt(l.rolling30d)) {
          errors.push(`${where} : trois montants entiers positifs attendus.`);
          continue;
        }
        if (l.rolling24h < l.perTransaction) errors.push(`${where} : le plafond 24 h est inférieur au plafond par opération.`);
        if (l.rolling30d < l.rolling24h) errors.push(`${where} : le plafond 30 jours est inférieur au plafond 24 h.`);
      }
    }
  }

  for (const operation of OPERATIONS) {
    for (const rail of RAILS_BY_OPERATION[operation]) {
      if (!limits?.[operation]?.[rail] || !Object.keys(limits[operation][rail]).length) {
        errors.push(`${operation}/${rail} : aucun plafond — l'opération serait refusée partout.`);
      }
    }
  }

  return errors;
}

/** Plafonds applicables, ou `LimitError(LIMIT_UNDEFINED)`. */
function resolveLimit(limits, { operation, rail, currency }) {
  const op = catalogOperation(operation);
  const r = catalogRail(rail);
  const iso = String(currency || "").trim().toUpperCase();
  const l = op && r ? limits?.[op]?.[r]?.[iso] : null;

  if (!l) {
    throw new LimitError(LIMIT_CODES.UNDEFINED, "Aucun plafond défini pour cette opération.", {
      operation: op || null,
      rail: r || null,
      currency: iso || null,
    });
  }

  return { operation: op, rail: r, currency: iso, ...l };
}

const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

/**
 * Un plafond glissant se libère au fil du temps : la plus ancienne opération
 * comptée sort de la fenêtre à `oldest + fenêtre`. C'est la date honnête à
 * annoncer (« se libère à partir de… »), pas « demain ».
 */
function windowView(limit, used, oldestAt, windowMs) {
  const u = Math.max(0, Number(used) || 0);
  const oldest = toDate(oldestAt);
  return {
    limit,
    used: u,
    remaining: Math.max(0, limit - u),
    releasesAt: oldest && u > 0 ? new Date(oldest.getTime() + windowMs).toISOString() : null,
  };
}

/** Ce que voit le client : par opération, 24 h et 30 jours. */
function describeUsage(limit, usage = {}) {
  const daily = windowView(limit.rolling24h, usage.used24h, usage.oldest24hAt, WINDOWS.rolling24h);
  const monthly = windowView(limit.rolling30d, usage.used30d, usage.oldest30dAt, WINDOWS.rolling30d);
  return {
    operation: limit.operation,
    rail: limit.rail,
    currency: limit.currency,
    perTransaction: limit.perTransaction,
    daily,
    monthly,
    // Le montant maximal d'une opération MAINTENANT.
    availableNow: Math.max(0, Math.min(limit.perTransaction, daily.remaining, monthly.remaining)),
  };
}

/**
 * `{ allowed: true }` ou `{ allowed: false, code, limit, remaining, releasesAt }`.
 * L'ordre suit ce qui est le plus utile au client : d'abord le plafond qu'il
 * peut corriger tout de suite (le montant), puis ceux qu'il doit attendre.
 */
function evaluateLimit(limit, usage, amount) {
  const value = Number(amount);
  const view = describeUsage(limit, usage);

  if (!Number.isFinite(value) || value <= 0) {
    return { allowed: false, code: LIMIT_CODES.PER_TRANSACTION, limit: limit.perTransaction, remaining: view.availableNow, releasesAt: null, view };
  }
  if (value > limit.perTransaction) {
    return { allowed: false, code: LIMIT_CODES.PER_TRANSACTION, limit: limit.perTransaction, remaining: view.availableNow, releasesAt: null, view };
  }
  if (value > view.daily.remaining) {
    return { allowed: false, code: LIMIT_CODES.ROLLING_24H, limit: view.daily.limit, remaining: view.daily.remaining, releasesAt: view.daily.releasesAt, view };
  }
  if (value > view.monthly.remaining) {
    return { allowed: false, code: LIMIT_CODES.ROLLING_30D, limit: view.monthly.limit, remaining: view.monthly.remaining, releasesAt: view.monthly.releasesAt, view };
  }
  return { allowed: true, view };
}

const formatAmount = (value) =>
  Number(value || 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 }).replace(/\u202f/g, " ");

/**
 * Le message d'un refus : QUEL plafond, ce qui RESTE, QUAND il se libère.
 * Le client sait quoi faire — baisser le montant ou attendre — sans appeler
 * le support (c'est ce que disent Wise et Revolut).
 */
function describeLimitRefusal(verdict, currencySymbol = "") {
  const sym = String(currencySymbol || verdict?.view?.currency || "").trim();
  const amount = (v) => `${formatAmount(v)} ${sym}`.trim();
  const when = verdict?.releasesAt
    ? ` Il se libère progressivement à partir du ${new Date(verdict.releasesAt).toLocaleString("fr-FR", {
        day: "2-digit",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      })} (UTC).`
    : "";

  switch (verdict?.code) {
    case LIMIT_CODES.PER_TRANSACTION:
      return `Montant au-dessus du plafond par opération (${amount(verdict.limit)}). Montant maximal possible maintenant : ${amount(verdict.remaining)}.`;
    case LIMIT_CODES.ROLLING_24H:
      return `Plafond sur 24 heures atteint (${amount(verdict.limit)}). Il vous reste ${amount(verdict.remaining)}.${when}`;
    case LIMIT_CODES.ROLLING_30D:
      return `Plafond sur 30 jours atteint (${amount(verdict.limit)}). Il vous reste ${amount(verdict.remaining)}.${when}`;
    default:
      return "Opération non autorisée : plafond atteint.";
  }
}

module.exports = {
  describeLimitRefusal,
  LIMIT_CODES,
  LimitError,
  validatePolicy,
  resolveLimit,
  describeUsage,
  evaluateLimit,
};
