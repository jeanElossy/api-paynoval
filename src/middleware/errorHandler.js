/* src/middleware/errorHandler.js */
const logger = require('../utils/logger');

/**
 * Global error handling middleware
 * Logs detailed error information server-side,
 * Returns sanitized error messages to clients.
 */
module.exports = (err, req, res, next) => {
  const statusCode = err.status || 500;
  
  // Log full error for debugging
  logger.error({
    message: err.message,
    stack: err.stack,
    path: req.originalUrl,
    method: req.method,
    user: req.user ? req.user.id : null,
    timestamp: new Date().toISOString()
  });

  // Prepare client-facing response
  const response = {
    success: false,
    error: statusCode === 500
      ? 'Une erreur interne est survenue.'
      : err.message
  };

  // In non-production, include stack trace for 500 errors
  if (process.env.NODE_ENV !== 'production' && statusCode === 500) {
    response.stack = err.stack;
  }

  // Handle Mongoose validation errors specifically
  if (err.name === 'ValidationError') {
    response.error = 'Données invalides';
    response.details = Object.values(err.errors).map(e => e.message);
    return res.status(400).json(response);
  }

  return res.status(statusCode).json(response);
};
