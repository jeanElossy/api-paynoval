"use strict";

const { TREASURY_SYSTEM_TYPES } = require("../treasuryRegistry");

const SERIES_DAYS = 30;
const DAY_MS = 86400000;

const round2 = (value) => Math.round(value * 100) / 100;

/** A balance that cannot be read stays null: it must never count as zero. */
function readAmount(value) {
  if (value === undefined || value === null) return 0;
  const amount = Number(String(value));
  return Number.isFinite(amount) ? amount : null;
}

function balanceOf(system, currency) {
  const balances = system?.balances;
  const raw = typeof balances?.get === "function" ? balances.get(currency) : balances?.[currency];
  return readAmount(raw);
}

function currenciesOf(systems) {
  const found = new Set();

  for (const system of systems) {
    const balances = system?.balances;
    const keys = typeof balances?.keys === "function" ? [...balances.keys()] : Object.keys(balances || {});
    keys.forEach((key) => found.add(String(key).toUpperCase()));
  }

  return [...found].sort();
}

/** `treasury:<SYSTEM_TYPE>:<userId>:<CUR>` → `SYSTEM_TYPE`, or null. */
function systemTypeOf(accountId) {
  const parts = String(accountId || "").split(":");
  return parts[0] === "treasury" ? parts[1] || null : null;
}

function stateOf(system, available) {
  if (available === null) return "unreadable";
  if (!system.isActive) return "inactive";
  return available > 0 ? "normal" : "empty";
}

/** One line per day, oldest first: a day without an entry is a real zero. */
function fillDays(rows, now) {
  const byDay = new Map(rows.map((row) => [row.day, row]));

  return Array.from({ length: SERIES_DAYS }, (_, index) => {
    const day = new Date(now - (SERIES_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10);
    return { day, net: byDay.get(day)?.net ?? 0 };
  });
}

/** Sum by system type of ledger rows grouped by account. */
function bySystemType(rows) {
  const totals = new Map();

  for (const row of rows) {
    const type = systemTypeOf(row._id);
    if (type) totals.set(type, (totals.get(type) || 0) + row.amount);
  }

  return totals;
}

/**
 * Position of the treasury accounts in ONE currency. Amounts of different
 * currencies are never added. Pure: the reads are in the controller.
 */
function buildPosition({ systems, currency, pending, lastDay, today, series, moves, now }) {
  const treasuries = systems.filter((system) => TREASURY_SYSTEM_TYPES.includes(system.systemType));
  const pendingByType = bySystemType(pending);
  const dayByType = bySystemType(lastDay);

  const accounts = TREASURY_SYSTEM_TYPES.map((type) => {
    const system = treasuries.find((item) => item.systemType === type);
    if (!system) return { systemType: type, available: null, reserved: null, net24h: null, state: "missing" };

    const available = balanceOf(system, currency);

    return {
      systemType: type,
      available,
      reserved: round2(pendingByType.get(type) || 0),
      net24h: round2(dayByType.get(type) || 0),
      state: stateOf(system, available),
    };
  });

  // A treasury not created yet holds nothing; an unreadable one could hold anything.
  const held = accounts.filter((account) => account.state !== "missing");
  const known = held.length > 0 && held.every((account) => account.available !== null);
  const available = known ? round2(held.reduce((sum, account) => sum + account.available, 0)) : null;
  const reserved = round2(accounts.reduce((sum, account) => sum + (account.reserved || 0), 0));

  return {
    currency,
    currencies: currenciesOf(treasuries),
    totals: {
      position: available === null ? null : round2(available + reserved),
      available,
      reserved,
      netToday: round2(today),
    },
    accounts,
    series: fillDays(series, now),
    moves,
    readAt: new Date(now).toISOString(),
  };
}

module.exports = { SERIES_DAYS, buildPosition, currenciesOf, readAmount, systemTypeOf };
