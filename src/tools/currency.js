// src/tools/currency.js

const axios = require('axios');
const pino = require('pino');
const BaseCache = require('lru-cache');
const { exchange } = require('../config');

// Logger pour le module monnaie
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Instantiation correcte du cache LRU
const LRUCache = BaseCache.LRUCache || BaseCache;
const cache = new LRUCache({ max: 50, ttl: exchange.cacheTTL });

/**
 * Fetch des taux depuis l’API externe définie dans la config
 * @param {string} base - Code ISO de la devise (ex: 'USD')
 * @returns {Promise<Object>} - Mapping devise -> taux
 */
async function fetchRatesFromApi(base) {
  const rawUrl = exchange.apiUrl.trim();
  let url;
  if (/\/latest\//.test(rawUrl)) {
    url = rawUrl.replace(/\/latest\/[\w-]+$/i, `/latest/${encodeURIComponent(base)}`);
  } else {
    const baseUrl = rawUrl.replace(/\/+$/, '');
    url = `${baseUrl}/latest/${encodeURIComponent(base)}`;
  }
  const isV6 = /\/v6\//.test(url);
  const params = {};
  if (!isV6 && exchange.apiKey) params.apiKey = exchange.apiKey;

  logger.debug({ url, params }, 'Appel Exchange API');
  const resp = await axios.get(url, { params, timeout: 5000 });
  if (resp.status !== 200) {
    throw new Error(`Exchange API error: ${resp.status}`);
  }
  return resp.data.rates;
}

/**
 * Récupère les taux (cache + API)
 * @param {string} rawBase
 * @returns {Promise<Object>}
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
 * @param {string} from
 * @param {string} to
 * @param {number} amount
 * @returns {Promise<{rate:number,converted:number}>}
 */
async function convertAmount(from, to, amount) {
  const value = Number(amount);
  if (isNaN(value) || value <= 0) {
    throw new Error('Montant invalide pour conversion');
  }
  if (from === to) return { rate: 1, converted: value };
  const rates = await getRates(from);
  const rate = rates[to];
  if (!rate) throw new Error(`Devise non supportée : ${to}`);
  const converted = Number((value * rate).toFixed(2));
  return { rate, converted };
}

module.exports = { getRates, clearCache, convertAmount };
