// src/logger.js

const { createLogger, format, transports } = require('winston');
const path = require('path');

// Détermine l'environnement pour adapter les transports (fichiers surtout en prod)
const isProd = process.env.NODE_ENV === 'production';

const logger = createLogger({
  level: process.env.LOGS_LEVEL || (isProd ? 'info' : 'debug'),
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),           // Log stack trace des erreurs
    format.splat(),
    format.json()
  ),
  transports: [
    // Console en couleur en dev
    new transports.Console({
      format: isProd
        ? format.simple()
        : format.combine(
            format.colorize(),
            format.printf(({ timestamp, level, message, ...meta }) => {
              // Meta peut contenir l'objet loggué (payload, etc)
              return `[${timestamp}] [${level}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
            })
          )
    }),
    // Fichiers en prod et dev (log complet et erreurs)
    new transports.File({
      filename: path.join(__dirname, '..', 'logs', 'combined.log'),
      level: 'info',
      maxsize: 5 * 1024 * 1024,  // 5MB par fichier
      maxFiles: 5,
      tailable: true
    }),
    new transports.File({
      filename: path.join(__dirname, '..', 'logs', 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
      tailable: true
    }),
  ],
  exitOnError: false,
});

// Pour pouvoir logger facilement avec req.logger (middleware si tu veux)
logger.stream = {
  write: (message) => logger.info(message.trim())
};

module.exports = logger;
