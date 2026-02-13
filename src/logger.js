// src/logger.js
"use strict";

const fs = require("fs");
const path = require("path");
const { createLogger, format, transports } = require("winston");

const isProd = process.env.NODE_ENV === "production";
const isRender = !!process.env.RENDER; // Render set souvent cette variable

// Supporte LOG_LEVEL (standard) + fallback LOGS_LEVEL (ton ancien)
const level = process.env.LOG_LEVEL || process.env.LOGS_LEVEL || (isProd ? "info" : "debug");

// Nom de service pour retrouver facilement dans les logs
const serviceName = process.env.SERVICE_NAME || "paynoval-transactions";

// Activer logs fichiers uniquement si tu le veux explicitement (sinon Render = console JSON)
const enableFileLogs =
  String(process.env.LOG_TO_FILES || "").toLowerCase() === "true" && !isRender;

// Dossier logs (si activé)
const logsDir = path.join(__dirname, "..", "logs");
if (enableFileLogs) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch (e) {
    // Si création impossible, on retombe sur console-only
    // (mais sans faire crasher ton service)
    // eslint-disable-next-line no-console
    console.warn("[logger] cannot create logs dir:", e.message);
  }
}

// Format JSON prod (Render) : proche de tes logs actuels
const jsonLine = format.combine(
  format.timestamp({ format: () => new Date().toISOString() }),
  format.errors({ stack: true }),
  format.splat(),
  format((info) => {
    // Uniformiser la clé "message"
    if (info.message instanceof Error) info.message = info.message.message;

    // Ajouter service partout
    info.service = info.service || serviceName;

    // Winston garde parfois des champs Symbol; on ne touche pas
    return info;
  })(),
  format.json()
);

// Format dev lisible
const devPretty = format.combine(
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  format.colorize(),
  format.errors({ stack: true }),
  format.splat(),
  format.printf(({ timestamp, level, message, service, ...meta }) => {
    const metaStr = Object.keys(meta || {}).length ? ` ${JSON.stringify(meta)}` : "";
    const svc = service ? `(${service}) ` : "";
    return `[${timestamp}] ${level} ${svc}${message}${metaStr}`;
  })
);

const logger = createLogger({
  level,
  defaultMeta: { service: serviceName },
  format: isProd ? jsonLine : devPretty,
  transports: [
    new transports.Console({
      // En prod on garde JSON (Render). En dev on garde pretty.
      format: isProd ? jsonLine : devPretty,
    }),
  ],
  exitOnError: false,
});

// Logs fichiers (optionnel)
if (enableFileLogs) {
  logger.add(
    new transports.File({
      filename: path.join(logsDir, "combined.log"),
      level: "info",
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    })
  );

  logger.add(
    new transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
      tailable: true,
    })
  );
}

// Pour morgan: app.use(morgan('combined', { stream: logger.stream }))
logger.stream = {
  write: (message) => logger.info(message.trim()),
};

module.exports = logger;
