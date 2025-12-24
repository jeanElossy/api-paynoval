// // middleware/onlyGateway.js
// module.exports = function onlyGateway(req, res, next) {
//   if (req.headers['x-internal-token'] !== process.env.INTERNAL_TOKEN) {
//     // Astuce : log le remote IP pour détecter les attaques
//     console.warn(`[BACKEND] Requête refusée - IP: ${req.ip || req.connection.remoteAddress}`);
//     return res.status(403).json({ error: 'Accès interdit. Gateway uniquement.' });
//   }
//   next();
// };



// File: src/middleware/onlyGateway.js
'use strict';

/**
 * ✅ Version corrigée (API PayNoval):
 * - N'autorise QUE le Gateway (token gateway)
 * - Timing-safe compare
 * - Logs + IP
 */

const crypto = require('crypto');
const config = require('../config');

function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');

  const len = Math.max(aBuf.length, bBuf.length);
  const aPadded = Buffer.concat([aBuf, Buffer.alloc(len - aBuf.length)]);
  const bPadded = Buffer.concat([bBuf, Buffer.alloc(len - bBuf.length)]);

  const eq = crypto.timingSafeEqual(aPadded, bPadded);
  return eq && aBuf.length === bBuf.length;
}

module.exports = function onlyGateway(req, res, next) {
  const got =
    req.headers['x-internal-token'] ||
    req.headers['X-Internal-Token'] ||
    req.headers['x-internal-token'.toUpperCase()] ||
    '';

  const expected =
    (process.env.GATEWAY_INTERNAL_TOKEN ||
      config?.internalTokens?.gateway ||
      process.env.INTERNAL_TOKEN ||
      config?.internalToken ||
      '').trim();

  if (process.env.NODE_ENV === 'production' && !expected) {
    return res.status(500).json({
      success: false,
      error: 'Token gateway interne non configuré (GATEWAY_INTERNAL_TOKEN manquant).',
    });
  }

  if (!expected || !got || !timingSafeEqualStr(String(got).trim(), expected)) {
    console.warn(
      `[PAYNOVAL] Requête interne refusée (onlyGateway) - ip=${req.ip || req.connection?.remoteAddress || 'unknown'}`
    );
    return res.status(403).json({ success: false, error: 'Accès interdit. Gateway uniquement.' });
  }

  return next();
};
