// File: src/services/notifyGateway.js
'use strict';

const axios = require('axios');
const config = require('../config');

// ✅ chemin corrigé : on pointe sur utils/logger
let logger = console;
try {
  logger = require('../utils/logger');
} catch {}

/**
 * ✅ Token pour appeler le Gateway (pas le principal)
 * - Priorité: GATEWAY_INTERNAL_TOKEN
 * - Fallback: INTERNAL_TOKEN / config.internalToken (legacy)
 */
const GATEWAY_INTERNAL_TOKEN =
  (process.env.GATEWAY_INTERNAL_TOKEN ||
    config?.internalTokens?.gateway ||
    process.env.INTERNAL_TOKEN ||
    config?.internalToken ||
    '').trim();

/**
 * Résout l'URL de base du Gateway :
 *  - d'abord config.gatewayUrl (si défini)
 *  - sinon process.env.GATEWAY_URL
 *  - sinon fallback hardcodé (Render)
 * On force le suffixe /api/v1.
 */
function getGatewayBaseUrl() {
  let gatewayBase =
    config.gatewayUrl ||
    process.env.GATEWAY_URL ||
    'https://api-gateway-8cgy.onrender.com';

  gatewayBase = String(gatewayBase || '').trim().replace(/\/+$/, '');

  if (!gatewayBase.endsWith('/api/v1')) {
    gatewayBase = `${gatewayBase}/api/v1`;
  }

  return gatewayBase;
}

/**
 * Envoie un évènement transactionnel vers l’API Gateway pour qu’il gère
 * les emails transactionnels (SendGrid) pour : initiated / confirmed / cancelled
 */
async function notifyTransactionViaGateway(type, payload) {
  const gatewayBase = getGatewayBaseUrl();

  if (!gatewayBase) {
    logger.warn(
      '[notifyGateway] gatewayBase introuvable (config.gatewayUrl ou GATEWAY_URL), notification ignorée.'
    );
    return;
  }

  if (!type || !payload || !payload.transaction) {
    logger.warn('[notifyGateway] payload incomplet, notification ignorée.', {
      type,
      hasTx: !!(payload && payload.transaction),
    });
    return;
  }

  const url = `${gatewayBase}/internal/transactions/notify`;

  try {
    await axios.post(
      url,
      { type, ...payload },
      {
        timeout: 8000,
        headers: {
          'Content-Type': 'application/json',
          ...(GATEWAY_INTERNAL_TOKEN
            ? { 'x-internal-token': GATEWAY_INTERNAL_TOKEN }
            : {}),
        },
      }
    );

    logger.info('[notifyGateway] Notification envoyée au Gateway', {
      type,
      txId: payload.transaction.id,
      reference: payload.transaction.reference,
    });
  } catch (err) {
    logger.error('[notifyGateway] Erreur lors de la notification au Gateway', {
      type,
      url,
      message: err.response?.data || err.message || err,
    });
    // ⚠️ IMPORTANT : on NE throw PAS → ça ne doit jamais casser la transaction interne
  }
}

module.exports = { notifyTransactionViaGateway };
