// File: src/middleware/requestValidator.js
"use strict";

const { validationResult } = require("express-validator");
const createError = require("http-errors");

module.exports = (req, res, next) => {
  try {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      const formatted = errors.array({ onlyFirstError: true }).map((e) => ({
        field: e.param || e.path || "unknown",
        message: e.msg || "Validation error",
      }));

      const msg = formatted.map((e) => e.message).join(" • ");
      return next(createError(400, msg, { details: formatted, code: "VALIDATION_ERROR" }));
    }

    return next();
  } catch (e) {
    return next(createError(500, "Erreur validation requête", { code: "VALIDATOR_CRASH" }));
  }
};
