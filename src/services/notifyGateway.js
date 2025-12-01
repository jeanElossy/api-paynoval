// File: api-paynoval/src/services/notifyGateway.js
'use strict';

const axios = require('axios');
const config = require('../config'); // ton config index que tu as montré
const logger = require('../logger') || console;

const GATEWAY_URL    = config.gatewayUrl || process.env.GATEWAY_URL || '';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';

/**
 * Envoie un événement transactionnel au Gateway pour qu'il gère les emails.
 *
 * @param {'initiated'|'confirmed'|'cancelled'} type
 * @param {Object} payload  (voir transactionNotificationService)
 */
async function notifyTransactionViaGateway(type, payload) {
  if (!GATEWAY_URL) {
    logger.warn('[notifyTransactionViaGateway] GATEWAY_URL manquant, notification ignorée.');
    return;
  }

  try {
    await axios.post(
      `${GATEWAY_URL}/internal/transactions/notify`,
      {
        type,
        ...payload,
      },
      {
        timeout: 8000,
        headers: {
          'Content-Type': 'application/json',
          'x-internal-token': INTERNAL_TOKEN,
        },
      }
    );
    logger.info(
      `[notifyTransactionViaGateway] Notification envoyée au Gateway (type=${type})`
    );
  } catch (err) {
    logger.error(
      '[notifyTransactionViaGateway] Erreur:',
      err.response?.data || err.message || err
    );
    // On NE throw PAS pour ne pas casser la transaction
  }
}

module.exports = {
  notifyTransactionViaGateway,
};
