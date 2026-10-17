"use strict";

/**
 * ============================================================================
 * PLAFONDS — LA POLITIQUE EN VIGUEUR ET SA GOUVERNANCE (2026-10-17)
 * ============================================================================
 *
 * Comme chez Revolut ou Wise, un plafond ne se change pas d'un clic :
 *
 *   propose  → un membre de la conformité dépose une VERSION complète,
 *              validée (`validatePolicy`) et motivée ;
 *   approve  → une AUTRE personne l'approuve (quatre yeux) : la version active
 *              passe `superseded`, la nouvelle devient `active` ;
 *   reject   → une autre personne la refuse, avec un motif.
 *
 * Rien ne s'efface ni ne se réécrit (`models/LimitPolicyVersion.js`).
 *
 * Sans version active en base, la politique est celle du CODE
 * (`DEFAULT_LIMITS`, reprise de la table AML historique) — annoncé par
 * `source: "default"` dans chaque réponse, jamais deviné. Une version active
 * qui ne se valide plus fait REFUSER toute opération (règle B.2) : un plafond
 * incohérent ne protège pas.
 *
 * Cache en mémoire de 30 s par instance : la politique est lue à chaque
 * opération, elle change rarement. Une approbation invalide le cache de
 * l'instance qui l'a traitée ; les autres suivent sous 30 s — délai assumé et
 * écrit, pas une incohérence cachée. Redis n'en détient rien (invariant 1).
 */

const { DEFAULT_LIMITS, DEFAULT_POLICY_PROVENANCE } = require("./limitCatalog");
const { LIMIT_CODES, LimitError, validatePolicy } = require("./limitPolicy");

const CACHE_TTL_MS = 30 * 1000;
const LIMIT_STAFF_ROLES = Object.freeze(["admin", "superadmin", "compliance"]);

function httpError(status, message, code, details) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  if (code) err.code = code;
  if (details) err.details = details;
  return err;
}

const actorIdOf = (actor) => {
  const raw = actor?.staffId ?? actor?._id ?? actor?.id ?? null;
  return raw == null ? "" : String(raw);
};

/** `req.user` (relu en base par `internalProtect`) → acteur stockable. */
function toActor(user) {
  const staffId = actorIdOf(user);
  if (!staffId) throw httpError(401, "Utilisateur non authentifié.", "UNAUTHENTICATED");
  return {
    staffId,
    email: String(user.email || "").trim(),
    role: String(user.role || "").trim().toLowerCase(),
    at: new Date(),
  };
}

/**
 * Le rôle est relu en base par `internalProtect` : un jeton interne seul ne
 * suffit pas à changer un plafond (même règle que la gouvernance tarifaire).
 */
function assertLimitStaff(user) {
  if (!actorIdOf(user)) throw httpError(401, "Utilisateur non authentifié.", "UNAUTHENTICATED");
  const role = String(user?.role || "").trim().toLowerCase();
  if (!LIMIT_STAFF_ROLES.includes(role)) {
    throw httpError(403, "Rôle insuffisant pour la gouvernance des plafonds.", "FORBIDDEN");
  }
}

const publicVersion = (doc) =>
  doc && {
    version: doc.version,
    status: doc.status,
    limits: doc.limits,
    reason: doc.reason,
    proposedBy: doc.proposedBy,
    approvedBy: doc.approvedBy || null,
    rejectedBy: doc.rejectedBy || null,
    rejectionReason: doc.rejectionReason || null,
    activatedAt: doc.activatedAt || null,
    supersededAt: doc.supersededAt || null,
    createdAt: doc.createdAt,
  };

function createLimitPolicyService({ getModel, now = () => Date.now(), logger = console } = {}) {
  let cache = null;

  const Model = () => getModel();

  function invalidate() {
    cache = null;
  }

  /** `{ limits, version, source: "policy" | "default" }`. */
  async function getActivePolicy() {
    if (cache && cache.expiresAt > now()) return cache.value;

    const active = await Model().findOne({ status: "active" }).lean();

    let value;
    if (!active) {
      value = { limits: DEFAULT_LIMITS, version: 0, source: "default", provenance: DEFAULT_POLICY_PROVENANCE };
    } else {
      const errors = validatePolicy(active.limits);
      if (errors.length) {
        logger.error?.("[limits] Politique ACTIVE invalide — toute opération est REFUSÉE", {
          version: active.version,
          errors: errors.slice(0, 5),
          consequence: "aucun paiement ne passe tant qu'une version valide n'est pas approuvée",
        });
        throw new LimitError(LIMIT_CODES.UNDEFINED, "Politique de plafonds invalide.", { version: active.version });
      }
      value = { limits: active.limits, version: active.version, source: "policy" };
    }

    cache = { value, expiresAt: now() + CACHE_TTL_MS };
    return value;
  }

  async function propose({ limits, reason, user }) {
    assertLimitStaff(user);

    const motif = String(reason || "").trim();
    if (motif.length < 10) {
      throw httpError(400, "Motif requis (10 caractères au moins).", "LIMIT_POLICY_REASON_REQUIRED");
    }

    const errors = validatePolicy(limits);
    if (errors.length) {
      throw httpError(400, "Politique de plafonds invalide.", "LIMIT_POLICY_INVALID", { errors });
    }

    const pending = await Model().countDocuments({ status: "proposed" });
    if (pending > 0) {
      throw httpError(
        409,
        "Une proposition est déjà en attente : approuvez-la ou rejetez-la d'abord.",
        "LIMIT_POLICY_PENDING_EXISTS"
      );
    }

    const last = await Model().findOne({}).sort({ version: -1 }).select("version").lean();
    const version = (last?.version || 0) + 1;

    const doc = await Model().create({
      version,
      status: "proposed",
      limits,
      reason: motif,
      proposedBy: toActor(user),
    });

    return publicVersion(doc.toObject ? doc.toObject() : doc);
  }

  async function approve({ version, user }) {
    assertLimitStaff(user);
    const v = Number(version);

    const doc = await Model().findOne({ version: v }).lean();
    if (!doc) throw httpError(404, "Version introuvable.", "LIMIT_POLICY_NOT_FOUND");
    if (doc.status !== "proposed") {
      throw httpError(409, `Version ${v} non approuvable (statut ${doc.status}).`, "LIMIT_POLICY_NOT_PROPOSED");
    }
    if (actorIdOf(doc.proposedBy) === actorIdOf(user)) {
      throw httpError(403, "Quatre yeux : l'auteur d'une proposition ne peut pas l'approuver.", "FOUR_EYES_REQUIRED");
    }

    // Revalidée à l'approbation : le catalogue a pu changer depuis le dépôt.
    const errors = validatePolicy(doc.limits);
    if (errors.length) {
      throw httpError(409, "La proposition n'est plus valide.", "LIMIT_POLICY_INVALID", { errors });
    }

    const approvedBy = toActor(user);
    const at = new Date(now());

    // 1. L'active actuelle passe `superseded` (l'index partiel n'autorise qu'une active).
    const previous = await Model().findOneAndUpdate(
      { status: "active" },
      { $set: { status: "superseded", supersededAt: at } },
      { new: false }
    );

    // 2. La proposition devient active — seulement si elle est TOUJOURS proposée.
    const activated = await Model().findOneAndUpdate(
      { version: v, status: "proposed" },
      { $set: { status: "active", approvedBy, activatedAt: at } },
      { new: true }
    );

    if (!activated) {
      // Course perdue (une autre approbation ou un rejet est passé) : on remet
      // l'ancienne en place plutôt que de laisser le système sans politique.
      if (previous) {
        await Model().updateOne(
          { version: previous.version, status: "superseded" },
          { $set: { status: "active", supersededAt: null } }
        );
      }
      throw httpError(409, "La proposition a changé pendant l'approbation.", "LIMIT_POLICY_CONFLICT");
    }

    invalidate();
    logger.info?.("[limits] Nouvelle politique de plafonds ACTIVE", {
      version: v,
      previousVersion: previous?.version ?? null,
      proposedBy: doc.proposedBy?.staffId,
      approvedBy: approvedBy.staffId,
    });

    return publicVersion(activated.toObject ? activated.toObject() : activated);
  }

  async function reject({ version, user, reason }) {
    assertLimitStaff(user);
    const v = Number(version);
    const motif = String(reason || "").trim();
    if (motif.length < 5) {
      throw httpError(400, "Motif de rejet requis.", "LIMIT_POLICY_REASON_REQUIRED");
    }

    const doc = await Model().findOne({ version: v }).lean();
    if (!doc) throw httpError(404, "Version introuvable.", "LIMIT_POLICY_NOT_FOUND");
    if (doc.status !== "proposed") {
      throw httpError(409, `Version ${v} non rejetable (statut ${doc.status}).`, "LIMIT_POLICY_NOT_PROPOSED");
    }
    if (actorIdOf(doc.proposedBy) === actorIdOf(user)) {
      throw httpError(403, "Quatre yeux : l'auteur d'une proposition ne peut pas la rejeter lui-même.", "FOUR_EYES_REQUIRED");
    }

    const updated = await Model().findOneAndUpdate(
      { version: v, status: "proposed" },
      { $set: { status: "rejected", rejectedBy: toActor(user), rejectionReason: motif } },
      { new: true }
    );
    if (!updated) throw httpError(409, "La proposition a changé entre-temps.", "LIMIT_POLICY_CONFLICT");

    return publicVersion(updated.toObject ? updated.toObject() : updated);
  }

  async function history({ user, limit = 50 }) {
    assertLimitStaff(user);
    const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const docs = await Model().find({}).sort({ version: -1 }).limit(max).lean();
    const active = await getActivePolicy();
    return {
      active: { version: active.version, source: active.source, limits: active.limits },
      versions: docs.map(publicVersion),
    };
  }

  return { getActivePolicy, propose, approve, reject, history, invalidate };
}

let shared = null;

/** Instance du processus, sur la connexion des transactions. */
function getLimitPolicyService() {
  if (!shared) {
    shared = createLimitPolicyService({
      getModel: () => {
        const { getTxConn } = require("../../config/db");
        return require("../../models/LimitPolicyVersion")(getTxConn());
      },
      logger: require("../../utils/logger"),
    });
  }
  return shared;
}

module.exports = {
  CACHE_TTL_MS,
  LIMIT_STAFF_ROLES,
  createLimitPolicyService,
  getLimitPolicyService,
  assertLimitStaff,
};
