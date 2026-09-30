"use strict";

/**
 * TRANSACTION INSIGHTS — "where did my money go", computed on the WHOLE history.
 *
 * The mobile charts used to aggregate the transactions it had downloaded (the
 * first page, then whatever the user scrolled), re-reading amounts from the
 * DISPLAYED TEXT. A user with more history than one page saw wrong totals.
 * Revolut / Wise compute insights server side; so does this module.
 *
 * Rules (each one a finance rule, not a presentation choice):
 *   - only CONFIRMED transactions count (a pending or cancelled one moved nothing);
 *   - the amount is the one of the USER's side: debited amount + source currency
 *     when the user pays, credited amount + target currency when the user receives;
 *   - currencies are NEVER added together: one bucket per ISO currency;
 *   - sums are exact, in minor units (BigInt) — no float accumulation;
 *   - an unreadable amount or currency is EXCLUDED and counted, never read as 0.
 *
 * Pure: no database, no clock (the caller passes `now`).
 */

const { decimalsForCurrency } = require("../../../utils/money");

const DAY_MS = 24 * 60 * 60 * 1000;

const RANGES = Object.freeze({
  "7d": { days: 7, series: "day" },
  "30d": { days: 30, series: "day" },
  "90d": { days: 90, series: "day" },
  month: { days: null, series: "day" },
  "12m": { days: 365, series: "month" },
});

const CATEGORY = Object.freeze({
  TRANSFER_SENT: "TRANSFER_SENT",
  TRANSFER_RECEIVED: "TRANSFER_RECEIVED",
  DEPOSIT: "DEPOSIT",
  WITHDRAWAL: "WITHDRAWAL",
  CAGNOTTE: "CAGNOTTE",
  BONUS: "BONUS",
  ADJUSTMENT: "ADJUSTMENT",
  PURCHASE: "PURCHASE",
  OTHER: "OTHER",
});

const CHANNEL = Object.freeze({
  PAYNOVAL: "paynoval",
  MOBILEMONEY: "mobilemoney",
  CARD: "card",
});

const ISO = /^[A-Z]{3}$/;

const idOf = (value) => {
  if (!value) return "";
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
};

const readCurrency = (value) => {
  const code = String(value || "").trim().toUpperCase();
  return ISO.test(code) ? code : null;
};

/** Decimal string / Decimal128 / number → BigInt minor units, or null. */
function toMinorUnits(value, currency) {
  if (value === null || value === undefined || value === "") return null;

  const text = String(typeof value === "object" && value.toString ? value.toString() : value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;

  const decimals = decimalsForCurrency(currency);
  const negative = text.startsWith("-");
  const [intPart, fracPart = ""] = text.replace("-", "").split(".");

  const padded = (fracPart + "0".repeat(decimals + 1)).slice(0, decimals + 1);
  let minor = BigInt(intPart + padded.slice(0, decimals) || "0");

  // Round half up on the first dropped digit.
  if (Number(padded[decimals] || "0") >= 5) minor += 1n;

  return negative ? -minor : minor;
}

function fromMinorUnits(minor, currency) {
  const decimals = decimalsForCurrency(currency);
  return Number(minor) / 10 ** decimals;
}

function channelOf(tx) {
  const flow = String(tx?.flow || "");
  if (flow.includes("MOBILEMONEY")) return CHANNEL.MOBILEMONEY;
  if (flow.includes("CARD")) return CHANNEL.CARD;
  return CHANNEL.PAYNOVAL;
}

/**
 * The user's side of one transaction: `{ direction, amountMinor, currency,
 * category, channel, at }`, `{ excluded: reason }`, or `null` when the
 * transaction does not concern the user.
 */
function classifyTransaction(tx, userId) {
  const uid = String(userId || "");
  if (!uid || !tx) return null;

  const isSender = idOf(tx.sender) === uid || idOf(tx.userId) === uid;
  const isReceiver = idOf(tx.receiver) === uid || idOf(tx.receiverUserId) === uid;
  if (!isSender && !isReceiver) return null;

  const flow = String(tx.flow || "");
  const kind = String(tx.operationKind || "transfer");

  let direction = null;
  let category = CATEGORY.OTHER;

  if (kind === "bonus" || kind === "cashback") {
    direction = "credit";
    category = CATEGORY.BONUS;
  } else if (kind === "adjustment_credit") {
    direction = "credit";
    category = CATEGORY.ADJUSTMENT;
  } else if (kind === "adjustment_debit") {
    direction = "debit";
    category = CATEGORY.ADJUSTMENT;
  } else if (kind === "cagnotte_participation") {
    direction = isSender ? "debit" : "credit";
    category = CATEGORY.CAGNOTTE;
  } else if (kind === "cagnotte_withdrawal") {
    direction = "credit";
    category = CATEGORY.CAGNOTTE;
  } else if (kind === "purchase") {
    direction = "debit";
    category = CATEGORY.PURCHASE;
  } else if (flow === "MOBILEMONEY_COLLECTION_TO_PAYNOVAL" || flow === "CARD_TOPUP_TO_PAYNOVAL") {
    direction = "credit";
    category = CATEGORY.DEPOSIT;
  } else if (flow === "PAYNOVAL_TO_MOBILEMONEY_PAYOUT" || flow === "PAYNOVAL_TO_CARD_PAYOUT") {
    direction = "debit";
    category = CATEGORY.WITHDRAWAL;
  } else if (isSender && !isReceiver) {
    direction = "debit";
    category = CATEGORY.TRANSFER_SENT;
  } else if (isReceiver && !isSender) {
    direction = "credit";
    category = CATEGORY.TRANSFER_RECEIVED;
  } else {
    // Sender AND receiver (own-account move): not income, not spending.
    return null;
  }

  /**
   * The user's side: what LEFT the wallet on a debit (source), what ARRIVED on
   * a credit (target). A credit whose target is absent falls back on the
   * source pair only when the source currency is the only one known (single-
   * currency credits such as bonuses) — never mixing an amount of one pair
   * with the currency of the other.
   */
  const pairs =
    direction === "debit"
      ? [[tx.amountSource, tx.currencySource]]
      : [
          [tx.amountTarget, tx.currencyTarget],
          ...(tx.amountTarget == null && tx.currencyTarget == null
            ? [[tx.amountSource, tx.currencySource]]
            : []),
        ];

  for (const [amount, rawCurrency] of pairs) {
    const currency = readCurrency(rawCurrency);
    if (!currency) continue;

    const minor = toMinorUnits(amount, currency);
    if (minor === null || minor <= 0n) continue;

    const at = new Date(tx.confirmedAt || tx.createdAt || 0).getTime();
    if (!Number.isFinite(at) || at <= 0) return { excluded: "date" };

    return { direction, amountMinor: minor, currency, category, channel: channelOf(tx), at };
  }

  return { excluded: "amount" };
}

/** Start of the window for a range, from `now` (ms). */
function rangeStart(range, now) {
  const spec = RANGES[range] || RANGES["30d"];
  if (spec.days) return now - spec.days * DAY_MS;

  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const monthKey = (t) => new Date(t).toISOString().slice(0, 7);

function emptyBucket(currency) {
  return {
    currency,
    incomeMinor: 0n,
    expenseMinor: 0n,
    count: 0,
    byCategory: { income: new Map(), expense: new Map() },
    byChannel: { income: new Map(), expense: new Map() },
    series: new Map(),
  };
}

const add = (map, key, minor) => map.set(key, (map.get(key) || 0n) + minor);

/**
 * Aggregates a stream (any iterable) of transactions for one user.
 * Returns plain JSON: one entry per currency, amounts in major units.
 */
function aggregateInsights(transactions, { userId, range = "30d", now = Date.now() } = {}) {
  const spec = RANGES[range] || RANGES["30d"];
  const from = rangeStart(range, now);
  const buckets = new Map();
  const excluded = { amount: 0, date: 0 };
  let considered = 0;

  for (const tx of transactions || []) {
    if (String(tx?.status || "") !== "confirmed") continue;

    const side = classifyTransaction(tx, userId);
    if (!side) continue;

    considered += 1;

    if (side.excluded) {
      excluded[side.excluded] += 1;
      continue;
    }

    if (side.at < from || side.at > now) continue;

    const bucket = buckets.get(side.currency) || emptyBucket(side.currency);
    buckets.set(side.currency, bucket);

    const flowKey = side.direction === "credit" ? "income" : "expense";
    if (flowKey === "income") bucket.incomeMinor += side.amountMinor;
    else bucket.expenseMinor += side.amountMinor;

    bucket.count += 1;
    add(bucket.byCategory[flowKey], side.category, side.amountMinor);
    add(bucket.byChannel[flowKey], side.channel, side.amountMinor);

    const key = spec.series === "month" ? monthKey(side.at) : dayKey(side.at);
    const point = bucket.series.get(key) || { in: 0n, out: 0n };
    if (flowKey === "income") point.in += side.amountMinor;
    else point.out += side.amountMinor;
    bucket.series.set(key, point);
  }

  const toList = (map, currency) =>
    [...map.entries()]
      .map(([key, minor]) => ({ key, amount: fromMinorUnits(minor, currency) }))
      .sort((a, b) => b.amount - a.amount);

  const currencies = [...buckets.values()]
    .map((b) => ({
      currency: b.currency,
      income: fromMinorUnits(b.incomeMinor, b.currency),
      expense: fromMinorUnits(b.expenseMinor, b.currency),
      net: fromMinorUnits(b.incomeMinor - b.expenseMinor, b.currency),
      count: b.count,
      byCategory: {
        income: toList(b.byCategory.income, b.currency),
        expense: toList(b.byCategory.expense, b.currency),
      },
      byChannel: {
        income: toList(b.byChannel.income, b.currency),
        expense: toList(b.byChannel.expense, b.currency),
      },
      series: [...b.series.entries()]
        .sort(([a], [b2]) => (a < b2 ? -1 : 1))
        .map(([period, p]) => ({
          period,
          in: fromMinorUnits(p.in, b.currency),
          out: fromMinorUnits(p.out, b.currency),
        })),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    range: RANGES[range] ? range : "30d",
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    seriesUnit: spec.series,
    currencies,
    excluded,
    considered,
  };
}

module.exports = {
  RANGES,
  CATEGORY,
  CHANNEL,
  toMinorUnits,
  fromMinorUnits,
  classifyTransaction,
  rangeStart,
  aggregateInsights,
};
