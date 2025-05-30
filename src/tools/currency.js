// src/tools/currency.js

const axios = require('axios');
const pino = require('pino');
const BaseCache = require('lru-cache');
const { exchange } = require('../config');

// Logger pour le module monnaie
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Instantiate LRU cache correctly
const LRUCache = BaseCache.LRUCache || BaseCache; // support both export styles
const cache = new LRUCache({ max: 50, ttl: exchange.cacheTTL });

/**
 * Fetch des taux depuis l’API externe définie dans la config
 * @param {string} base - Code ISO de la devise (e.g. 'USD')
 * @returns {Promise<Object>} - Mapping devise -> taux
 */
async function fetchRatesFromApi(base) {
  // Trim trailing slash
  const baseUrl = exchange.apiUrl.replace(/\/+$/, '');
  // Construct URL; v6 APIs embed key in path, v4 use query param
  let url = `${baseUrl}/latest/${encodeURIComponent(base)}`;
  const isV6 = /\/v6\//.test(baseUrl);
  const params = {};

  if (!isV6 && exchange.apiKey) {
    params.apiKey = exchange.apiKey;
  }

  const resp = await axios.get(url, { params, timeout: 5000 });
  if (resp.status !== 200) {
    throw new Error(`Exchange API error: ${resp.status}`);
  }
  return resp.data.rates;
}

/**
 * Récupère les taux (cache + API)
 * @param {string} rawBase - Code ISO source
 * @returns {Promise<Object>} - Mapping des taux de change
 */
async function getRates(rawBase) {
  const base = String(rawBase).toUpperCase();
  if (cache.has(base)) {
    logger.debug({ base }, 'Taux depuis cache');
    return cache.get(base);
  }
  const rates = await fetchRatesFromApi(base);
  cache.set(base, rates);
  logger.info({ base, timestamp: Date.now() }, 'Taux mis en cache');
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
 * @param {string} from   - Code ISO source
 * @param {string} to     - Code ISO cible
 * @param {number} amount - Montant à convertir
 * @returns {Promise<{ rate: number, converted: number }>}
 */
async function convertAmount(from, to, amount) {
  const value = Number(amount);
  if (isNaN(value) || value <= 0) {
    throw new Error('Montant invalide pour conversion');
  }
  if (from === to) {
    return { rate: 1, converted: value };
  }
  const rates = await getRates(from);
  const rate = rates[to];
  if (!rate) {
    throw new Error(`Devise non supportée : ${to}`);
  }
  const converted = Number((value * rate).toFixed(2));
  return { rate, converted };
}

module.exports = {
  getRates,
  clearCache,
  convertAmount
};
