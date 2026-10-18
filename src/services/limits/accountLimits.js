"use strict";

/**
 * Per-account limit overrides — applied by the engine since 2026-10-18.
 *
 * The back office set them on `User.limits` (Users database, written by
 * paynoval-backend) since 2026-08, but NOTHING applied them: an admin who
 * "capped" a risky account had capped nothing. This module is the rule; the
 * limit service applies it to every operation, exactly like the policy.
 *
 * Reference: Wise / Revolut account-level limits set by compliance.
 *   · A value LOWER than the policy applies at once (restricting is safe).
 *   · A value HIGHER than the policy applies ONLY once approved by ANOTHER
 *     person, for this exact revision (`approvedRevision === revision`,
 *     `approvedBy !== updatedBy`). Editing the override voids the approval.
 *   · It applies per operation × rail, in its own currency, on the same three
 *     windows as the policy: per operation, 24 h and 30 days rolling.
 *     An override in another currency does not apply (no invented FX).
 *
 * Pure: no I/O.
 */

const DIMENSIONS = Object.freeze([
  ["perTransaction", "perTransaction"],
  ["rolling24h", "daily"],
  ["rolling30d", "monthly"],
]);

const ISO = /^[A-Z]{3}$/;

function positiveNumber(v) {
  const n = typeof v === "object" && v !== null && typeof v.toString === "function" ? Number(v.toString()) : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Raw `User.limits` → normalized override, or null when nothing is set.
 * A value without a readable currency cannot be applied safely: the account
 * currency is used (it is the currency the back office displays).
 */
function readAccountLimits(raw, userCurrency) {
  if (!raw || typeof raw !== "object") return null;

  const values = {
    perTransaction: raw.perTransaction == null ? null : positiveNumber(raw.perTransaction),
    daily: raw.daily == null ? null : positiveNumber(raw.daily),
    monthly: raw.monthly == null ? null : positiveNumber(raw.monthly),
  };

  if (values.perTransaction === null && values.daily === null && values.monthly === null) return null;

  const currency = String(raw.currency || userCurrency || "").trim().toUpperCase();
  const revision = Number(raw.revision) || 0;
  const approved =
    Boolean(raw.approvedAt) &&
    Number(raw.approvedRevision) === revision &&
    raw.approvedBy != null &&
    String(raw.approvedBy) !== String(raw.updatedBy || "");

  return { ...values, currency: ISO.test(currency) ? currency : null, revision, approved };
}

/**
 * Policy limit + account override → effective limit.
 *
 * @param {{ perTransaction, rolling24h, rolling30d, currency }} limit  resolved policy limit
 * @param {object|null} account  from `readAccountLimits`
 * @returns {object} the limit to evaluate, with `sources` and `elevationPending`
 */
function applyAccountLimits(limit, account) {
  const sources = { perTransaction: "policy", rolling24h: "policy", rolling30d: "policy" };
  const out = { ...limit, sources, elevationPending: false };

  if (!account || !account.currency || account.currency !== limit.currency) return out;

  for (const [policyKey, accountKey] of DIMENSIONS) {
    const value = account[accountKey];
    if (value === null || value === undefined) continue;

    if (value <= limit[policyKey]) {
      out[policyKey] = value;
      sources[policyKey] = "account";
    } else if (account.approved) {
      out[policyKey] = value;
      sources[policyKey] = "account_elevated";
    } else {
      out.elevationPending = true;
    }
  }

  return out;
}

module.exports = { readAccountLimits, applyAccountLimits, DIMENSIONS };
