"use strict";

/**
 * Plafonds — contrôleurs (2026-10-17).
 *
 *   GET  /api/v1/limits?currency=XOF          le client : ses plafonds, ce qu'il
 *                                             a utilisé, ce qui reste, quand ça
 *                                             se libère (écran « Mes plafonds ») ;
 *   /api/v1/limit-policies (interne)          la conformité : historique,
 *                                             proposition, approbation et rejet
 *                                             à quatre yeux.
 *
 * Aucune logique ici : `services/limits/`.
 */

const { getLimitService } = require("../services/limits/limitService");
const { getLimitPolicyService } = require("../services/limits/limitPolicyService");
const { LimitError } = require("../services/limits/limitPolicy");

const userIdOf = (req) => String(req.user?._id || req.user?.id || "").trim();

function sendLimitError(res, err) {
  return res.status(400).json({ success: false, code: err.code, error: err.message, details: err.details });
}

exports.getMyLimits = async (req, res, next) => {
  try {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ success: false, code: "UNAUTHENTICATED", error: "Non authentifié." });

    const data = await getLimitService().describeLimits({ userId, currency: req.query.currency });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    if (err instanceof LimitError) return sendLimitError(res, err);
    return next(err);
  }
};

const respond = (fn, status = 200) => async (req, res, next) => {
  try {
    const data = await fn(req);
    return res.status(status).json({ success: true, data });
  } catch (err) {
    if (err?.status && err.status < 500) {
      return res.status(err.status).json({
        success: false,
        code: err.code || "LIMIT_POLICY_ERROR",
        error: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
    }
    return next(err);
  }
};

exports.listPolicies = respond((req) =>
  getLimitPolicyService().history({ user: req.user, limit: req.query.limit })
);

exports.proposePolicy = respond(
  (req) => getLimitPolicyService().propose({ limits: req.body?.limits, reason: req.body?.reason, user: req.user }),
  201
);

exports.approvePolicy = respond((req) =>
  getLimitPolicyService().approve({ version: req.params.version, user: req.user })
);

exports.rejectPolicy = respond((req) =>
  getLimitPolicyService().reject({ version: req.params.version, reason: req.body?.reason, user: req.user })
);
