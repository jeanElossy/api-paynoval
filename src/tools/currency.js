"use strict";

const axios = require("axios");
const pino = require("pino");
const BaseCache = require("lru-cache");
const { exchange } = require("../config");

// Logger pour le module de change
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// LRU (support export default ou LRUCache)
const LRUCache = BaseCache.LRUCache || BaseCache;

// TTL “fresh” (ms)
const TTL_MS = Number(exchange?.cacheTTL || 10 * 60 * 1000); // 10min par défaut
// TTL “stale fallback” (ms) -> si API rate-limit, on peut servir du vieux taux
const STALE_TTL_MS = Number(process.env.FX_CACHE_STALE_TTL_MS || 24 * 60 * 60 * 1000); // 24h
const HTTP_TIMEOUT_MS = Number(process.env.FX_HTTP_TIMEOUT_MS || 5000);

// Cache fresh (LRU TTL)
const cache = new LRUCache({ max: 50, ttl: TTL_MS });
// Cache stale (on garde la dernière version connue)
const staleStore = new Map(); // base -> { ts, rates }

// Dédup inflight: base -> Promise<rates>
const inflight = new Map();

// Alias devises -> ISO
const CURRENCY_ALIASES = {
  "FCA": "XOF",
  "FCFA": "XOF",
  "F CFA": "XOF",
  "CFA": "XOF",

  "EURO": "EUR",
  "€": "EUR",

  "USD": "USD",
  "$": "USD",
  "$USD": "USD",
  "US DOLLAR": "USD",

  "CAD": "CAD",
  "$CAD": "CAD",
  "CA$": "CAD",

  "GBP": "GBP",
  "£": "GBP",
  "POUND": "GBP",

  "JPY": "JPY",
  "YEN": "JPY",
  "¥": "JPY",

  "AUD": "AUD",
  "A$": "AUD",

  "CHF": "CHF",
  "SWISS FRANC": "CHF",

  "CNY": "CNY",
  "RMB": "CNY",
  "CN¥": "CNY",

  "HKD": "HKD",
  "HK$": "HKD",

  "SGD": "SGD",
  "SG$": "SGD",

  "NZD": "NZD",
  "NZ$": "NZD",

  "INR": "INR",
  "RUPEE": "INR",
  "₹": "INR",

  "BRL": "BRL",
  "REAL": "BRL",
  "R$": "BRL",

  "MXN": "MXN",
  "MX$": "MXN",

  "ZAR": "ZAR",
  "RAND": "ZAR",

  "SEK": "SEK",
  "KRONA": "SEK",

  "NOK": "NOK",
  "DKK": "DKK",

  "PLN": "PLN",
  "ZŁ": "PLN",

  "THB": "THB",
  "฿": "THB",

  "TRY": "TRY",
  "LIRA": "TRY",
  "₺": "TRY",

  "SAR": "SAR",
  "AED": "AED",

  "PHP": "PHP",
  "₱": "PHP",

  "KRW": "KRW",
  "₩": "KRW",

  "IDR": "IDR",
  "RP": "IDR",
  "Rp": "IDR",

  "VND": "VND",
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

function getStale(base) {
  const item = staleStore.get(base);
  if (!item) return null;
  const age = now() - item.ts;
  if (age <= STALE_TTL_MS && item.rates && typeof item.rates === "object") return item.rates;
  return null;
}

function setStale(base, rates) {
  staleStore.set(base, { ts: now(), rates });
}

/**
 * Fetch depuis l’API externe définie dans config.
 * Supporte v4 ("rates") et v6 ("conversion_rates").
 */
async function fetchRatesFromApi(base) {
  const baseNorm = normalizeCurrencyCode(base);
  if (!baseNorm) throw new Error(`Invalid currency code: ${base}`);

  // Ton config exchange.apiUrl ressemble à ".../v6/<key>/latest/XOF"
  // On garde ton approche mais on gère mieux 429.
  const apiUrl = String(exchange?.apiUrl || "").trim();
  if (!apiUrl) throw new Error("exchange.apiUrl manquant");

  const root = apiUrl.replace(/\/latest\/.*$/, "").replace(/\/+$/, "");
  const url = `${root}/latest/${encodeURIComponent(baseNorm)}`;

  // Pour v4 certaines API passent apiKey en query
  const params = !/\/v6\//.test(root) && exchange?.apiKey ? { apiKey: exchange.apiKey } : {};

  logger.info({ url, params }, "Appel Exchange API");

  const resp = await axios.get(url, {
    params,
    timeout: HTTP_TIMEOUT_MS,
    validateStatus: (s) => s >= 200 && s < 500, // on gère 429 proprement
  });

  if (resp.status === 429) {
    const err = new Error("Exchange API rate-limited (429)");
    err.code = "FX_RATE_LIMIT";
    err.status = 429;
    throw err;
  }

  if (resp.status !== 200) {
    const err = new Error(`Exchange API error: ${resp.status}`);
    err.code = "FX_HTTP_ERROR";
    err.status = resp.status;
    err.data = resp.data;
    throw err;
  }

  const data = resp.data || {};
  const rates = data.conversion_rates || data.rates;
  if (!rates || typeof rates !== "object") {
    const err = new Error("Exchange API returned unexpected payload");
    err.code = "FX_BAD_PAYLOAD";
    err.data = data;
    throw err;
  }

  return rates;
}

/**
 * Récupère les taux (cache + API)
 * - cache TTL
 * - inflight dedup
 * - fallback stale on 429/erreurs
 */
async function getRates(rawBase) {
  const base = normalizeCurrencyCode(rawBase);
  if (!base) throw new Error(`Invalid currency code: ${rawBase}`);

  // fresh cache
  if (cache.has(base)) {
    logger.debug({ base }, "Taux depuis cache (fresh)");
    return cache.get(base);
  }

  // inflight dedup
  if (inflight.has(base)) {
    logger.debug({ base }, "Taux inflight (dedup)");
    return inflight.get(base);
  }

  const p = (async () => {
    try {
      const rates = await fetchRatesFromApi(base);
      cache.set(base, rates);
      setStale(base, rates);
      logger.info({ base, timestamp: now() }, "Taux mis en cache");
      return rates;
    } catch (e) {
      // fallback stale
      const fallback = getStale(base);
      if (fallback) {
        logger.warn(
          { base, err: e?.code || e?.message || e },
          "FX API indisponible/429 -> fallback stale rates"
        );
        return fallback;
      }
      throw e;
    } finally {
      inflight.delete(base);
    }
  })();

  inflight.set(base, p);
  return p;
}

function clearCache() {
  cache.clear();
  staleStore.clear();
  inflight.clear();
  logger.info("Cache FX vidé");
}

/**
 * Convertit un montant d'une devise à une autre
 * @returns {Promise<{rate:number, converted:number}>}
 */
async function convertAmount(from, to, amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Montant invalide pour conversion");
  }

  const fromCode = normalizeCurrencyCode(from);
  const toCode = normalizeCurrencyCode(to);

  if (!fromCode || !toCode) {
    throw new Error(`Devise invalide: from=${from} to=${to}`);
  }

  // Même devise => taux 1
  if (fromCode === toCode) {
    return { rate: 1, converted: Number(value.toFixed(2)) };
  }

  const rates = await getRates(fromCode);
  const rate = Number(rates[toCode]);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Devise non supportée : ${toCode}`);
  }

  const converted = Number((value * rate).toFixed(2));
  return { rate, converted };
}

module.exports = { getRates, clearCache, convertAmount };
