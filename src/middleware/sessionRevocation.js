"use strict";

const mongoose = require("mongoose");

const STAFF_ROLES = new Set([
  "support",
  "admin",
  "superadmin",
  "compliance",
  "security",
  "fraud-analyst",
  "finance",
  "readonly",
]);

const isStaffRole = (role) => STAFF_ROLES.has(String(role || "").trim().toLowerCase());

/** True when the token predates a force-logout. `iat` is in whole seconds. */
function issuedBeforeCut(decoded, user) {
  if (!user?.tokensInvalidBefore || typeof decoded?.iat !== "number") return false;
  return (decoded.iat + 1) * 1000 <= new Date(user.tokensInvalidBefore).getTime();
}

/**
 * Returns the refusal for a revoked token, or null. Staff tokens must point to
 * a live session of `staffsessions` (owned by the backend, same users
 * database). Fails closed when the session cannot be read.
 */
async function readSessionRefusal({ user, decoded, database, now = Date.now() }) {
  if (issuedBeforeCut(decoded, user)) {
    return { status: 401, message: "Session révoquée" };
  }
  if (!isStaffRole(user?.role)) return null;

  if (!decoded?.sid || !mongoose.isValidObjectId(decoded.sid)) {
    return { status: 401, message: "Session du personnel requise" };
  }

  let session;
  try {
    session = await database.collection("staffsessions").findOne(
      { _id: new mongoose.Types.ObjectId(String(decoded.sid)), user: user._id },
      { projection: { revokedAt: 1, absoluteExpiresAt: 1 } }
    );
  } catch (_err) {
    return { status: 503, message: "Vérification de session indisponible" };
  }

  if (!session || session.revokedAt || new Date(session.absoluteExpiresAt).getTime() <= now) {
    return { status: 401, message: "Session du personnel expirée" };
  }
  return null;
}

module.exports = { isStaffRole, issuedBeforeCut, readSessionRefusal };
