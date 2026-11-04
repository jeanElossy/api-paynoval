// File: src/middleware/errorHandler.js

const logger = require('../utils/logger');

module.exports = (err, req, res, next) => {
  // Log interne complet
  logger.error({
    message: err.message,
    stack: err.stack,
    path: req.originalUrl,
    method: req.method,
    user: req.user?.id,
    timestamp: new Date().toISOString(),
  });

  let statusCode = err.status || err.statusCode || 500;
  let message = err.expose
    ? err.message
    : (statusCode === 500 ? 'Une erreur interne est survenue.' : err.message);

  const response = { success: false, status: statusCode, message };

  /**
   * Machine-readable business code (Stripe-style `code`): clients must be able
   * to tell a wrong security answer (401 SECURITY_ANSWER_INVALID) from an
   * expired session without parsing a translated message. Also on a 503, the
   * one server status a client acts on: PROMO_UNAVAILABLE means nothing was
   * reserved, and without its code the app shows a transfer still being
   * verified. Restricted to exposed errors with an UPPER_SNAKE code, so a Node
   * system error (`ECONNREFUSED`…) never leaks through a 5xx.
   */
  if (
    (statusCode < 500 || statusCode === 503) &&
    err.expose !== false &&
    typeof err.code === 'string' &&
    /^[A-Z][A-Z0-9_]{2,63}$/.test(err.code) &&
    !/^E[A-Z]+$/.test(err.code)
  ) {
    response.code = err.code;
  }

  // Détails pour la validation (ex: Joi, celebrate, etc.)
  if (err.details) response.errors = err.details;
  // Réclamation d'un transfert (2026-11-04) : essais restants sur le lien, un
  // simple nombre — rien qui renseigne sur la réponse ou le code.
  if (Number.isInteger(err.attemptsLeft) && err.attemptsLeft >= 0) response.attemptsLeft = err.attemptsLeft;

  // Stack trace uniquement hors prod pour 500
  if (process.env.NODE_ENV !== 'production' && statusCode === 500) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
};
