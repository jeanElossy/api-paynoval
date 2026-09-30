"use strict";

/**
 * Mounted on POST /transactions/initiate BEFORE `idempotency()` (an SCA refusal
 * must not be frozen under the key) and before any normalizer: the signature
 * covers the body exactly as sent.
 * Pure decision: `services/security/transactionSignature.js`.
 */

const createError = require("http-errors");
const { getUsersConn } = require("../config/db");
const { buildSignedMessage, decideSignature } = require("../services/security/transactionSignature");

let _Device = null;
function getDeviceModel() {
  if (_Device) return _Device;
  _Device = require("../models/Device")(getUsersConn());
  return _Device;
}

const MESSAGES = {
  SCA_REQUIRED: "Confirmation biométrique requise pour ce paiement.",
  SCA_DEVICE_NOT_BOUND:
    "Cet appareil n'est pas autorisé à valider des paiements. Autorisez-le avec votre mot de passe.",
  SCA_EXPIRED: "Confirmation expirée. Recommencez.",
  SCA_INVALID: "Confirmation invalide.",
};

function requireTransactionSignature({ Device: injected } = {}) {
  return async function transactionSignature(req, res, next) {
    try {
      // Service-to-service calls carry no user device.
      if (req.auth?.assertedIdentity) return next();

      const userId = String(req.user?._id || req.user?.id || "");
      if (!userId) return next(createError(401, "Non autorisé"));

      const Device = injected || getDeviceModel();

      const deviceSigningKey = req.device?.signingKey || null;
      const userHasBoundDevice = Boolean(
        await Device.exists({
          user: userId,
          status: { $ne: "blocked" },
          "signingKey.publicKey": { $type: "string" },
          "signingKey.revokedAt": null,
        })
      );

      const signature = req.headers["x-paynoval-signature"] || null;
      const timestamp = req.headers["x-paynoval-signature-ts"] || null;
      const deviceId = String(req.device?._id || "");
      // Read from the header: this check runs BEFORE `idempotency()`, so that an
      // SCA refusal is never frozen under the key (the user retries with it).
      const idempotencyKey = String(
        req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || ""
      ).trim();

      const verdict = decideSignature({
        deviceSigningKey,
        userHasBoundDevice,
        signature,
        timestamp,
        message: buildSignedMessage({
          userId,
          deviceId,
          idempotencyKey,
          body: req.body,
          timestamp,
        }),
      });

      req.sca = { level: verdict.level || null, code: verdict.code };

      if (!verdict.ok) {
        return next(createError(verdict.status, MESSAGES[verdict.code] || "Confirmation requise.", { code: verdict.code }));
      }

      return next();
    } catch (err) {
      // Fail CLOSED: an unverifiable payment does not go through.
      return next(createError(503, "Vérification de la confirmation indisponible", { code: "SCA_UNAVAILABLE" }));
    }
  };
}

module.exports = { requireTransactionSignature };
