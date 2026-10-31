"use strict";

const { BANDS, SOFT_SCORE_CAP, WEIGHTS } = require("./riskScore");

/**
 * Tunable risk rules. Compliance adjusts when a transaction goes to review; it
 * can never make the engine refuse on soft signals, nor disarm it.
 *
 * Out of reach by construction: sanctions and blocklist hits decide alone, the
 * block band is fixed, and the soft cap keeps every tunable signal below it.
 */

const REVIEW_MIN = 0.35;
// Below the soft cap, or a soft score could never reach review.
const REVIEW_MAX = 0.75;
const WEIGHT_MAX = 0.5;

const TUNABLE_WEIGHTS = Object.freeze(
  Object.keys(WEIGHTS).filter((key) => key !== "SIGNAL_UNAVAILABLE")
);

const DEFAULT_POLICY = Object.freeze({ version: 0, review: BANDS.REVIEW, weights: {} });

const CACHE_TTL_MS = 60 * 1000;

function httpError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (details) err.details = details;
  return err;
}

/** Returns the list of refusals; empty means the policy can be proposed. Pure. */
function validateRiskPolicy({ review, weights = {} } = {}) {
  const errors = [];

  if (!Number.isFinite(review) || review < REVIEW_MIN || review > REVIEW_MAX) {
    errors.push(`Le seuil de revue doit être entre ${REVIEW_MIN} et ${REVIEW_MAX}.`);
  }
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) {
    errors.push("Poids illisibles.");
    return errors;
  }

  for (const [key, value] of Object.entries(weights)) {
    if (!TUNABLE_WEIGHTS.includes(key)) errors.push(`Signal non réglable : ${key}.`);
    else if (!Number.isFinite(value) || value < 0 || value > WEIGHT_MAX) {
      errors.push(`Poids hors bornes pour ${key} : entre 0 et ${WEIGHT_MAX}.`);
    }
  }

  return errors;
}

const toDecisionPolicy = (doc) => ({ version: doc.version, review: doc.review, weights: doc.weights || {} });

function assertActor(actor) {
  if (!actor?.staffId) throw httpError(401, "ACTOR_REQUIRED", "Auteur inconnu.");
}

function createRiskPolicyService({ getModel, now = () => Date.now(), logger = console }) {
  let cache = null;

  /**
   * Never throws: transactions keep running on the reviewed defaults, and the
   * failure is logged with its consequence. The defaults are the strict baseline.
   */
  async function getActive() {
    if (cache && cache.expiresAt > now()) return cache.value;

    let value = DEFAULT_POLICY;
    try {
      const active = await getModel().findOne({ status: "active" }).lean();
      if (active) {
        const errors = validateRiskPolicy(active);
        if (errors.length) {
          logger.error?.("[risk] Politique active invalide : valeurs d'origine appliquées", {
            version: active.version,
            errors: errors.slice(0, 3),
          });
        } else {
          value = toDecisionPolicy(active);
        }
      }
    } catch (err) {
      logger.error?.("[risk] Politique illisible : valeurs d'origine appliquées", {
        message: err?.message,
      });
    }

    cache = { value, expiresAt: now() + CACHE_TTL_MS };
    return value;
  }

  async function overview() {
    const versions = await getModel().find({}).sort({ version: -1 }).limit(50).lean();
    return {
      versions,
      defaults: { review: BANDS.REVIEW, weights: WEIGHTS },
      bounds: { reviewMin: REVIEW_MIN, reviewMax: REVIEW_MAX, weightMax: WEIGHT_MAX, softCap: SOFT_SCORE_CAP },
      tunable: TUNABLE_WEIGHTS,
    };
  }

  async function propose({ review, weights = {}, reason, actor }) {
    assertActor(actor);

    const motif = String(reason || "").trim();
    if (motif.length < 10) throw httpError(400, "REASON_REQUIRED", "Motif de 10 caractères minimum.");

    const errors = validateRiskPolicy({ review, weights });
    if (errors.length) throw httpError(400, "RISK_POLICY_INVALID", errors[0], { errors });

    const Model = getModel();
    if (await Model.exists({ status: "proposed" })) {
      throw httpError(409, "RISK_POLICY_PENDING", "Une version attend déjà une décision.");
    }

    const last = await Model.findOne({}).sort({ version: -1 }).select("version").lean();
    return Model.create({
      version: (last?.version || 0) + 1,
      status: "proposed",
      review,
      weights,
      reason: motif,
      proposedBy: { ...actor, at: new Date(now()) },
    });
  }

  async function decide({ version, decision, actor, reason }) {
    assertActor(actor);
    if (!["approve", "reject"].includes(decision)) throw httpError(404, "NOT_FOUND", "Décision inconnue.");

    const Model = getModel();
    const at = new Date(now());
    const guard = {
      version,
      status: "proposed",
      "proposedBy.staffId": { $ne: String(actor.staffId) },
    };

    if (decision === "reject") {
      const motif = String(reason || "").trim();
      if (motif.length < 10) throw httpError(400, "REASON_REQUIRED", "Motif de 10 caractères minimum.");

      const rejected = await Model.findOneAndUpdate(
        guard,
        { $set: { status: "rejected", rejectedBy: { ...actor, at }, rejectionReason: motif } },
        { new: true }
      );
      if (!rejected) throw httpError(409, "RISK_POLICY_DECISION_REFUSED", "Décision refusée : une autre personne doit trancher une version en attente.");
      return rejected;
    }

    const current = await Model.findOne({ status: "active" }).select("_id").lean();
    if (current) {
      await Model.updateOne({ _id: current._id }, { $set: { status: "superseded", supersededAt: at } });
    }

    const approved = await Model.findOneAndUpdate(
      guard,
      { $set: { status: "active", approvedBy: { ...actor, at }, activatedAt: at } },
      { new: true }
    );

    if (!approved) {
      // The filter refused: the version that was active stays active.
      if (current) await Model.updateOne({ _id: current._id }, { $set: { status: "active", supersededAt: null } });
      throw httpError(409, "RISK_POLICY_DECISION_REFUSED", "Décision refusée : une autre personne doit approuver une version en attente.");
    }

    cache = null;
    return approved;
  }

  return { decide, getActive, overview, propose };
}

let service = null;

function getRiskPolicyService() {
  if (!service) {
    const { getTxConn } = require("../../config/db");
    service = createRiskPolicyService({
      getModel: () => require("../../models/RiskPolicyVersion")(getTxConn()),
    });
  }
  return service;
}

module.exports = {
  DEFAULT_POLICY,
  REVIEW_MAX,
  REVIEW_MIN,
  TUNABLE_WEIGHTS,
  createRiskPolicyService,
  getRiskPolicyService,
  validateRiskPolicy,
};
