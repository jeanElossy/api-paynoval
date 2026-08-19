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


const config = require('../config');

/**
 * La comparaison elle-même vit dans `utils/internalTokens.js`, sans dépendance
 * de configuration, afin d'être couverte par la suite de tests. Ce fichier ne
 * garde que ce qui dépend de l'environnement : la RÉSOLUTION des tokens
 * attendus.
 */
const {
  timingSafeEqualStr,
  extractInternalToken,
  matchesAnyToken,
} = require('../utils/internalTokens');

function getHeaderToken(req) {
  return extractInternalToken(req);
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

/**
 * Vérifie un token interne SANS interrompre la requête.
 *
 * Exposé pour que les autres décisions liées au token interne — au premier chef
 * le contournement du rate-limit — reposent sur la MÊME comparaison timing-safe
 * et la MÊME résolution de variables que l'authentification elle-même. Deux
 * implémentations divergentes de « ce token est-il valide ? » finissent toujours
 * par diverger dans le mauvais sens.
 */
module.exports.isValidInternalToken = function isValidInternalToken(
  req,
  scope = 'any'
) {
  try {
    const got = String(getHeaderToken(req) || '').trim();
    if (!got) return false;

    const { gateway, principal } = getInternalTokens();

    const expected = (
      scope === 'gateway'
        ? [gateway]
        : scope === 'principal'
        ? [principal]
        : [gateway, principal]
    )
      .map((x) => String(x || '').trim())
      .filter(Boolean);

    return matchesAnyToken(got, expected);
  } catch {
    return false;
  }
};
