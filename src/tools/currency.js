"use strict";

const axios = require("axios");
const pino = require("pino");
const BaseCache = require("lru-cache");
const config = require("../config");

// Logger pour le module de change
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// LRU (support export default ou LRUCache)
const LRUCache = BaseCache.LRUCache || BaseCache;

// TTL “fresh” (ms)
const TTL_MS = Number(process.env.FX_CACHE_TTL_MS || config?.exchange?.cacheTTL || 10 * 60 * 1000); // 10min
// TTL “stale fallback” (ms)
const STALE_TTL_MS = Number(process.env.FX_CACHE_STALE_TTL_MS || 24 * 60 * 60 * 1000); // 24h
const HTTP_TIMEOUT_MS = Number(process.env.FX_HTTP_TIMEOUT_MS || 5000);

// Cache fresh (LRU TTL) : key "FROM->TO" -> rate
const cache = new LRUCache({ max: 200, ttl: TTL_MS });
// Cache stale (dernière valeur connue)
const staleStore = new Map(); // key "FROM->TO" -> { ts, rate }

// Dédup inflight: key -> Promise<{rate, converted}>
const inflight = new Map();

// URL backend principal (source des taux en DB)
const PRINCIPAL_URL = String(config?.principalUrl || process.env.PRINCIPAL_URL || "").replace(/\/+$/, "");
const INTERNAL_TOKEN = String(process.env.INTERNAL_TOKEN || config?.internalToken || "");

// Alias devises -> ISO
const CURRENCY_ALIASES = {
  FCA: "XOF",
  FCFA: "XOF",
  "F CFA": "XOF",
  CFA: "XOF",

  EURO: "EUR",
  "€": "EUR",

  USD: "USD",
  $: "USD",
  $USD: "USD",
  "US DOLLAR": "USD",

  CAD: "CAD",
  $CAD: "CAD",
  "CA$": "CAD",

  GBP: "GBP",
  "£": "GBP",
  POUND: "GBP",

  JPY: "JPY",
  YEN: "JPY",
  "¥": "JPY",

  AUD: "AUD",
  "A$": "AUD",

  CHF: "CHF",
  "SWISS FRANC": "CHF",

  CNY: "CNY",
  RMB: "CNY",
  "CN¥": "CNY",

  HKD: "HKD",
  "HK$": "HKD",

  SGD: "SGD",
  "SG$": "SGD",

  NZD: "NZD",
  "NZ$": "NZD",

  INR: "INR",
  RUPEE: "INR",
  "₹": "INR",

  BRL: "BRL",
  REAL: "BRL",
  "R$": "BRL",

  MXN: "MXN",
  "MX$": "MXN",

  ZAR: "ZAR",
  RAND: "ZAR",

  SEK: "SEK",
  KRONA: "SEK",

  NOK: "NOK",
  DKK: "DKK",

  PLN: "PLN",
  "ZŁ": "PLN",

  THB: "THB",
  "฿": "THB",

  TRY: "TRY",
  LIRA: "TRY",
  "₺": "TRY",

  SAR: "SAR",
  AED: "AED",

  PHP: "PHP",
  "₱": "PHP",

  KRW: "KRW",
  "₩": "KRW",

  IDR: "IDR",
  RP: "IDR",
  Rp: "IDR",

  VND: "VND",
  "₫": "VND",
};

function now() {
  return Date.now();
}

function normalizeCurrencyCode(raw) {
  let k = String(raw || "").trim().toUpperCase();
  if (!k) return "";

  // applique alias
  k = CURRENCY_ALIASES[k] || k;

  // retire tout sauf A-Z
  k = k.replace(/[^A-Z]/g, "");

  if (!/^[A-Z]{3}$/.test(k)) return "";
  return k;
}

function makeKey(fromISO, toISO) {
  return `${fromISO}->${toISO}`;
}

function getStaleRate(key) {
  const item = staleStore.get(key);
  if (!item) return null;
  const age = now() - item.ts;
  if (age <= STALE_TTL_MS && Number.isFinite(item.rate) && item.rate > 0) return item.rate;
  return null;
}

function setStaleRate(key, rate) {
  staleStore.set(key, { ts: now(), rate });
}

/**
 * ✅ FX interne via backend principal (DB rates)
 * GET /api/v1/exchange-rates/rate?from=XOF&to=EUR
 * Retour attendu: { success:true, rate: <number> } OU { success:true, data:{rate:<number>} }
 */
async function fetchRateFromInternal(fromISO, toISO) {
  if (!PRINCIPAL_URL) {
    const err = new Error("PRINCIPAL_URL manquant (config.principalUrl ou env PRINCIPAL_URL)");
    err.code = "FX_INTERNAL_MISSING_PRINCIPAL_URL";
    throw err;
  }

  const url = `${PRINCIPAL_URL}/api/v1/exchange-rates/rate`;

  const resp = await axios.get(url, {
    params: { from: fromISO, to: toISO },
    timeout: HTTP_TIMEOUT_MS,
    headers: {
      "Content-Type": "application/json",
      ...(INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : {}),
    },
    validateStatus: (s) => s >= 200 && s < 500,
  });

  if (resp.status !== 200) {
    const err = new Error(`Internal FX error: HTTP ${resp.status}`);
    err.code = "FX_INTERNAL_HTTP";
    err.status = resp.status;
    err.data = resp.data;
    throw err;
  }

  const d = resp.data || {};
  const rate =
    (Number.isFinite(Number(d.rate)) ? Number(d.rate) : null) ||
    (Number.isFinite(Number(d?.data?.rate)) ? Number(d.data.rate) : null) ||
    (Number.isFinite(Number(d?.data?.value)) ? Number(d.data.value) : null);

  if (!Number.isFinite(rate) || rate <= 0) {
    const err = new Error("Internal FX returned invalid rate");
    err.code = "FX_INTERNAL_BAD_PAYLOAD";
    err.data = d;
    throw err;
  }

  return rate;
}

/**
 * Convertit un montant d'une devise à une autre
 * @returns {Promise<{rate:number, converted:number}>}
 */
async function convertAmount(from, to, amount) {
  const value = Number(amount);

  // ✅ 0 autorisé, négatif interdit
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Montant invalide pour conversion");
  }

  const fromISO = normalizeCurrencyCode(from);
  const toISO = normalizeCurrencyCode(to);

  if (!fromISO || !toISO) {
    throw new Error(`Devise invalide: from=${from} to=${to}`);
  }

  // même devise
  if (fromISO === toISO) {
    return { rate: 1, converted: Number(value.toFixed(2)) };
  }

  // ✅ montant 0 => pas besoin FX
  if (value === 0) {
    return { rate: 0, converted: 0 };
  }

  const key = makeKey(fromISO, toISO);

  // cache fresh
  if (cache.has(key)) {
    const r = Number(cache.get(key));
    return { rate: r, converted: Number((value * r).toFixed(2)) };
  }

  // inflight dedup
  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const p = (async () => {
    try {
      const rate = await fetchRateFromInternal(fromISO, toISO);

      cache.set(key, rate);
      setStaleRate(key, rate);

      logger.info({ from: fromISO, to: toISO, rate }, "FX interne OK (cache)");
      return { rate, converted: Number((value * rate).toFixed(2)) };
    } catch (e) {
      const staleRate = getStaleRate(key);
      if (staleRate) {
        logger.warn(
          { from: fromISO, to: toISO, rate: staleRate, err: e?.code || e?.message || e },
          "FX interne KO -> fallback stale"
        );
        return { rate: staleRate, converted: Number((value * staleRate).toFixed(2)) };
      }
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

function clearCache() {
  cache.clear();
  staleStore.clear();
  inflight.clear();
  logger.info("Cache FX vidé");
}

module.exports = { convertAmount, clearCache };
