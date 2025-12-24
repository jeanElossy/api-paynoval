// File: src/middleware/internalAuth.js
'use strict';

/**
 * Middleware d'authentification pour les appels internes (Gateway, backend principal, jobs).
 *
 * ✅ Version corrigée :
 * - Supporte 2 tokens distincts (Gateway vs Principal)
 * - Compare en timing-safe (anti timing attack)
 * - Continue à supporter INTERNAL_TOKEN en fallback (legacy)
 *
 * Usage:
 * - requireInternalAuth()            => accepte gateway OU principal
 * - requireInternalAuth('gateway')   => accepte UNIQUEMENT le token gateway
 * - requireInternalAuth('principal') => accepte UNIQUEMENT le token principal
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

function getHeaderToken(req) {
  return (
    req.headers['x-internal-token'] ||
    req.headers['X-Internal-Token'] ||
    req.headers['x-internal-token'.toUpperCase()] ||
    ''
  );
}

function getInternalTokens() {
  const legacy = (process.env.INTERNAL_TOKEN || config.internalToken || '').trim();

  const gateway = (
    process.env.GATEWAY_INTERNAL_TOKEN ||
    config?.internalTokens?.gateway ||
    legacy
  ).trim();

  const principal = (
    process.env.PRINCIPAL_INTERNAL_TOKEN ||
    process.env.INTERNAL_REFERRAL_TOKEN ||
    config?.internalTokens?.principal ||
    legacy
  ).trim();

  return { legacy, gateway, principal };
}

module.exports = function requireInternalAuth(scope = 'any') {
  return function internalAuthMiddleware(req, res, next) {
    try {
      const got = String(getHeaderToken(req) || '').trim();
      const { gateway, principal } = getInternalTokens();

      const expectedList =
        scope === 'gateway'
          ? [gateway]
          : scope === 'principal'
          ? [principal]
          : [gateway, principal];

      const expectedListClean = expectedList
        .map((x) => String(x || '').trim())
        .filter(Boolean);

      if (!expectedListClean.length) {
        return res.status(500).json({
          success: false,
          error:
            'Token interne non configuré côté serveur (GATEWAY_INTERNAL_TOKEN / PRINCIPAL_INTERNAL_TOKEN manquants).',
        });
      }

      const ok =
        got &&
        expectedListClean.some((expected) => timingSafeEqualStr(got, expected));

      if (!ok) {
        return res.status(401).json({
          success: false,
          error: 'Accès interne non autorisé (token invalide).',
        });
      }

      return next();
    } catch (_err) {
      return res.status(500).json({
        success: false,
        error: 'Erreur interne de vérification du token.',
      });
    }
  };
};
