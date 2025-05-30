// src/tools/currency.js

const axios = require('axios');
const pino = require('pino');
const BaseCache = require('lru-cache');
const { exchange } = require('../config');

// Logger pour le module monnaie
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Instanciation du cache LRU quel que soit l'export
const LRUCache = BaseCache.LRUCache || BaseCache;
const cache = new LRUCache({ max: 50, ttl: exchange.cacheTTL });

/**
 * Fetch des taux depuis l’API externe définie dans la config.
 * Supporte v4 ("rates") et v6 ("conversion_rates").
 * @param {string} base - Code ISO source (ex: 'USD')
 * @returns {Promise<Object>} - Mapping devise -> taux
 */
async function fetchRatesFromApi(base) {
  // Détermine la racine de l'API (sans '/latest/...')
  const root = exchange.apiUrl.replace(/\/latest\/.*$/, '').replace(/\/+$/, '');
  const url  = `${root}/latest/${encodeURIComponent(base)}`;
  // Pour v4, la clé se passe en param; pour v6, elle est déjà dans le path
  const params = (!/\/v6\//.test(root) && exchange.apiKey) ? { apiKey: exchange.apiKey } : {};

  logger.info({ url, params }, 'Appel Exchange API');
  const resp = await axios.get(url, { params, timeout: 5000 });
  if (resp.status !== 200) {
    throw new Error(`Exchange API error: ${resp.status}`);
  }

  const data = resp.data;
  // v6 renvoie 'conversion_rates', v4 renvoie 'rates'
  const rates = data.conversion_rates || data.rates;
  if (!rates || typeof rates !== 'object') {
    throw new Error('Exchange API returned unexpected payload');
  }
  return rates;
}

/**
 * Récupère les taux (cache + API).
 * @param {string} rawBase
 * @returns {Promise<Object>}
 */
async function getRates(rawBase) {
  // Nettoyer la devise : garder uniquement les lettres A-Z
  let base = String(rawBase).toUpperCase().replace(/[^A-Z]/g, '');
  if (!base.match(/^[A-Z]{3}$/)) {
    throw new Error(`Invalid currency code: ${rawBase}`);
  }

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
  if (from === to) {
    return { rate: 1, converted: value };
  }
  const rates = await getRates(from);
  const rate = rates[to];
  if (rate === undefined) {
    throw new Error(`Devise non supportée : ${to}`);
  }
  const converted = Number((value * rate).toFixed(2));
  return { rate, converted };
}

module.exports = { getRates, clearCache, convertAmount };
