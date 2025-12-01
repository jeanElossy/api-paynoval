// File: src/services/notifyGateway.js
'use strict';

const axios  = require('axios');
const config = require('../config');
// ✅ chemin corrigé : on pointe sur utils/logger
const logger = require('../utils/logger') || console;

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';

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

  // On retire les / de fin
  gatewayBase = gatewayBase.replace(/\/+$/, '');

  // On s'assure qu'on a bien /api/v1
  if (!gatewayBase.endsWith('/api/v1')) {
    gatewayBase = `${gatewayBase}/api/v1`;
  }

  return gatewayBase;
}

/**
 * Envoie un évènement transactionnel vers l’API Gateway pour qu’il
 * gère les emails transactionnels (SendGrid) pour :
 *  - initiated
 *  - confirmed
 *  - cancelled
 *
 * @param {'initiated'|'confirmed'|'cancelled'} type
 * @param {object} payload
 *
 * Payload attendu côté Gateway (exemple) :
 * {
 *   transaction: { id, reference, amount, currency, dateIso },
 *   sender: { email, name, wantsEmail },
 *   receiver: { email, name, wantsEmail },
 *   reason?: string,
 *   links?: { sender?: string, receiverConfirm?: string }
 * }
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
    logger.warn(
      '[notifyGateway] payload incomplet (type ou transaction manquants), notification ignorée.',
      { type, hasTx: !!(payload && payload.transaction) }
    );
    return;
  }

  const url = `${gatewayBase}/internal/transactions/notify`;

  try {
    await axios.post(
      url,
      {
        type,
        ...payload,
      },
      {
        timeout: 8000,
        headers: {
          'Content-Type': 'application/json',
          ...(INTERNAL_TOKEN ? { 'x-internal-token': INTERNAL_TOKEN } : {}),
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

module.exports = {
  notifyTransactionViaGateway,
};
