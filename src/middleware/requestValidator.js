// src/middleware/requestValidator.js
const { validationResult } = require('express-validator');

module.exports = (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    const formatted = result.array().map(({ param, msg }) => ({
      field: param,
      message: msg
    }));
    return res.status(400).json({
      success: false,
      errors: formatted
    });
  }
  next();
};
