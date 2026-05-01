// File: src/middleware/requireTransactionEligibility.js
"use strict";

const createError = require("http-errors");

const runtime = require("../services/transactions/shared/runtime");

const {
  TX_ELIGIBILITY_USER_SELECT,
  assertUserCanTransact,
  buildEligibilitySnapshot,
  mergeEligibilityMetadata,
} = require("../services/transactions/shared/transactionEligibility");

/**
 * --------------------------------------------------------------------------
 * TX-Core — Middleware d’éligibilité transactionnelle
 * --------------------------------------------------------------------------
 *
 * Rôle :
 * - dernière barrière côté tx-core
 * - refuse initiate/confirm si :
 *   - email non vérifié
 *   - téléphone non vérifié
 *   - KYC non validé pour compte personnel
 *   - KYB non validé pour compte entreprise
 *   - compte bloqué / gelé / suspendu / supprimé
 *
 * Important :
 * - à utiliser sur /initiate et /confirm
 * - ne pas utiliser sur /cancel, refund, auto-cancel, webhooks
 * --------------------------------------------------------------------------
 */

function getRequesterId(req) {
  return String(
    req.user?._id ||
      req.user?.id ||
      req.user?.userId ||
      req.body?.userId ||
      ""
  ).trim();
}

function ensurePlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function getLogger() {
  return runtime.logger || console;
}

function buildResponseError(err) {
  const status = err.status || err.statusCode || 403;

  return {
    status,
    body: {
      success: false,
      code: err.code || "TRANSACTION_ELIGIBILITY_FAILED",
      error:
        err.message ||
        "Votre profil ne permet pas encore d’effectuer cette transaction.",
      message:
        err.message ||
        "Votre profil ne permet pas encore d’effectuer cette transaction.",
      details: Array.isArray(err.details) ? err.details : [],
      requiresVerification: err.requiresVerification === true,
    },
  };
}

module.exports = async function requireTransactionEligibility(req, res, next) {
  try {
    const User = runtime.User;

    if (!User) {
      throw createError(
        500,
        "User model indisponible pour contrôle transactionnel."
      );
    }

    const userId = getRequesterId(req);

    if (!userId) {
      throw createError(401, "Utilisateur non authentifié.");
    }

    const user = await User.findById(userId)
      .select(TX_ELIGIBILITY_USER_SELECT.join(" "))
      .lean();

    const result = assertUserCanTransact(user, {
      roleLabel: "utilisateur",
      codePrefix: "USER",
    });

    const requesterSnapshot = result.snapshot || buildEligibilitySnapshot(user);

    req.transactionEligibility = {
      ok: true,
      checkedAt: new Date().toISOString(),
      user: requesterSnapshot,
    };

    req.verifiedUserProfile = user;

    const body = ensurePlainObject(req.body);

    body.metadata = mergeEligibilityMetadata(body.metadata, {
      requester: requesterSnapshot,
    });

    body.meta = mergeEligibilityMetadata(body.meta, {
      requester: requesterSnapshot,
    });

    req.body = body;

    return next();
  } catch (err) {
    const logger = getLogger();

    try {
      logger.warn?.("[TX ELIGIBILITY] transaction blocked", {
        code: err.code || "TRANSACTION_ELIGIBILITY_FAILED",
        status: err.status || err.statusCode || 403,
        message: err.message,
        userId: getRequesterId(req) || null,
        path: req.originalUrl || req.url,
        method: req.method,
      });
    } catch {}

    const { status, body } = buildResponseError(err);

    return res.status(status).json(body);
  }
};