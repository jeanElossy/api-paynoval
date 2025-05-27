// src/middleware/requestValidator.js

const { validationResult } = require('express-validator');
const createError = require('http-errors');

module.exports = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Formater chaque erreur { field, message }
    const formatted = errors.array().map(e => ({
      field: e.param,
      message: e.msg
    }));
    // Concaténer les messages pour err.message
    const msg = formatted.map(e => e.message).join(' • ');
    // Lever l’erreur avec le message détaillé et les détails
    return next(createError(400, msg, { details: formatted }));
  }
  next();
};
