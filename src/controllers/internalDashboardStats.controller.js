// File: controllers/internalDashboardStats.controller.js

"use strict";

/**
 * Agrégats transactionnels pour le tableau de bord du back-office.
 *
 * ⚠️ Pourquoi ici et pas dans le backend principal : le TX Core est
 * propriétaire des transactions, des soldes et du grand livre. Le principal
 * peut techniquement lire la base transactions (il ouvre `MONGO_TX_URI`),
 * mais calculer des agrégats financiers depuis là dupliquerait la
 * connaissance du schéma — notamment les `Decimal128` et la machine à états.
 * Le principal appelle donc cet endpoint interne et se contente d'assembler.
 *
 * Sécurité :
 *  - route protégée par le token interne (voir internalAdminTransactions.routes) ;
 *  - la fenêtre temporelle passe par une LISTE BLANCHE : aucune valeur du
 *    client n'entre jamais dans un pipeline d'agrégation ;
 *  - chaque pipeline est borné par `maxTimeMS` et par un `$limit` ;
 *  - `$convert` avec `onError`/`onNull` : une donnée sale ne fait pas tomber
 *    l'agrégation, elle compte pour zéro.
 */

const createError = require("http-errors");

// ⚠️ On garde l'objet `runtime` et on résout `Transaction` au moment de
// l'appel, sans déstructurer. `runtime.Transaction` est un getter qui lie le
// modèle à la connexion transactions : le déstructurer ici l'évaluerait au
// chargement du module. Cela fonctionne aujourd'hui parce que `bootstrap()`
// fait `await connectTransactionsDB()` avant de charger les routes, mais
// c'est une dépendance implicite à l'ordre des `require`. Résoudre
// paresseusement rend ce fichier correct quel que soit cet ordre.
const runtime = require("../services/transactions/shared/runtime");

/* -------------------------------------------------------------------------- */
/* Constantes                                                                  */
/* -------------------------------------------------------------------------- */

// La valeur reçue sert de CLÉ dans cet objet, jamais de donnée : impossible
// d'injecter une date, un opérateur ou un objet par ce biais.
const WINDOWS = Object.freeze({
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
});
const DEFAULT_WINDOW = "24h";

// Statuts de la machine à états (src/models/Transaction.js).
const STATUS_SUCCESS = ["confirmed"];
const STATUS_FAILED = ["failed"];
const STATUS_CANCELLED = ["cancelled", "refunded"];
// Argent engagé mais pas encore réglé : c'est l'encours.
const STATUS_IN_FLIGHT = ["created", "pending", "processing", "locked"];
// Attente d'une décision humaine.
const STATUS_REVIEW = ["pending_review"];

const AGG_TIMEOUT_MS = 8000;
const MAX_CURRENCIES = 12;
const MAX_CORRIDORS = 12;
const SERIES_DAYS = 7;
const MAX_SERIES_BUCKETS = 62;

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                 */
/* -------------------------------------------------------------------------- */

function resolveWindow(raw) {
  const key = String(raw || "").trim();
  return Object.prototype.hasOwnProperty.call(WINDOWS, key)
    ? key
    : DEFAULT_WINDOW;
}

/**
 * Convertit un montant `Decimal128` en double, de façon défensive.
 * Un champ absent, nul ou corrompu vaut 0 plutôt que de faire échouer tout
 * le pipeline — un tableau de bord dégradé vaut mieux qu'un écran vide.
 */
function toNumber(expr, fallbackExpr = 0) {
  return {
    $convert: {
      input: { $ifNull: [expr, fallbackExpr] },
      to: "double",
      onError: 0,
      onNull: 0,
    },
  };
}

/** Montant côté émetteur, avec repli sur `amount` (transactions pré-multidevise). */
const AMOUNT_SOURCE = toNumber("$amountSource", "$amount");

/** Devise côté émetteur, avec repli. */
const CURRENCY_SOURCE = {
  $ifNull: ["$currencySource", { $ifNull: ["$currency", "N/A"] }],
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Somme conditionnée à un statut. */
const sumIf = (statuses, expr) => ({
  $sum: { $cond: [{ $in: ["$status", statuses] }, expr, 0] },
});

/** Compteur conditionné à un statut. */
const countIf = (statuses) => sumIf(statuses, 1);

function runAgg(pipeline) {
  // Résolution paresseuse : voir le commentaire sur l'import de `runtime`.
  return runtime.Transaction.aggregate(pipeline).option({
    maxTimeMS: AGG_TIMEOUT_MS,
  });
}

/**
 * Taux de succès calculé sur les transactions TERMINÉES uniquement.
 * Inclure celles encore en vol ferait chuter le taux sans qu'aucune n'ait
 * échoué — un faux signal d'incident au moindre pic d'activité.
 */
function successRate(countSuccess, countFailed) {
  const settled = countSuccess + countFailed;
  return settled > 0 ? round2((countSuccess / settled) * 100) : null;
}

/* -------------------------------------------------------------------------- */
/* Agrégations                                                                 */
/* -------------------------------------------------------------------------- */

/** Volume abouti, frais encaissés et répartition par statut, par devise. */
async function aggregateMoney(since) {
  const rows = await runAgg([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: CURRENCY_SOURCE,
        countAll: { $sum: 1 },
        countSuccess: countIf(STATUS_SUCCESS),
        countFailed: countIf(STATUS_FAILED),
        countCancelled: countIf(STATUS_CANCELLED),
        // Le volume ne compte que l'abouti : additionner les échecs
        // gonflerait l'activité affichée.
        volume: sumIf(STATUS_SUCCESS, AMOUNT_SOURCE),
        fees: sumIf(STATUS_SUCCESS, toNumber("$feeSource")),
      },
    },
    { $sort: { volume: -1 } },
    { $limit: MAX_CURRENCIES },
  ]);

  const byCurrency = rows.map((r) => ({
    currency: r._id,
    volume: round2(r.volume),
    fees: round2(r.fees),
    count: r.countAll,
    countSuccess: r.countSuccess,
    countFailed: r.countFailed,
    countCancelled: r.countCancelled,
  }));

  const totals = byCurrency.reduce(
    (acc, c) => {
      acc.count += c.count;
      acc.countSuccess += c.countSuccess;
      acc.countFailed += c.countFailed;
      return acc;
    },
    { count: 0, countSuccess: 0, countFailed: 0 }
  );

  return {
    byCurrency,
    totalCount: totals.count,
    successRate: successRate(totals.countSuccess, totals.countFailed),
  };
}

/** Encours : argent engagé, pas encore réglé. Sans borne de temps. */
async function aggregateInFlight() {
  const rows = await runAgg([
    { $match: { status: { $in: STATUS_IN_FLIGHT } } },
    {
      $group: {
        _id: CURRENCY_SOURCE,
        amount: { $sum: AMOUNT_SOURCE },
        count: { $sum: 1 },
        oldestAt: { $min: "$createdAt" },
      },
    },
    { $sort: { amount: -1 } },
    { $limit: MAX_CURRENCIES },
  ]);

  return {
    byCurrency: rows.map((r) => ({
      currency: r._id,
      amount: round2(r.amount),
      count: r.count,
    })),
    count: rows.reduce((n, r) => n + r.count, 0),
    oldestAt: rows.reduce(
      (min, r) => (r.oldestAt && (!min || r.oldestAt < min) ? r.oldestAt : min),
      null
    ),
  };
}

/**
 * File de revue manuelle : le cœur de la file opérationnelle du back-office.
 * `oldestAt` est indispensable — sans lui, impossible de savoir ce qui est
 * hors délai.
 */
async function aggregateReviewQueue() {
  const rows = await runAgg([
    { $match: { status: { $in: STATUS_REVIEW } } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        amount: { $sum: AMOUNT_SOURCE },
        oldestAt: { $min: "$createdAt" },
      },
    },
  ]);

  const row = rows[0];
  return {
    count: row?.count || 0,
    amount: round2(row?.amount || 0),
    oldestAt: row?.oldestAt || null,
  };
}

/** Série journalière sur 7 jours, pour les sparklines. */
async function aggregateSeries(sinceSeries) {
  const rows = await runAgg([
    { $match: { createdAt: { $gte: sinceSeries } } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$createdAt",
            timezone: "UTC",
          },
        },
        volume: sumIf(STATUS_SUCCESS, AMOUNT_SOURCE),
        count: { $sum: 1 },
        countSuccess: countIf(STATUS_SUCCESS),
        countFailed: countIf(STATUS_FAILED),
      },
    },
    { $sort: { _id: 1 } },
    { $limit: MAX_SERIES_BUCKETS },
  ]);

  return rows.map((r) => ({
    day: r._id,
    volume: round2(r.volume),
    count: r.count,
    successRate: successRate(r.countSuccess, r.countFailed),
  }));
}

/**
 * Corridors : par flow et couple de devises.
 *
 * Le schéma ne porte qu'un seul champ `country` (celui de l'opération), pas
 * de pays de destination : le couple `currencySource → currencyTarget`
 * combiné au `flow` est la meilleure approximation disponible d'un corridor,
 * et c'est de toute façon l'axe sur lequel se lisent les incidents (un rail
 * mobile money qui se dégrade sur XOF, par exemple).
 */
async function aggregateCorridors(since) {
  const rows = await runAgg([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: {
          flow: { $ifNull: ["$flow", "UNKNOWN_FLOW"] },
          from: CURRENCY_SOURCE,
          to: { $ifNull: ["$currencyTarget", CURRENCY_SOURCE] },
        },
        volume: sumIf(STATUS_SUCCESS, AMOUNT_SOURCE),
        count: { $sum: 1 },
        countSuccess: countIf(STATUS_SUCCESS),
        countFailed: countIf(STATUS_FAILED),
        provider: { $first: "$provider" },
      },
    },
    { $sort: { volume: -1, count: -1 } },
    { $limit: MAX_CORRIDORS },
  ]);

  return rows.map((r) => ({
    flow: r._id.flow,
    from: r._id.from,
    to: r._id.to,
    volume: round2(r.volume),
    count: r.count,
    countFailed: r.countFailed,
    successRate: successRate(r.countSuccess, r.countFailed),
    provider: r.provider || null,
  }));
}

/** Répartition par rail (provider) — où passe réellement l'argent. */
async function aggregateProviders(since) {
  const rows = await runAgg([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: { $ifNull: ["$provider", "N/A"] },
        volume: sumIf(STATUS_SUCCESS, AMOUNT_SOURCE),
        count: { $sum: 1 },
        countSuccess: countIf(STATUS_SUCCESS),
        countFailed: countIf(STATUS_FAILED),
      },
    },
    { $sort: { volume: -1 } },
    { $limit: MAX_CORRIDORS },
  ]);

  return rows.map((r) => ({
    provider: r._id,
    volume: round2(r.volume),
    count: r.count,
    countFailed: r.countFailed,
    successRate: successRate(r.countSuccess, r.countFailed),
  }));
}

/* -------------------------------------------------------------------------- */
/* Contrôleur                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/v1/internal/admin/dashboard/stats?window=24h|7d|30d
 * Appelé par le backend principal avec `x-internal-token`.
 */
async function getInternalDashboardStats(req, res, next) {
  try {
    const windowKey = resolveWindow(req.query?.window);
    const now = Date.now();
    const since = new Date(now - WINDOWS[windowKey]);
    const sinceSeries = new Date(now - SERIES_DAYS * 24 * 60 * 60 * 1000);

    // Un bloc en échec ne doit pas vider tout l'écran : on dégrade bloc à bloc.
    const keys = [
      "money",
      "inFlight",
      "reviewQueue",
      "series",
      "corridors",
      "providers",
    ];

    const settled = await Promise.allSettled([
      aggregateMoney(since),
      aggregateInFlight(),
      aggregateReviewQueue(),
      aggregateSeries(sinceSeries),
      aggregateCorridors(since),
      aggregateProviders(since),
    ]);

    const degraded = [];
    const data = {};

    keys.forEach((key, i) => {
      const r = settled[i];
      if (r.status === "fulfilled") {
        data[key] = r.value;
      } else {
        data[key] = null;
        degraded.push(key);
        console.error(
          `[TX-CORE][DASHBOARD] agrégation "${key}" en échec :`,
          r.reason?.message
        );
      }
    });

    // Si absolument tout échoue, c'est une panne, pas une dégradation.
    if (degraded.length === keys.length) {
      return next(
        createError(503, "Agrégations transactionnelles indisponibles")
      );
    }

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      data: {
        generatedAt: new Date(now).toISOString(),
        window: windowKey,
        degraded,
        ...data,
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getInternalDashboardStats };
