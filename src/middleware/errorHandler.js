// src/middleware/errorHandler.js

const logger = require('../utils/logger');
const createErrorEH = require('http-errors');

module.exports = (err, req, res, next) => {
  // Log interne complet
  logger.error({
    message: err.message,
    stack: err.stack,
    path: req.originalUrl,
    method: req.method,
    user: req.user?.id,
    timestamp: new Date().toISOString()
  });

  let statusCode = err.status || err.statusCode || 500;
  let message = err.expose ? err.message : (statusCode === 500 ? 'Une erreur interne est survenue.' : err.message);

  const response = { success: false, status: statusCode, message };

  // Détails pour la validation
  if (err.details) response.errors = err.details;

  // Stack trace uniquement hors prod pour 500
  if (process.env.NODE_ENV !== 'production' && statusCode === 500) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
};
