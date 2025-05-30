// File: src/tools/currency.js

const axios = require('axios');
const pino = require('pino');
const BaseCache = require('lru-cache');
const { exchange } = require('../config');

// Logger pour le module de change
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Instanciation du cache LRU (support export default ou LRUCache)
const LRUCache = BaseCache.LRUCache || BaseCache;
const cache = new LRUCache({ max: 50, ttl: exchange.cacheTTL });

// Alias pour normaliser les codes maison en codes ISO valides
const CURRENCY_ALIASES = {
  'FCA': 'XOF',
  'FCFA': 'XOF',
  'CFA': 'XOF',
  'EURO': 'EUR',
  '€': 'EUR',
  'USD': 'USD',
  '$': 'USD',
  'US DOLLAR': 'USD',
  'GBP': 'GBP',
  '£': 'GBP',
  'POUND': 'GBP',
  'JPY': 'JPY',
  'YEN': 'JPY',
  '¥': 'JPY',
  'AUD': 'AUD',
  'A$': 'AUD',
  'CAD': 'CAD',
  '$CAD': 'CAD',
  'CA$': 'CAD',
  'CHF': 'CHF',
  'SWISS FRANC': 'CHF',
  'CNY': 'CNY',
  'RMB': 'CNY',
  'CN¥': 'CNY',
  'HKD': 'HKD',
  'HK$': 'HKD',
  'SGD': 'SGD',
  'SG$': 'SGD',
  'NZD': 'NZD',
  'NZ$': 'NZD',
  'INR': 'INR',
  'RUPEE': 'INR',
  '₹': 'INR',
  'BRL': 'BRL',
  'REAL': 'BRL',
  'R$': 'BRL',
  'MXN': 'MXN',
  'MX$': 'MXN',
  'ZAR': 'ZAR',
  'RAND': 'ZAR',
  'R': 'ZAR',
  'SEK': 'SEK',
  'KRONA': 'SEK',
  'NOK': 'NOK',
  'DKK': 'DKK',
  'PLN': 'PLN',
  'ZŁ': 'PLN',
  'THB': 'THB',
  '฿': 'THB',
  'TRY': 'TRY',
  'LIRA': 'TRY',
  '₺': 'TRY',
  'SAR': 'SAR',
  'ريال': 'SAR',
  'AED': 'AED',
  'د.إ': 'AED',
  'PHP': 'PHP',
  '₱': 'PHP',
  'KRW': 'KRW',
  '₩': 'KRW',
  'IDR': 'IDR',
  'RP': 'IDR',
  'Rp': 'IDR',
  'VND': 'VND',
  '₫': 'VND'
};


/**
 * Fetch des taux depuis l’API externe définie dans la config.
 * Supporte v4 ("rates") et v6 ("conversion_rates").
 * @param {string} base - Code ISO source (ex: 'USD')
 * @returns {Promise<Object>} - Mapping devise -> taux
 */
async function fetchRatesFromApi(base) {
  const root = exchange.apiUrl.replace(/\/latest\/.*$/, '').replace(/\/+$/, '');
  const url = `${root}/latest/${encodeURIComponent(base)}`;
  const params = (!/\/v6\//.test(root) && exchange.apiKey)
    ? { apiKey: exchange.apiKey }
    : {};

  logger.info({ url, params }, 'Appel Exchange API');
  const resp = await axios.get(url, { params, timeout: 5000 });
  if (resp.status !== 200) {
    throw new Error(`Exchange API error: ${resp.status}`);
  }

  const data = resp.data;
  const rates = data.conversion_rates || data.rates;
  if (!rates || typeof rates !== 'object') {
    throw new Error('Exchange API returned unexpected payload');
  }
  return rates;
}

/**
 * Récupère les taux (cache + API)
 * @param {string} rawBase - code ISO brut (p. ex. "usd" ou "F CFA")
 * @returns {Promise<Object>} - Mapping devise -> taux
 */
async function getRates(rawBase) {
  // Normaliser : majuscules & retirer tout sauf A-Z
  let baseNorm = String(rawBase).toUpperCase().replace(/[^A-Z]/g, '');
  // Appliquer alias si présent
  baseNorm = CURRENCY_ALIASES[baseNorm] || baseNorm;

  if (!/^[A-Z]{3}$/.test(baseNorm)) {
    throw new Error(`Invalid currency code: ${rawBase}`);
  }
  if (cache.has(baseNorm)) {
    logger.debug({ base: baseNorm }, 'Taux depuis cache');
    return cache.get(baseNorm);
  }
  const rates = await fetchRatesFromApi(baseNorm);
  cache.set(baseNorm, rates);
  logger.info({ base: baseNorm, timestamp: Date.now() }, 'Taux mis en cache');
  return rates;
}

/**
 * Vide le cache des taux
 */
function clearCache() {
  cache.clear();
  logger.info('Cache vidé');
}

/**
 * Convertit un montant d'une devise à une autre
 * @param {string} from   - code ISO source ou alias
 * @param {string} to     - code ISO cible ou alias
 * @param {number} amount - montant à convertir
 * @returns {Promise<{rate:number, converted:number}>}
 */
async function convertAmount(from, to, amount) {
  const value = Number(amount);
  if (isNaN(value) || value <= 0) {
    throw new Error('Montant invalide pour conversion');
  }

  // Normaliser code source
  let fromCode = String(from).toUpperCase().replace(/[^A-Z]/g, '');
  fromCode = CURRENCY_ALIASES[fromCode] || fromCode;

  // Normaliser code cible
  let toCode = String(to).toUpperCase().replace(/[^A-Z]/g, '');
  toCode = CURRENCY_ALIASES[toCode] || toCode;

  // Même devise => taux 1
  if (fromCode === toCode) {
    return { rate: 1, converted: value };
  }

  // Récupérer les taux pour la devise source
  const rates = await getRates(fromCode);
  const rate = rates[toCode];
  if (rate === undefined) {
    throw new Error(`Devise non supportée : ${to}`);
  }

  const converted = Number((value * rate).toFixed(2));
  return { rate, converted };
}

module.exports = { getRates, clearCache, convertAmount };




// // File: src/tools/currency.js

// const axios = require('axios');
// const pino = require('pino');
// const BaseCache = require('lru-cache');
// const { exchange } = require('../config');

// // Logger pour le module de change
// const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// // Instanciation du cache LRU
// const LRUCache = BaseCache.LRUCache || BaseCache;
// const cache = new LRUCache({ max: 50, ttl: exchange.cacheTTL });

// // Alias pour normaliser les codes maison en codes ISO valides
// const CURRENCY_ALIASES = {
//   'FCFA': 'XOF',
//   'CFA': 'XOF',
//   'EURO': 'EUR',
//   '€': 'EUR',
//   'USD': 'USD',
//   '$': 'USD',
//   'US DOLLAR': 'USD',
//   'GBP': 'GBP',
//   '£': 'GBP',
//   'POUND': 'GBP',
//   'JPY': 'JPY',
//   'YEN': 'JPY',
//   '¥': 'JPY',
//   'AUD': 'AUD',
//   'A$': 'AUD',
//   'CAD': 'CAD',
//   'CA$': 'CAD',
//   'CHF': 'CHF',
//   'SWISS FRANC': 'CHF',
//   'CNY': 'CNY',
//   'RMB': 'CNY',
//   'CN¥': 'CNY',
//   'HKD': 'HKD',
//   'HK$': 'HKD',
//   'SGD': 'SGD',
//   'SG$': 'SGD',
//   'NZD': 'NZD',
//   'NZ$': 'NZD',
//   'INR': 'INR',
//   'RUPEE': 'INR',
//   '₹': 'INR',
//   'BRL': 'BRL',
//   'REAL': 'BRL',
//   'R$': 'BRL',
//   'MXN': 'MXN',
//   'MX$': 'MXN',
//   'ZAR': 'ZAR',
//   'RAND': 'ZAR',
//   'R': 'ZAR',
//   'SEK': 'SEK',
//   'KRONA': 'SEK',
//   'NOK': 'NOK',
//   'DKK': 'DKK',
//   'PLN': 'PLN',
//   'ZŁ': 'PLN',
//   'THB': 'THB',
//   '฿': 'THB',
//   'TRY': 'TRY',
//   'LIRA': 'TRY',
//   '₺': 'TRY',
//   'SAR': 'SAR',
//   'ريال': 'SAR',
//   'AED': 'AED',
//   'د.إ': 'AED',
//   'PHP': 'PHP',
//   '₱': 'PHP',
//   'KRW': 'KRW',
//   '₩': 'KRW',
//   'IDR': 'IDR',
//   'RP': 'IDR',
//   'Rp': 'IDR',
//   'VND': 'VND',
//   '₫': 'VND'
// };

// /**
//  * Fetch des taux depuis l’API externe définie dans la config.
//  * Supporte v4 ("rates") et v6 ("conversion_rates").
//  * @param {string} base - Code ISO source (ex: 'USD')
//  * @returns {Promise<Object>} - Mapping devise -> taux
//  */
// async function fetchRatesFromApi(base) {
//   const root = exchange.apiUrl.replace(/\/latest\/.*$/, '').replace(/\/+$/, '');
//   const url = `${root}/latest/${encodeURIComponent(base)}`;
//   const params = (!/\/v6\//.test(root) && exchange.apiKey)
//     ? { apiKey: exchange.apiKey }
//     : {};

//   logger.info({ url, params }, 'Appel Exchange API');
//   const resp = await axios.get(url, { params, timeout: 5000 });
//   if (resp.status !== 200) {
//     throw new Error(`Exchange API error: ${resp.status}`);
//   }

//   const data = resp.data;
//   const rates = data.conversion_rates || data.rates;
//   if (!rates || typeof rates !== 'object') {
//     throw new Error('Exchange API returned unexpected payload');
//   }
//   return rates;
// }

// /**
//  * Récupère les taux (cache + API)
//  * @param {string} rawBase - code ISO brut (p. ex. "usd" ou "F CFA")
//  * @returns {Promise<Object>} - Mapping devise -> taux
//  */
// async function getRates(rawBase) {
//   // Normaliser code base
//   let baseNorm = String(rawBase).toUpperCase().replace(/[^A-Z]/g, '');
//   baseNorm = CURRENCY_ALIASES[baseNorm] || baseNorm;

//   if (!/^[A-Z]{3}$/.test(baseNorm)) {
//     throw new Error(`Invalid currency code: ${rawBase}`);
//   }
//   if (cache.has(baseNorm)) {
//     logger.debug({ base: baseNorm }, 'Taux depuis cache');
//     return cache.get(baseNorm);
//   }
//   const rates = await fetchRatesFromApi(baseNorm);
//   cache.set(baseNorm, rates);
//   logger.info({ base: baseNorm, timestamp: Date.now() }, 'Taux mis en cache');
//   return rates;
// }

// /**
//  * Vide le cache des taux
//  */
// function clearCache() {
//   cache.clear();
//   logger.info('Cache vidé');
// }

// /**
//  * Convertit un montant d'une devise à une autre
//  * @param {string} from   - code ISO source ou alias
//  * @param {string} to     - code ISO cible ou alias
//  * @param {number} amount - montant à convertir
//  * @returns {Promise<{rate:number, converted:number}>}
//  */
// async function convertAmount(from, to, amount) {
//   const value = Number(amount);
//   if (isNaN(value) || value <= 0) {
//     throw new Error('Montant invalide pour conversion');
//   }

//   // Normaliser code source
//   let fromCode = String(from).toUpperCase().replace(/[^A-Z]/g, '');
//   fromCode = CURRENCY_ALIASES[fromCode] || fromCode;

//   // Normaliser code cible
//   let toCode = String(to).toUpperCase().replace(/[^A-Z]/g, '');
//   toCode = CURRENCY_ALIASES[toCode] || toCode;

//   // Même devise => taux 1
//   if (fromCode === toCode) {
//     return { rate: 1, converted: value };
//   }

//   const rates = await getRates(fromCode);
//   const rate = rates[toCode];
//   if (rate === undefined) {
//     throw new Error(`Devise non supportée : ${to}`);
//   }

//   const converted = Number((value * rate).toFixed(2));
//   return { rate, converted };
// }

// module.exports = { getRates, clearCache, convertAmount };
