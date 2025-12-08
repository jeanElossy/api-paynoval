// File: src/middleware/internalAuth.js
'use strict';

/**
 * Middleware d'authentification pour les appels internes (Gateway, backend principal, jobs).
 *
 * Protège les routes internes via un token partagé:
 *  - Header: x-internal-token: <SECRET>
 *  - SECRET défini dans:
 *      - process.env.INTERNAL_TOKEN
 *      - ou config.internalToken
 */

const config = require('../config');

const INTERNAL_TOKEN =
  process.env.INTERNAL_TOKEN || config.internalToken || '';

module.exports = function requireInternalAuth(req, res, next) {
  try {
    const headerToken = req.headers['x-internal-token'];

    if (!INTERNAL_TOKEN) {
      return res.status(500).json({
        success: false,
        error:
          'Token interne non configuré côté serveur (INTERNAL_TOKEN manquant).',
      });
    }

    if (!headerToken || String(headerToken) !== String(INTERNAL_TOKEN)) {
      return res.status(401).json({
        success: false,
        error: 'Accès interne non autorisé (token invalide).',
      });
    }

    return next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Erreur interne de vérification du token.',
    });
  }
};
