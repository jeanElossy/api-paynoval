// File: controllers/internalTreasuryAnalytics.controller.js

"use strict";

/**
 * Agrégats de trésorerie pour le back-office (grand livre + analytiques).
 *
 * ⚠️ Pourquoi ici et pas dans le backend principal : le TX Core est
 * propriétaire du grand livre (`LedgerEntry`) et des transactions. Le principal
 * ouvre bien `MONGO_TX_URI`, mais calculer ces agrégats depuis là dupliquerait
 * la connaissance du schéma — les `Decimal128`, la convention `accountId`, la
 * forme des `metadata` du ledger. Le principal appelle donc cet endpoint
 * interne et se contente de mettre en forme. Même patron que
 * `internalDashboardStats.controller.js`.
 *
 * SOURCES RÉELLES — aucune valeur n'est fabriquée ici :
 *  - `ledger`, `fees`, `fx`  → collection `LedgerEntry` (écritures comptables) ;
 *  - `referral`              → collection `Transaction`, `context = "referral_bonus"`.
 *
 * ⚠️ Le parrainage ne passe PAS par le grand livre : `internalReferralTransferService`
 * débite la trésorerie et crédite les portefeuilles via `TxSystemBalance` /
 * `TxWalletBalance`, puis écrit une `Transaction` de contexte `referral_bonus`,
 * sans jamais appeler `createLedgerEntry`. La seule trace exploitable est donc
 * transactionnelle. C'est une lacune du ledger, pas un choix de ce fichier.
 *
 * Ce qui n'est PAS calculable et n'est donc PAS renvoyé (plutôt qu'un zéro qui
 * passerait pour une vraie valeur) :
 *  - les frais ligne à ligne du grand livre : une écriture `FEE_REVENUE` EST le
 *    frais, il n'existe aucun champ `fee` sur une écriture ;
 *  - le score de risque d'une écriture : rien de tel n'est persisté ;
 *  - l'exposition de change ouverte : elle demanderait des positions/couvertures
 *    qui n'existent dans aucun modèle.
 *
 * Sécurité :
 *  - route protégée par le token interne (voir internalAdminTransactions.routes) ;
 *  - fenêtre temporelle, sections, tris et filtres passent tous par une LISTE
 *    BLANCHE : aucune valeur du client n'entre telle quelle dans un pipeline ;
 *  - chaque agrégation est bornée par `maxTimeMS`, une fenêtre temporelle
 *    obligatoire et un `$limit` ;
 *  - `$convert` avec `onError`/`onNull` : une donnée sale compte pour zéro (ou
 *    pour `null` sur une moyenne) au lieu de faire tomber tout le pipeline.
 */

const createError = require("http-errors");

// ⚠️ On garde l'objet `runtime` et on résout les modèles au moment de l'appel,
// sans déstructurer : `runtime.LedgerEntry` / `runtime.Transaction` sont des
// getters qui lient le modèle à la connexion transactions. Les déstructurer ici
// les évaluerait au chargement du module, avant `connectTransactionsDB()`.
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
  "90d": 90 * 24 * 60 * 60 * 1000,
});
const DEFAULT_WINDOW = "30d";

const SECTIONS = Object.freeze(["ledger", "fees", "fx", "referral"]);

// Miroir de `ENTRY_TYPES` / `ACCOUNT_TYPES` / statuts de models/LedgerEntry.js.
const ENTRY_TYPES = Object.freeze([
  "RESERVE",
  "RESERVE_RELEASE",
  "RESERVE_CAPTURE",
  "USER_DEBIT",
  "USER_CREDIT",
  "FEE_REVENUE",
  "FX_REVENUE",
  "REFUND",
  "REVERSAL",
  "ADJUSTMENT",
]);
const ACCOUNT_TYPES = Object.freeze([
  "USER_WALLET",
  "TREASURY",
  "SYSTEM_CLEARING",
  "SYSTEM_RESERVE",
]);
const LEDGER_STATUSES = Object.freeze(["PENDING", "POSTED", "REVERSED"]);

const AGG_TIMEOUT_MS = 8000;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const MAX_CURRENCIES = 12;
const MAX_CORRIDORS = 12;
const MAX_FEE_GROUPS = 20;
// 92 = fenêtre maximale (90 jours) + marge de bord de fuseau.
const MAX_SERIES_BUCKETS = 92;
const MAX_WEEK_BUCKETS = 16;

// Garde-fou du `$lookup` corridors : au-delà, on tronque explicitement et on le
// dit (`truncated: true`) plutôt que de renvoyer un total silencieusement faux.
const MAX_FX_SCAN = 20000;

/* -------------------------------------------------------------------------- */
/* Utilitaires — validation des entrées                                        */
/* -------------------------------------------------------------------------- */

function resolveWindow(raw) {
  const key = String(raw || "").trim();
  return Object.prototype.hasOwnProperty.call(WINDOWS, key)
    ? key
    : DEFAULT_WINDOW;
}

/** Sections demandées, par liste blanche. Aucune section = toutes. */
function resolveSections(raw) {
  const asked = String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!asked.length) return [...SECTIONS];

  const kept = SECTIONS.filter((s) => asked.includes(s));
  return kept.length ? kept : [...SECTIONS];
}

/** Valeur retenue seulement si elle appartient à la liste blanche. */
function pickFromList(raw, list) {
  const value = String(raw || "").trim().toUpperCase();
  return list.includes(value) ? value : null;
}

/** Code devise ISO : 3 ou 4 lettres, sinon rien. Jamais d'objet ni d'opérateur. */
function pickCurrency(raw) {
  const value = String(raw || "").trim().toUpperCase();
  return /^[A-Z]{3,4}$/.test(value) ? value : null;
}

function pickPage(raw) {
  const n = Number.parseInt(String(raw || "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function pickLimit(raw) {
  const n = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

/* -------------------------------------------------------------------------- */
/* Utilitaires — dates et nombres                                              */
/* -------------------------------------------------------------------------- */

function startOfUtcDay(date) {
  const d = new Date(date);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)
  );
}

function startOfUtcMonth(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Montant `Decimal128` (ou nombre dans un `Mixed`) converti en double.
 * Un champ absent, nul ou corrompu vaut 0 : un écran dégradé vaut mieux qu'une
 * agrégation qui tombe.
 */
function num0(expr) {
  return {
    $convert: { input: expr, to: "double", onError: 0, onNull: 0 },
  };
}

/**
 * Idem, mais `null` en cas d'échec : à réserver aux moyennes, où un 0 injecté
 * fausserait la valeur affichée (un taux de change moyen, typiquement).
 */
function numOrNull(expr) {
  return {
    $convert: { input: expr, to: "double", onError: null, onNull: null },
  };
}

const LEDGER_AMOUNT = num0("$amount");

/** Somme conditionnée à une expression booléenne. */
const sumIf = (cond, expr) => ({ $sum: { $cond: [cond, expr, 0] } });
const countIf = (cond) => sumIf(cond, 1);

const IS_CREDIT = { $eq: ["$direction", "CREDIT"] };
const IS_DEBIT = { $eq: ["$direction", "DEBIT"] };
const IS_POSTED = { $eq: ["$status", "POSTED"] };
const IS_PENDING = { $eq: ["$status", "PENDING"] };
const IS_REVERSED = { $eq: ["$status", "REVERSED"] };

/** Variation en pourcentage. `null` quand la base est nulle : pas de "+0 %" trompeur. */
function changePercent(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p === 0) return null;
  return round2(((c - p) / Math.abs(p)) * 100);
}

function aggLedger(pipeline) {
  // Résolution paresseuse : voir le commentaire sur l'import de `runtime`.
  return runtime.LedgerEntry.aggregate(pipeline).option({
    maxTimeMS: AGG_TIMEOUT_MS,
  });
}

function aggTransaction(pipeline) {
  return runtime.Transaction.aggregate(pipeline).option({
    maxTimeMS: AGG_TIMEOUT_MS,
  });
}

/** Bucket journalier UTC, pour les séries. */
const DAY_BUCKET = {
  $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" },
};

/**
 * Décompose un `accountId` du ledger.
 * Conventions (services/ledgerService.js) :
 *   `user_wallet:<userId>:<CUR>`
 *   `treasury:<SYSTEM_TYPE>:<userId>:<CUR>`
 * Fait en JavaScript sur la page courante (≤ 100 lignes), pas dans le pipeline.
 */
function parseAccountId(accountId) {
  const parts = String(accountId || "").split(":");

  if (parts[0] === "treasury") {
    return {
      accountKind: "treasury",
      treasurySystemType: parts[1] || null,
      accountOwnerId: parts[2] || null,
      accountCurrency: parts[3] || null,
    };
  }

  if (parts[0] === "user_wallet") {
    return {
      accountKind: "user_wallet",
      treasurySystemType: null,
      accountOwnerId: parts[1] || null,
      accountCurrency: parts[2] || null,
    };
  }

  return {
    accountKind: null,
    treasurySystemType: null,
    accountOwnerId: null,
    accountCurrency: null,
  };
}

/** Devise dominante d'une liste `[{ currency, <field> }]`. */
function dominantCurrency(rows, field = "amount") {
  let best = null;
  for (const row of rows || []) {
    const value = Math.abs(Number(row?.[field]) || 0);
    if (!best || value > best.value) {
      best = { currency: row.currency, value };
    }
  }
  return best?.currency || null;
}

/* -------------------------------------------------------------------------- */
/* Section « ledger » — grand livre paginé                                     */
/* -------------------------------------------------------------------------- */

/**
 * Filtre du grand livre. Chaque filtre optionnel est déjà passé par une liste
 * blanche : ce sont des chaînes, jamais des objets venus du client.
 */
function buildLedgerMatch(since, filters) {
  const match = { createdAt: { $gte: since } };

  if (filters.currency) match.currency = filters.currency;
  if (filters.entryType) match.entryType = filters.entryType;
  if (filters.accountType) match.accountType = filters.accountType;
  if (filters.status) match.status = filters.status;

  return match;
}

/** Entrées / sorties / encours par devise. Une seule passe. */
async function ledgerTotalsByCurrency(match) {
  const rows = await aggLedger([
    { $match: match },
    {
      $group: {
        _id: "$currency",
        inflow: sumIf(IS_CREDIT, LEDGER_AMOUNT),
        outflow: sumIf(IS_DEBIT, LEDGER_AMOUNT),
        count: { $sum: 1 },
        postedCount: countIf(IS_POSTED),
        pendingCount: countIf(IS_PENDING),
        reversedCount: countIf(IS_REVERSED),
      },
    },
    { $sort: { inflow: -1, outflow: -1 } },
    { $limit: MAX_CURRENCIES },
  ]);

  return rows.map((r) => ({
    currency: r._id || null,
    inflow: round2(r.inflow),
    outflow: round2(r.outflow),
    net: round2(r.inflow - r.outflow),
    count: r.count,
    postedCount: r.postedCount,
    pendingCount: r.pendingCount,
    reversedCount: r.reversedCount,
  }));
}

/** Série journalière, pour UNE devise : additionner des devises n'a aucun sens. */
async function ledgerDailySeries(match, currency) {
  if (!currency) return [];

  const rows = await aggLedger([
    { $match: { ...match, currency } },
    {
      $group: {
        _id: DAY_BUCKET,
        inflow: sumIf(IS_CREDIT, LEDGER_AMOUNT),
        outflow: sumIf(IS_DEBIT, LEDGER_AMOUNT),
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    { $limit: MAX_SERIES_BUCKETS },
  ]);

  return rows.map((r) => ({
    day: r._id,
    inflow: round2(r.inflow),
    outflow: round2(r.outflow),
    net: round2(r.inflow - r.outflow),
    count: r.count,
  }));
}

/**
 * Page d'écritures. Le `$lookup` sur les transactions ne s'exécute QUE sur la
 * tranche déjà paginée (≤ 100 documents), après `$skip`/`$limit` : il est borné
 * par construction et se fait sur `_id`, donc sur un index.
 */
async function ledgerRows(match, { page, limit }) {
  const skip = (page - 1) * limit;

  const rows = await aggLedger([
    { $match: match },
    { $sort: { createdAt: -1, _id: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $lookup: {
        from: runtime.Transaction.collection.name,
        let: { txId: "$transactionId" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$txId"] } } },
          {
            $project: {
              _id: 0,
              reference: 1,
              flow: 1,
              initiatedBy: 1,
              provider: 1,
              status: 1,
              operationKind: 1,
            },
          },
        ],
        as: "tx",
      },
    },
    { $addFields: { tx: { $arrayElemAt: ["$tx", 0] } } },
    {
      $project: {
        reference: 1,
        entryType: 1,
        accountType: 1,
        accountId: 1,
        direction: 1,
        amount: num0("$amount"),
        currency: 1,
        status: 1,
        userId: 1,
        transactionId: 1,
        createdAt: 1,
        stage: "$metadata.stage",
        reason: "$metadata.reason",
        metadataFlow: "$metadata.flow",
        treasurySystemTypeMeta: "$metadata.treasurySystemType",
        tx: 1,
      },
    },
  ]);

  return rows.map((r) => {
    const parsed = parseAccountId(r.accountId);

    return {
      id: String(r._id),
      reference: r.reference || r.tx?.reference || null,
      entryType: r.entryType || null,
      accountType: r.accountType || null,
      accountId: r.accountId || null,
      ...parsed,
      // La convention `accountId` fait foi ; `metadata.treasurySystemType`
      // n'est renseigné que sur les écritures de revenu.
      treasurySystemType:
        parsed.treasurySystemType || r.treasurySystemTypeMeta || null,
      direction: r.direction || null,
      amount: round2(r.amount),
      currency: r.currency || null,
      status: r.status || null,
      userId: r.userId ? String(r.userId) : null,
      transactionId: r.transactionId ? String(r.transactionId) : null,
      transactionReference: r.tx?.reference || null,
      transactionStatus: r.tx?.status || null,
      flow: r.tx?.flow || r.metadataFlow || null,
      operationKind: r.tx?.operationKind || null,
      provider: r.tx?.provider || null,
      // `initiatedBy` vient de la transaction ; une écriture sans transaction
      // liée n'a pas d'initiateur connu → `null`, pas « System » inventé.
      initiatedBy: r.tx?.initiatedBy || null,
      stage: r.stage || null,
      reason: r.reason || null,
      createdAt: r.createdAt || null,
    };
  });
}

async function buildLedgerSection({ since, prevSince, filters, page, limit }) {
  const match = buildLedgerMatch(since, filters);
  const prevMatch = {
    ...buildLedgerMatch(prevSince, filters),
    createdAt: { $gte: prevSince, $lt: since },
  };

  const [byCurrency, prevByCurrency, rows, total] = await Promise.all([
    ledgerTotalsByCurrency(match),
    ledgerTotalsByCurrency(prevMatch),
    ledgerRows(match, { page, limit }),
    runtime.LedgerEntry.countDocuments(match).maxTimeMS(AGG_TIMEOUT_MS),
  ]);

  const prevIndex = new Map(prevByCurrency.map((r) => [r.currency, r]));

  const totalsByCurrency = byCurrency.map((r) => {
    const prev = prevIndex.get(r.currency) || null;
    return {
      ...r,
      inflowChangePercent: prev ? changePercent(r.inflow, prev.inflow) : null,
      outflowChangePercent: prev ? changePercent(r.outflow, prev.outflow) : null,
      netChangePercent: prev ? changePercent(r.net, prev.net) : null,
    };
  });

  // Devise de la courbe : la plus active en volume brut (entrées + sorties).
  // Une courbe qui additionnerait plusieurs devises ne voudrait rien dire.
  const curveCurrency = dominantCurrency(
    totalsByCurrency.map((r) => ({
      currency: r.currency,
      activity: r.inflow + r.outflow,
    })),
    "activity"
  );
  const curve = await ledgerDailySeries(match, curveCurrency);

  const entryCount = totalsByCurrency.reduce((n, r) => n + r.count, 0);
  const pendingCount = totalsByCurrency.reduce((n, r) => n + r.pendingCount, 0);
  const reversedCount = totalsByCurrency.reduce(
    (n, r) => n + r.reversedCount,
    0
  );
  const postedCount = totalsByCurrency.reduce((n, r) => n + r.postedCount, 0);

  return {
    totals: {
      byCurrency: totalsByCurrency,
      entryCount,
      postedCount,
      pendingCount,
      reversedCount,
      // Part d'écritures effectivement comptabilisées : c'est la seule mesure de
      // « santé » que porte réellement le grand livre.
      postedRate: entryCount > 0 ? round2((postedCount / entryCount) * 100) : null,
      // ⚠️ Les devises ne sont volontairement PAS additionnées entre elles.
      currenciesTruncated: byCurrency.length >= MAX_CURRENCIES,
    },
    curveCurrency,
    curve,
    page,
    limit,
    total,
    hasMore: page * limit < total,
    rows,
  };
}

/* -------------------------------------------------------------------------- */
/* Section « fees » — analytique des frais encaissés                           */
/* -------------------------------------------------------------------------- */

const FEE_BASE_MATCH = Object.freeze({
  entryType: "FEE_REVENUE",
  accountType: "TREASURY",
});

async function revenueByCurrency(baseMatch, since) {
  const rows = await aggLedger([
    { $match: { ...baseMatch, createdAt: { $gte: since } } },
    {
      $group: {
        _id: "$currency",
        amount: sumIf(IS_POSTED, LEDGER_AMOUNT),
        count: { $sum: 1 },
        postedCount: countIf(IS_POSTED),
        pendingCount: countIf(IS_PENDING),
        reversedCount: countIf(IS_REVERSED),
      },
    },
    { $sort: { amount: -1 } },
    { $limit: MAX_CURRENCIES },
  ]);

  return rows.map((r) => ({
    currency: r._id || null,
    amount: round2(r.amount),
    count: r.count,
    postedCount: r.postedCount,
    pendingCount: r.pendingCount,
    reversedCount: r.reversedCount,
  }));
}

/**
 * Cumuls « aujourd'hui » et « mois en cours », en UNE passe bornée au début du
 * mois UTC — indépendante de la fenêtre demandée, sinon un `window=24h`
 * renverrait un cumul mensuel tronqué à 24 h.
 */
async function revenuePeriodTotals(baseMatch, now) {
  const monthStart = startOfUtcMonth(now);
  const dayStart = startOfUtcDay(now);

  const rows = await aggLedger([
    {
      $match: {
        ...baseMatch,
        status: "POSTED",
        createdAt: { $gte: monthStart },
      },
    },
    {
      $group: {
        _id: "$currency",
        monthAmount: { $sum: LEDGER_AMOUNT },
        monthCount: { $sum: 1 },
        todayAmount: sumIf(
          { $gte: ["$createdAt", dayStart] },
          LEDGER_AMOUNT
        ),
        todayCount: countIf({ $gte: ["$createdAt", dayStart] }),
      },
    },
    { $sort: { monthAmount: -1 } },
    { $limit: MAX_CURRENCIES },
  ]);

  return {
    monthStart,
    dayStart,
    byCurrency: rows.map((r) => ({
      currency: r._id || null,
      monthAmount: round2(r.monthAmount),
      monthCount: r.monthCount,
      todayAmount: round2(r.todayAmount),
      todayCount: r.todayCount,
    })),
  };
}

async function revenueDailySeries(baseMatch, since, currency) {
  if (!currency) return [];

  const rows = await aggLedger([
    { $match: { ...baseMatch, currency, createdAt: { $gte: since } } },
    {
      $group: {
        _id: DAY_BUCKET,
        amount: sumIf(IS_POSTED, LEDGER_AMOUNT),
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    { $limit: MAX_SERIES_BUCKETS },
  ]);

  return rows.map((r) => ({
    day: r._id,
    amount: round2(r.amount),
    count: r.count,
  }));
}

/**
 * Répartition des frais par flow et par motif.
 * `metadata.flow` et `metadata.reason` sont écrits par `ledgerService` :
 * `reason = "cancellation_fee"` pour les frais d'annulation, absent sinon.
 */
async function feesByFlow(since) {
  const rows = await aggLedger([
    { $match: { ...FEE_BASE_MATCH, createdAt: { $gte: since } } },
    {
      $group: {
        _id: {
          flow: { $ifNull: ["$metadata.flow", null] },
          reason: { $ifNull: ["$metadata.reason", "transaction_fee"] },
          currency: "$currency",
          // La devise de prélèvement fait partie de la clé : sans elle, on
          // additionnerait des XOF et des CAD dans le même `sourceAmount`.
          sourceCurrency: { $ifNull: ["$metadata.sourceCurrency", null] },
        },
        amount: sumIf(IS_POSTED, LEDGER_AMOUNT),
        sourceAmount: sumIf(IS_POSTED, num0("$metadata.sourceAmount")),
        count: { $sum: 1 },
        postedCount: countIf(IS_POSTED),
        pendingCount: countIf(IS_PENDING),
        reversedCount: countIf(IS_REVERSED),
      },
    },
    { $sort: { amount: -1 } },
    { $limit: MAX_FEE_GROUPS },
  ]);

  return rows.map((r) => ({
    flow: r._id.flow || null,
    reason: r._id.reason || null,
    currency: r._id.currency || null,
    amount: round2(r.amount),
    // Montant tel que prélevé côté client, avant conversion vers la trésorerie.
    sourceAmount: round2(r.sourceAmount),
    sourceCurrency: r._id.sourceCurrency || null,
    count: r.count,
    postedCount: r.postedCount,
    pendingCount: r.pendingCount,
    reversedCount: r.reversedCount,
  }));
}

async function buildFeesSection({ since, now }) {
  const [byCurrency, periods, byFlow] = await Promise.all([
    revenueByCurrency(FEE_BASE_MATCH, since),
    revenuePeriodTotals(FEE_BASE_MATCH, now),
    feesByFlow(since),
  ]);

  const seriesCurrency = dominantCurrency(byCurrency, "amount");
  const series = await revenueDailySeries(FEE_BASE_MATCH, since, seriesCurrency);

  const entryCount = byCurrency.reduce((n, r) => n + r.count, 0);
  const postedCount = byCurrency.reduce((n, r) => n + r.postedCount, 0);

  // Meilleure source de revenus, au sens du flow qui rapporte le plus.
  const topFlowRow = byFlow.length ? byFlow[0] : null;

  return {
    byCurrency,
    today: {
      since: periods.dayStart,
      byCurrency: periods.byCurrency.map((r) => ({
        currency: r.currency,
        amount: r.todayAmount,
        count: r.todayCount,
      })),
    },
    month: {
      since: periods.monthStart,
      byCurrency: periods.byCurrency.map((r) => ({
        currency: r.currency,
        amount: r.monthAmount,
        count: r.monthCount,
      })),
    },
    seriesCurrency,
    series,
    byFlow,
    topFlow: topFlowRow
      ? {
          flow: topFlowRow.flow,
          reason: topFlowRow.reason,
          amount: topFlowRow.amount,
          currency: topFlowRow.currency,
        }
      : null,
    entryCount,
    postedCount,
    // « Règlements correctement comptabilisés » : part des écritures de frais en
    // statut POSTED. C'est la seule notion de santé réellement portée par le ledger.
    postedRate: entryCount > 0 ? round2((postedCount / entryCount) * 100) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Section « fx » — analytique de la marge de change                           */
/* -------------------------------------------------------------------------- */

const FX_BASE_MATCH = Object.freeze({
  entryType: "FX_REVENUE",
  accountType: "TREASURY",
});

/**
 * Corridors de change.
 *
 * ⚠️ Le couple de devises du corridor n'est PAS dans l'écriture : `metadata`
 * ne porte que la devise de destination (`sourceCurrency`, qui vaut le
 * `toCurrency` du pricing) et le `flow`. Les taux marché/appliqué ne sont pas
 * persistés non plus sur l'écriture. Il faut donc joindre la transaction, qui
 * détient `currencySource`, `currencyTarget` et `pricingSnapshot.result`.
 *
 * Le `$lookup` porte sur `_id` (index) et l'entrée est bornée par la fenêtre
 * temporelle + `MAX_FX_SCAN` : au-delà, on tronque et on le signale.
 */
async function fxCorridors(since) {
  const rows = await aggLedger([
    { $match: { ...FX_BASE_MATCH, createdAt: { $gte: since } } },
    { $sort: { createdAt: -1 } },
    { $limit: MAX_FX_SCAN },
    {
      $lookup: {
        from: runtime.Transaction.collection.name,
        let: { txId: "$transactionId" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$txId"] } } },
          {
            $project: {
              _id: 0,
              currencySource: 1,
              currencyTarget: 1,
              amountSource: 1,
              marketRate: "$pricingSnapshot.result.marketRate",
              appliedRate: "$pricingSnapshot.result.appliedRate",
            },
          },
        ],
        as: "tx",
      },
    },
    { $addFields: { tx: { $arrayElemAt: ["$tx", 0] } } },
    {
      $group: {
        _id: {
          from: { $ifNull: ["$tx.currencySource", null] },
          to: { $ifNull: ["$tx.currencyTarget", null] },
          treasuryCurrency: "$currency",
        },
        margin: sumIf(IS_POSTED, LEDGER_AMOUNT),
        marginInDestination: sumIf(IS_POSTED, num0("$metadata.sourceAmount")),
        destinationCurrency: { $first: "$metadata.sourceCurrency" },
        volumeSource: sumIf(IS_POSTED, num0("$tx.amountSource")),
        marketRate: { $avg: numOrNull("$tx.marketRate") },
        appliedRate: { $avg: numOrNull("$tx.appliedRate") },
        count: { $sum: 1 },
        postedCount: countIf(IS_POSTED),
        pendingCount: countIf(IS_PENDING),
        reversedCount: countIf(IS_REVERSED),
        linkedCount: countIf({ $ne: [{ $ifNull: ["$tx", null] }, null] }),
      },
    },
    { $sort: { margin: -1 } },
    { $limit: MAX_CORRIDORS },
  ]);

  return rows.map((r) => ({
    from: r._id.from || null,
    to: r._id.to || null,
    treasuryCurrency: r._id.treasuryCurrency || null,
    margin: round2(r.margin),
    marginInDestination: round2(r.marginInDestination),
    destinationCurrency: r.destinationCurrency || null,
    // Volume source des transactions portant une marge de change. `null` si
    // aucune transaction n'a pu être jointe, plutôt qu'un 0 qui se lirait
    // comme « aucun volume ».
    volumeSource: r.linkedCount > 0 ? round2(r.volumeSource) : null,
    // Moyennes non pondérées des taux figés dans `pricingSnapshot`. `null`
    // quand aucune transaction jointe ne porte de snapshot de prix.
    marketRate: r.marketRate == null ? null : Number(r.marketRate),
    appliedRate: r.appliedRate == null ? null : Number(r.appliedRate),
    count: r.count,
    postedCount: r.postedCount,
    pendingCount: r.pendingCount,
    reversedCount: r.reversedCount,
    linkedTransactionCount: r.linkedCount,
  }));
}

async function buildFxSection({ since, now }) {
  const [byCurrency, periods, corridors] = await Promise.all([
    revenueByCurrency(FX_BASE_MATCH, since),
    revenuePeriodTotals(FX_BASE_MATCH, now),
    fxCorridors(since),
  ]);

  const seriesCurrency = dominantCurrency(byCurrency, "amount");
  const series = await revenueDailySeries(FX_BASE_MATCH, since, seriesCurrency);

  const entryCount = byCurrency.reduce((n, r) => n + r.count, 0);
  const pendingCount = byCurrency.reduce((n, r) => n + r.pendingCount, 0);
  const reversedCount = byCurrency.reduce((n, r) => n + r.reversedCount, 0);

  return {
    byCurrency,
    today: {
      since: periods.dayStart,
      byCurrency: periods.byCurrency.map((r) => ({
        currency: r.currency,
        amount: r.todayAmount,
        count: r.todayCount,
      })),
    },
    month: {
      since: periods.monthStart,
      byCurrency: periods.byCurrency.map((r) => ({
        currency: r.currency,
        amount: r.monthAmount,
        count: r.monthCount,
      })),
    },
    seriesCurrency,
    series,
    corridors,
    topCorridor: corridors.length ? corridors[0] : null,
    entryCount,
    // « À vérifier avant clôture » : écritures de change non comptabilisées.
    // C'est une mesure réelle, pas un compteur d'alertes métier — il n'existe
    // aucun modèle d'alerte de change dans ce dépôt.
    unsettledCount: pendingCount + reversedCount,
    pendingCount,
    reversedCount,
    corridorsTruncated: entryCount > MAX_FX_SCAN,
  };
}

/* -------------------------------------------------------------------------- */
/* Section « referral » — analytique du parrainage                             */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ Source = `Transaction`, PAS `LedgerEntry`.
 * `internalReferralTransferService.transferReferralBonus()` débite la trésorerie
 * de parrainage et crédite les bénéficiaires sans écrire d'écriture comptable ;
 * il n'y a donc rien à agréger côté ledger. Les seules traces sont les
 * transactions `context: "referral_bonus"` qu'il crée, dont le `metadata` porte
 * le coût réel supporté par la trésorerie.
 */
const REFERRAL_BASE_MATCH = Object.freeze({ context: "referral_bonus" });

const REFERRAL_CONFIRMED = { $eq: ["$status", "confirmed"] };
const TX_AMOUNT = num0("$amount");
const TREASURY_DEBIT = num0("$metadata.treasuryDebitedAmount");

/** Bonus versés aux bénéficiaires, par devise créditée. */
async function referralCreditedByCurrency(since) {
  const rows = await aggTransaction([
    { $match: { ...REFERRAL_BASE_MATCH, createdAt: { $gte: since } } },
    {
      $group: {
        _id: "$currency",
        amount: sumIf(REFERRAL_CONFIRMED, TX_AMOUNT),
        count: { $sum: 1 },
        confirmedCount: countIf(REFERRAL_CONFIRMED),
      },
    },
    { $sort: { amount: -1 } },
    { $limit: MAX_CURRENCIES },
  ]);

  return rows.map((r) => ({
    currency: r._id || null,
    amount: round2(r.amount),
    count: r.count,
    confirmedCount: r.confirmedCount,
  }));
}

/** Coût réel pour la trésorerie de parrainage, par devise de trésorerie. */
async function referralTreasuryCost(since) {
  const rows = await aggTransaction([
    { $match: { ...REFERRAL_BASE_MATCH, createdAt: { $gte: since } } },
    {
      $group: {
        _id: { $ifNull: ["$metadata.treasuryCurrency", null] },
        amount: sumIf(REFERRAL_CONFIRMED, TREASURY_DEBIT),
        count: { $sum: 1 },
        confirmedCount: countIf(REFERRAL_CONFIRMED),
      },
    },
    { $sort: { amount: -1 } },
    { $limit: MAX_CURRENCIES },
  ]);

  return rows.map((r) => ({
    currency: r._id || null,
    amount: round2(r.amount),
    count: r.count,
    confirmedCount: r.confirmedCount,
  }));
}

/**
 * Cumuls « aujourd'hui » et « mois en cours ».
 *
 * Le regroupement porte sur les DEUX devises — celle créditée au bénéficiaire
 * et celle débitée à la trésorerie — parce que ce sont deux grandeurs
 * différentes : le bonus reçu par l'utilisateur et le coût réel supporté par
 * `REFERRAL_TREASURY`. Les mélanger donnerait un chiffre faux.
 */
async function referralPeriodTotals(now) {
  const monthStart = startOfUtcMonth(now);
  const dayStart = startOfUtcDay(now);
  const isToday = { $gte: ["$createdAt", dayStart] };

  const rows = await aggTransaction([
    {
      $match: {
        ...REFERRAL_BASE_MATCH,
        status: "confirmed",
        createdAt: { $gte: monthStart },
      },
    },
    {
      $group: {
        _id: {
          credited: { $ifNull: ["$currency", null] },
          treasury: { $ifNull: ["$metadata.treasuryCurrency", null] },
        },
        monthCredited: { $sum: TX_AMOUNT },
        monthTreasury: { $sum: TREASURY_DEBIT },
        monthCount: { $sum: 1 },
        todayCredited: sumIf(isToday, TX_AMOUNT),
        todayTreasury: sumIf(isToday, TREASURY_DEBIT),
        todayCount: countIf(isToday),
      },
    },
    { $sort: { monthTreasury: -1 } },
    { $limit: 2 * MAX_CURRENCIES },
  ]);

  /** Replie les paires de devises sur une seule des deux dimensions. */
  const fold = (key, amountField, countField) => {
    const map = new Map();

    for (const r of rows) {
      const currency = r._id?.[key] || null;
      const previous = map.get(currency) || { currency, amount: 0, count: 0 };
      previous.amount += Number(r[amountField]) || 0;
      previous.count += Number(r[countField]) || 0;
      map.set(currency, previous);
    }

    return Array.from(map.values())
      .map((e) => ({ ...e, amount: round2(e.amount) }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  };

  return {
    monthStart,
    dayStart,
    todayCredited: fold("credited", "todayCredited", "todayCount"),
    todayTreasury: fold("treasury", "todayTreasury", "todayCount"),
    monthCredited: fold("credited", "monthCredited", "monthCount"),
    monthTreasury: fold("treasury", "monthTreasury", "monthCount"),
  };
}

/** Série hebdomadaire ISO du coût trésorerie, pour UNE devise. */
async function referralWeeklySeries(since, currency) {
  if (!currency) return [];

  const rows = await aggTransaction([
    {
      $match: {
        ...REFERRAL_BASE_MATCH,
        "metadata.treasuryCurrency": currency,
        createdAt: { $gte: since },
      },
    },
    {
      $group: {
        _id: {
          year: { $isoWeekYear: "$createdAt" },
          week: { $isoWeek: "$createdAt" },
        },
        amount: sumIf(REFERRAL_CONFIRMED, TREASURY_DEBIT),
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.year": 1, "_id.week": 1 } },
    { $limit: MAX_WEEK_BUCKETS },
  ]);

  return rows.map((r) => ({
    week: `${r._id.year}-W${String(r._id.week).padStart(2, "0")}`,
    amount: round2(r.amount),
    count: r.count,
  }));
}

/** Dernières récompenses versées. */
async function referralRows(since, { page, limit }) {
  const skip = (page - 1) * limit;

  const rows = await aggTransaction([
    { $match: { ...REFERRAL_BASE_MATCH, createdAt: { $gte: since } } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $project: {
        reference: 1,
        status: 1,
        currency: 1,
        amount: num0("$amount"),
        beneficiaryId: "$receiver",
        beneficiaryName: "$receiverName",
        role: { $ifNull: ["$metadata.role", null] },
        treasuryAmount: num0("$metadata.treasuryDebitedAmount"),
        treasuryCurrency: { $ifNull: ["$metadata.treasuryCurrency", null] },
        nominalAmount: num0("$metadata.nominalBonusAmount"),
        nominalCurrency: { $ifNull: ["$metadata.nominalBonusCurrency", null] },
        treasurySystemType: { $ifNull: ["$metadata.treasurySystemType", null] },
        createdAt: 1,
        confirmedAt: 1,
      },
    },
  ]);

  return rows.map((r) => ({
    id: String(r._id),
    reference: r.reference || null,
    status: r.status || null,
    role: r.role || null,
    beneficiaryId: r.beneficiaryId ? String(r.beneficiaryId) : null,
    beneficiaryName: r.beneficiaryName || null,
    amount: round2(r.amount),
    currency: r.currency || null,
    treasuryAmount: round2(r.treasuryAmount),
    treasuryCurrency: r.treasuryCurrency || null,
    nominalAmount: round2(r.nominalAmount),
    nominalCurrency: r.nominalCurrency || null,
    treasurySystemType: r.treasurySystemType || null,
    createdAt: r.createdAt || null,
    confirmedAt: r.confirmedAt || null,
  }));
}

async function buildReferralSection({ since, now, page, limit }) {
  const match = { ...REFERRAL_BASE_MATCH, createdAt: { $gte: since } };

  const [creditedByCurrency, treasuryCost, periods, rows, total] =
    await Promise.all([
      referralCreditedByCurrency(since),
      referralTreasuryCost(since),
      referralPeriodTotals(now),
      referralRows(since, { page, limit }),
      runtime.Transaction.countDocuments(match).maxTimeMS(AGG_TIMEOUT_MS),
    ]);

  const treasuryCurrency = dominantCurrency(treasuryCost, "amount");
  const series = await referralWeeklySeries(since, treasuryCurrency);

  const rewardsCount = creditedByCurrency.reduce(
    (n, r) => n + r.confirmedCount,
    0
  );

  return {
    creditedByCurrency,
    treasuryCost,
    treasuryCurrency,
    today: {
      since: periods.dayStart,
      creditedByCurrency: periods.todayCredited,
      treasuryByCurrency: periods.todayTreasury,
    },
    month: {
      since: periods.monthStart,
      creditedByCurrency: periods.monthCredited,
      treasuryByCurrency: periods.monthTreasury,
    },
    seriesCurrency: treasuryCurrency,
    series,
    rewardsCount,
    page,
    limit,
    total,
    hasMore: page * limit < total,
    rows,
    // Le back-office doit pouvoir dire d'où viennent ces chiffres : ils ne
    // proviennent pas du grand livre.
    source: "transactions",
  };
}

/* -------------------------------------------------------------------------- */
/* Contrôleur                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/v1/internal/admin/treasury/analytics
 *   ?sections=ledger,fees,fx,referral
 *   &window=24h|7d|30d|90d
 *   &page=1&limit=50
 *   &currency=CAD&entryType=FEE_REVENUE&accountType=TREASURY&status=POSTED
 *
 * Appelé par le backend principal avec `x-internal-token`.
 */
async function getInternalTreasuryAnalytics(req, res, next) {
  try {
    const windowKey = resolveWindow(req.query?.window);
    const sections = resolveSections(req.query?.sections);

    const now = Date.now();
    const since = new Date(now - WINDOWS[windowKey]);
    // Fenêtre précédente de même durée, pour les variations.
    const prevSince = new Date(now - 2 * WINDOWS[windowKey]);

    const page = pickPage(req.query?.page);
    const limit = pickLimit(req.query?.limit);

    const filters = {
      currency: pickCurrency(req.query?.currency),
      entryType: pickFromList(req.query?.entryType, ENTRY_TYPES),
      accountType: pickFromList(req.query?.accountType, ACCOUNT_TYPES),
      status: pickFromList(req.query?.status, LEDGER_STATUSES),
    };

    const builders = {
      ledger: () =>
        buildLedgerSection({ since, prevSince, filters, page, limit }),
      fees: () => buildFeesSection({ since, now }),
      fx: () => buildFxSection({ since, now }),
      referral: () => buildReferralSection({ since, now, page, limit }),
    };

    // Une section en échec ne doit pas vider tout l'écran : on dégrade section
    // par section, comme le fait le tableau de bord.
    const settled = await Promise.allSettled(
      sections.map((key) => builders[key]())
    );

    const degraded = [];
    const data = {};

    sections.forEach((key, i) => {
      const r = settled[i];
      if (r.status === "fulfilled") {
        data[key] = r.value;
      } else {
        data[key] = null;
        degraded.push(key);
        console.error(
          `[TX-CORE][TREASURY] agrégation "${key}" en échec :`,
          r.reason?.message
        );
      }
    });

    // Si absolument tout échoue, c'est une panne, pas une dégradation.
    if (degraded.length === sections.length) {
      return next(createError(503, "Agrégats de trésorerie indisponibles"));
    }

    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: true,
      data: {
        generatedAt: new Date(now).toISOString(),
        window: windowKey,
        since: since.toISOString(),
        until: new Date(now).toISOString(),
        sections,
        filters,
        degraded,
        ...data,
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getInternalTreasuryAnalytics };
