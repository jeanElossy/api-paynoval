"use strict";

/**
 * Mandatory two-factor authentication for STAFF — decided 2026-10-18.
 *
 * Stripe, Revolut and N26 never make staff 2FA optional: a back-office
 * password alone must not be able to cut the platform, move money or read
 * KYC. The former "require 2FA" switch of the settings page did nothing.
 *
 * ⚠️ Same file in paynoval-backend/services/staffTwoFactor.js and api-paynoval/src/services/staffTwoFactor.js (Tx-Core
 * admin actions are guarded too).
 *
 *   · before `enforceFrom` (grace period): allowed, with a signal so the
 *     console shows "activate 2FA before <date>";
 *   · from `enforceFrom`: every staff route is refused (403
 *     STAFF_2FA_REQUIRED) until 2FA is enabled. The 2FA set-up routes
 *     (/auth/2fa/*) are never behind a staff guard, so enrolment stays open.
 *
 * `STAFF_2FA_ENFORCE_FROM` (ISO date) overrides the default below. An
 * unreadable value falls back to the default — never to "never".
 */

const DEFAULT_ENFORCE_FROM = "2026-10-25T00:00:00.000Z";

const STAFF_ROLES = Object.freeze(["finance", "readonly", "support", "compliance", "admin", "superadmin", "security", "fraud-analyst"]);

function enforceFromDate(env = process.env) {
  const raw = String(env.STAFF_2FA_ENFORCE_FROM || "").trim();
  const t = raw ? Date.parse(raw) : NaN;
  return new Date(Number.isFinite(t) ? t : Date.parse(DEFAULT_ENFORCE_FROM));
}

/**
 * @returns {"not_staff"|"ok"|"grace"|"blocked"}
 */
function staffTwoFactorVerdict({ role, twoFaEnabled, now = Date.now(), enforceFrom = enforceFromDate() }) {
  const r = String(role || "").trim().toLowerCase();
  if (!STAFF_ROLES.includes(r)) return "not_staff";
  if (twoFaEnabled === true) return "ok";
  return now < enforceFrom.getTime() ? "grace" : "blocked";
}

const REFUSAL = Object.freeze({
  success: false,
  code: "STAFF_2FA_REQUIRED",
  message:
    "Double authentification obligatoire pour le personnel : activez-la (Profil → Sécurité) pour accéder à la console.",
});

/**
 * Express helper used by the role guards. Returns true when it answered.
 */
function applyStaffTwoFactor(req, res, { now = Date.now(), enforceFrom = enforceFromDate() } = {}) {
  const verdict = staffTwoFactorVerdict({ role: req.user && req.user.role, twoFaEnabled: req.user && req.user.twoFaEnabled, now, enforceFrom });
  if (verdict === "grace") {
    try {
      res.setHeader("X-Staff-2FA-Required", `grace; until=${enforceFrom.toISOString()}`);
    } catch {
      /* headers already sent: nothing to signal */
    }
    return false;
  }
  if (verdict !== "blocked") return false;
  res.status(403).json({ ...REFUSAL, enforcedSince: enforceFrom.toISOString() });
  return true;
}

module.exports = { DEFAULT_ENFORCE_FROM, STAFF_ROLES, enforceFromDate, staffTwoFactorVerdict, applyStaffTwoFactor, REFUSAL };
