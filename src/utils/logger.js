// File: src/utils/logger.js
const { createLogger, format, transports } = require('winston');
const { redactWinstonInfo } = require('./logRedaction');
const { redactSensitive } = require('./redactSensitive');

/** Règle B.4 : masquage par clé puis par valeur, sur chaque ligne. */
const redactPii = format((info) => redactWinstonInfo(info, redactSensitive));

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    redactPii(),
    format.json()
  ),
  defaultMeta: { service: 'paynoval-transactions' },
  transports: [
    new transports.Console(),
    // Pour log file: décommente si besoin
    // new transports.File({ filename: 'logs/error.log', level: 'error' }),
    // new transports.File({ filename: 'logs/combined.log' })
  ],
});

module.exports = logger;
