// "use strict";

// const axios = require("axios");
// const pino = require("pino");
// const BaseCache = require("lru-cache");
// const config = require("../config");

// // Logger pour le module de change
// const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// // LRU (support export default ou LRUCache)
// const LRUCache = BaseCache.LRUCache || BaseCache;

// // TTL “fresh” (ms)
// const TTL_MS = Number(process.env.FX_CACHE_TTL_MS || config?.exchange?.cacheTTL || 10 * 60 * 1000); // 10min
// // TTL “stale fallback” (ms)
// const STALE_TTL_MS = Number(process.env.FX_CACHE_STALE_TTL_MS || 24 * 60 * 60 * 1000); // 24h
// const HTTP_TIMEOUT_MS = Number(process.env.FX_HTTP_TIMEOUT_MS || 5000);

// // Cache fresh (LRU TTL) : key "FROM->TO" -> rate
// const cache = new LRUCache({ max: 200, ttl: TTL_MS });
// // Cache stale (dernière valeur connue)
// const staleStore = new Map(); // key "FROM->TO" -> { ts, rate }

// // Dédup inflight: key -> Promise<{rate, converted}>
// const inflight = new Map();

// // URL backend principal (source des taux en DB)
// const PRINCIPAL_URL = String(config?.principalUrl || process.env.PRINCIPAL_URL || "").replace(/\/+$/, "");
// const INTERNAL_TOKEN = String(process.env.INTERNAL_TOKEN || config?.internalToken || "");

// // Alias devises -> ISO
// const CURRENCY_ALIASES = {
//   FCA: "XOF",
//   FCFA: "XOF",
//   "F CFA": "XOF",
//   CFA: "XOF",

//   EURO: "EUR",
//   "€": "EUR",

//   USD: "USD",
//   $: "USD",
//   $USD: "USD",
//   "US DOLLAR": "USD",

//   CAD: "CAD",
//   $CAD: "CAD",
//   "CA$": "CAD",

//   GBP: "GBP",
//   "£": "GBP",
//   POUND: "GBP",

//   JPY: "JPY",
//   YEN: "JPY",
//   "¥": "JPY",

//   AUD: "AUD",
//   "A$": "AUD",

//   CHF: "CHF",
//   "SWISS FRANC": "CHF",

//   CNY: "CNY",
//   RMB: "CNY",
//   "CN¥": "CNY",

//   HKD: "HKD",
//   "HK$": "HKD",

//   SGD: "SGD",
//   "SG$": "SGD",

//   NZD: "NZD",
//   "NZ$": "NZD",

//   INR: "INR",
//   RUPEE: "INR",
//   "₹": "INR",

//   BRL: "BRL",
//   REAL: "BRL",
//   "R$": "BRL",

//   MXN: "MXN",
//   "MX$": "MXN",

//   ZAR: "ZAR",
//   RAND: "ZAR",

//   SEK: "SEK",
//   KRONA: "SEK",

//   NOK: "NOK",
//   DKK: "DKK",

//   PLN: "PLN",
//   "ZŁ": "PLN",

//   THB: "THB",
//   "฿": "THB",

//   TRY: "TRY",
//   LIRA: "TRY",
//   "₺": "TRY",

//   SAR: "SAR",
//   AED: "AED",

//   PHP: "PHP",
//   "₱": "PHP",

//   KRW: "KRW",
//   "₩": "KRW",

//   IDR: "IDR",
//   RP: "IDR",
//   Rp: "IDR",

//   VND: "VND",
//   "₫": "VND",
// };

// function now() {
//   return Date.now();
// }

// function normalizeCurrencyCode(raw) {
//   let k = String(raw || "").trim().toUpperCase();
//   if (!k) return "";

//   // applique alias
//   k = CURRENCY_ALIASES[k] || k;

//   // retire tout sauf A-Z
//   k = k.replace(/[^A-Z]/g, "");

//   if (!/^[A-Z]{3}$/.test(k)) return "";
//   return k;
// }

// function makeKey(fromISO, toISO) {
//   return `${fromISO}->${toISO}`;
// }

// function getStaleRate(key) {
//   const item = staleStore.get(key);
//   if (!item) return null;
//   const age = now() - item.ts;
//   if (age <= STALE_TTL_MS && Number.isFinite(item.rate) && item.rate > 0) return item.rate;
//   return null;
// }

// function setStaleRate(key, rate) {
//   staleStore.set(key, { ts: now(), rate });
// }

// /**
//  * ✅ FX interne via backend principal (DB rates)
//  * GET /api/v1/exchange-rates/rate?from=XOF&to=EUR
//  * Retour attendu: { success:true, rate: <number> } OU { success:true, data:{rate:<number>} }
//  */
// async function fetchRateFromInternal(fromISO, toISO) {
//   if (!PRINCIPAL_URL) {
//     const err = new Error("PRINCIPAL_URL manquant (config.principalUrl ou env PRINCIPAL_URL)");
//     err.code = "FX_INTERNAL_MISSING_PRINCIPAL_URL";
//     throw err;
//   }

//   const url = `${PRINCIPAL_URL}/api/v1/exchange-rates/rate`;

//   const resp = await axios.get(url, {
//     params: { from: fromISO, to: toISO },
//     timeout: HTTP_TIMEOUT_MS,
//     headers: {
//       "Content-Type": "application/json",
//       ...(INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : {}),
//     },
//     validateStatus: (s) => s >= 200 && s < 500,
//   });

//   if (resp.status !== 200) {
//     const err = new Error(`Internal FX error: HTTP ${resp.status}`);
//     err.code = "FX_INTERNAL_HTTP";
//     err.status = resp.status;
//     err.data = resp.data;
//     throw err;
//   }

//   const d = resp.data || {};
//   const rate =
//     (Number.isFinite(Number(d.rate)) ? Number(d.rate) : null) ||
//     (Number.isFinite(Number(d?.data?.rate)) ? Number(d.data.rate) : null) ||
//     (Number.isFinite(Number(d?.data?.value)) ? Number(d.data.value) : null);

//   if (!Number.isFinite(rate) || rate <= 0) {
//     const err = new Error("Internal FX returned invalid rate");
//     err.code = "FX_INTERNAL_BAD_PAYLOAD";
//     err.data = d;
//     throw err;
//   }

//   return rate;
// }

// /**
//  * Convertit un montant d'une devise à une autre
//  * @returns {Promise<{rate:number, converted:number}>}
//  */
// async function convertAmount(from, to, amount) {
//   const value = Number(amount);

//   // ✅ 0 autorisé, négatif interdit
//   if (!Number.isFinite(value) || value < 0) {
//     throw new Error("Montant invalide pour conversion");
//   }

//   const fromISO = normalizeCurrencyCode(from);
//   const toISO = normalizeCurrencyCode(to);

//   if (!fromISO || !toISO) {
//     throw new Error(`Devise invalide: from=${from} to=${to}`);
//   }

//   // même devise
//   if (fromISO === toISO) {
//     return { rate: 1, converted: Number(value.toFixed(2)) };
//   }

//   // ✅ montant 0 => pas besoin FX
//   if (value === 0) {
//     return { rate: 0, converted: 0 };
//   }

//   const key = makeKey(fromISO, toISO);

//   // cache fresh
//   if (cache.has(key)) {
//     const r = Number(cache.get(key));
//     return { rate: r, converted: Number((value * r).toFixed(2)) };
//   }

//   // inflight dedup
//   if (inflight.has(key)) {
//     return inflight.get(key);
//   }

//   const p = (async () => {
//     try {
//       const rate = await fetchRateFromInternal(fromISO, toISO);

//       cache.set(key, rate);
//       setStaleRate(key, rate);

//       logger.info({ from: fromISO, to: toISO, rate }, "FX interne OK (cache)");
//       return { rate, converted: Number((value * rate).toFixed(2)) };
//     } catch (e) {
//       const staleRate = getStaleRate(key);
//       if (staleRate) {
//         logger.warn(
//           { from: fromISO, to: toISO, rate: staleRate, err: e?.code || e?.message || e },
//           "FX interne KO -> fallback stale"
//         );
//         return { rate: staleRate, converted: Number((value * staleRate).toFixed(2)) };
//       }
//       throw e;
//     } finally {
//       inflight.delete(key);
//     }
//   })();

//   inflight.set(key, p);
//   return p;
// }


// function clearCache() {
//   cache.clear();
//   staleStore.clear();
//   inflight.clear();
//   logger.info("Cache FX vidé");
// }

// module.exports = { convertAmount, clearCache };










// File: tools/currency.js
"use strict";

const axios = require("axios");
const pino = require("pino");
const config = require("../config");

// Logger
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/* ------------------------------------------------------------------ */
/* LRU Cache (compatible lru-cache v6/v7+)                             */
/* ------------------------------------------------------------------ */
let LRUCacheCtor = null;
try {
  // v7+: { LRUCache }
  const mod = require("lru-cache");
  LRUCacheCtor = mod?.LRUCache || mod;
} catch (e) {
  logger.warn({ err: e?.message || e }, "lru-cache not available, FX cache disabled");
  LRUCacheCtor = null;
}

// TTL “fresh” (ms)
const TTL_MS = Number(process.env.FX_CACHE_TTL_MS || config?.exchange?.cacheTTL || 10 * 60 * 1000); // 10min
// TTL “stale fallback” (ms)
const STALE_TTL_MS = Number(process.env.FX_CACHE_STALE_TTL_MS || 24 * 60 * 60 * 1000); // 24h
const HTTP_TIMEOUT_MS = Number(process.env.FX_HTTP_TIMEOUT_MS || 5000);

// Cache fresh : key "FROM->TO" -> rate
const cache = LRUCacheCtor ? new LRUCacheCtor({ max: 200, ttl: TTL_MS }) : null;
// Cache stale : dernière valeur connue
const staleStore = new Map(); // key -> { ts, rate }
// Dédup inflight: key -> Promise<{rate, converted}>
const inflight = new Map();

// URL backend principal (source des taux en DB)
const PRINCIPAL_URL = String(config?.principalUrl || process.env.PRINCIPAL_URL || "").replace(/\/+$/, "");
const INTERNAL_TOKEN = String(process.env.INTERNAL_TOKEN || config?.internalToken || "");

/* ------------------------------------------------------------------ */
/* Currency symbols + country mapping                                  */
/* ------------------------------------------------------------------ */
const CURRENCY_SYMBOLS = {
  XOF: "F CFA",
  XAF: "F CFA",
  EUR: "€",
  USD: "$",
  CAD: "$CAD",
  GBP: "£",
  NGN: "₦",
  GHS: "₵",
  INR: "₹",
  CNY: "¥",
  JPY: "¥",
  BRL: "R$",
  ZAR: "R",
};

const COUNTRY_TO_CURRENCY = {
  // Noms
  "cote d'ivoire": "XOF",
  "cote divoire": "XOF",
  "ivory coast": "XOF",
  "burkina faso": "XOF",
  mali: "XOF",
  senegal: "XOF",
  cameroun: "XAF",
  cameroon: "XAF",
  france: "EUR",
  belgique: "EUR",
  allemagne: "EUR",
  germany: "EUR",
  usa: "USD",
  "etats-unis": "USD",
  "etats unis": "USD",
  "united states": "USD",
  canada: "CAD",
  "royaume-uni": "GBP",
  "royaume uni": "GBP",
  uk: "GBP",
  "united kingdom": "GBP",

  // ISO2 lower
  ci: "XOF",
  bf: "XOF",
  ml: "XOF",
  sn: "XOF",
  cm: "XAF",
  fr: "EUR",
  be: "EUR",
  de: "EUR",
  us: "USD",
  ca: "CAD",
  gb: "GBP",

  // ISO2 upper
  CI: "XOF",
  BF: "XOF",
  ML: "XOF",
  SN: "XOF",
  CM: "XAF",
  FR: "EUR",
  BE: "EUR",
  DE: "EUR",
  US: "USD",
  CA: "CAD",
  GB: "GBP",
};

function normalizeCountry(country) {
  if (!country) return "";
  try {
    return String(country)
      .replace(/^[^\w]+/, "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  } catch {
    return String(country).trim();
  }
}

function getCurrencySymbolByCode(code) {
  if (!code) return "";
  const iso = String(code).trim().toUpperCase();
  return CURRENCY_SYMBOLS[iso] || iso;
}

function getCurrencyCodeByCountry(country) {
  const raw = normalizeCountry(country);
  if (!raw) return "USD";

  if (/^[A-Z]{2}$/.test(raw)) {
    return COUNTRY_TO_CURRENCY[raw] || COUNTRY_TO_CURRENCY[raw.toLowerCase()] || "USD";
  }

  const normalized = raw.toLowerCase();
  return COUNTRY_TO_CURRENCY[normalized] || "USD";
}

/* ------------------------------------------------------------------ */
/* FX conversion                                                       */
/* ------------------------------------------------------------------ */

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

  VND: "VND",
  "₫": "VND",
};

function now() {
  return Date.now();
}

function normalizeCurrencyCode(raw) {
  let k = String(raw || "").trim().toUpperCase();
  if (!k) return "";

  // alias
  k = CURRENCY_ALIASES[k] || k;

  // NBSP safe
  k = k.replace(/\u00A0/g, " ");

  // garde A-Z
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
 * Attendu: { success:true, rate:number } OU { success:true, data:{rate:number} }
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
    const err = new Error("Montant invalide pour conversion");
    err.code = "FX_INVALID_AMOUNT";
    throw err;
  }

  const fromISO = normalizeCurrencyCode(from);
  const toISO = normalizeCurrencyCode(to);

  if (!fromISO || !toISO) {
    const err = new Error(`Devise invalide: from=${from} to=${to}`);
    err.code = "FX_INVALID_CURRENCY";
    throw err;
  }

  // même devise
  if (fromISO === toISO) {
    return { rate: 1, converted: Number(value.toFixed(2)) };
  }

  // montant 0 => pas besoin d'appel FX
  if (value === 0) {
    // On retourne un rate "neutre" (0) car conversion inutile
    return { rate: 0, converted: 0 };
  }

  const key = makeKey(fromISO, toISO);

  // cache fresh
  if (cache && cache.has(key)) {
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

      if (cache) cache.set(key, rate);
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

function clearFxCache() {
  try {
    if (cache) cache.clear();
  } catch {}
  staleStore.clear();
  inflight.clear();
  logger.info("Cache FX vidé");
}

module.exports = {
  // currency tools
  getCurrencySymbolByCode,
  getCurrencyCodeByCountry,
  CURRENCY_SYMBOLS,
  COUNTRY_TO_CURRENCY,

  // fx tools
  convertAmount,
  clearFxCache,

  // utils (optionnel)
  normalizeCurrencyCode,
};




