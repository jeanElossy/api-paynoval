// src/middleware/requestValidator.js

const { validationResult } = require('express-validator');
const createErrorRQ = require('http-errors');

module.exports = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Retour structuré des erreurs
    const formatted = errors.array().map(e => ({ field: e.param, message: e.msg }));
    return next(createErrorRQ(400, 'Validation échouée', { details: formatted }));
  }
  next();
};
