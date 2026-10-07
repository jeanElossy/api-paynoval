"use strict";

/**
 * GET /transactions/insights?range=7d|30d|90d|month|12m
 *
 * Totals, categories, channels and a time series of the user's CONFIRMED
 * transactions over the whole window — per currency, never mixed. The mobile
 * charts used to compute this on the pages they had downloaded. Pure logic:
 * `insights/transactionInsights.js`.
 *
 * Streams a narrow projection (no secret, no personal field) through a
 * cursor on the existing `{sender|receiver|userId, createdAt}` indexes.
 * Bounded by `MAX_DOCS`: past it, the answer says `truncated: true` instead of
 * pretending to be complete.
 */

const runtime = require("../shared/runtime");
const { pickAuthedUserId } = require("../shared/helpers");
const { buildOwnershipQuery } = require("../shared/ownershipQuery");
const { resolveHistoryStart } = require("../../sandbox/historyWindow");
const {
  RANGES,
  aggregateInsights,
  rangeStart,
} = require("../insights/transactionInsights");

const MAX_DOCS = 20000;

const INSIGHTS_PROJECTION = Object.freeze({
  _id: 0,
  sender: 1,
  receiver: 1,
  userId: 1,
  receiverUserId: 1,
  status: 1,
  flow: 1,
  operationKind: 1,
  amountSource: 1,
  currencySource: 1,
  amountTarget: 1,
  currencyTarget: 1,
  createdAt: 1,
  confirmedAt: 1,
});

function createInsightsHandler({
  Transaction,
  now = () => Date.now(),
  maxDocs = MAX_DOCS,
  resolveHistoryStart = async () => null,
} = {}) {
  if (!Transaction) throw new Error("insights : dépendance `Transaction` manquante");

  return async function transactionInsights(req, res, next) {
    try {
      const userId = pickAuthedUserId(req);
      if (!userId) return res.status(401).json({ success: false, message: "Non autorisé" });

      const range = RANGES[req.query.range] ? req.query.range : "30d";
      const at = now();
      const rangeFrom = new Date(rangeStart(range, at));
      // Compte sandbox réinitialisé : rien d'antérieur à la réinitialisation.
      const historyStart = await resolveHistoryStart(req);
      const from = historyStart && historyStart > rangeFrom ? historyStart : rangeFrom;

      const query = {
        ...buildOwnershipQuery(Transaction, userId),
        status: "confirmed",
        createdAt: { $gte: from },
      };

      const docs = [];
      let truncated = false;

      const cursor = Transaction.find(query, INSIGHTS_PROJECTION)
        .sort({ createdAt: -1 })
        .limit(maxDocs + 1)
        .lean()
        .cursor();

      for await (const doc of cursor) {
        if (docs.length >= maxDocs) {
          truncated = true;
          break;
        }
        docs.push(doc);
      }

      const data = aggregateInsights(docs, { userId, range, now: at });

      return res.json({ success: true, data: { ...data, truncated } });
    } catch (err) {
      return next(err);
    }
  };
}

let _composed = null;

function transactionInsights(req, res, next) {
  if (!_composed) {
    _composed = createInsightsHandler({
      Transaction: runtime.Transaction,
      resolveHistoryStart,
    });
  }
  return _composed(req, res, next);
}

module.exports = {
  transactionInsights,
  createInsightsHandler,
  INSIGHTS_PROJECTION,
  MAX_DOCS,
};
