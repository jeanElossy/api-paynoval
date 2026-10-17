"use strict";

/**
 * SHARED decision vectors of the service-control policy.
 *
 * ⚠️ Same file, byte for byte, in:
 *     paynoval-backend/tests/fixtures/serviceControlVectors.js
 *     api-paynoval/test/fixtures/serviceControlVectors.js
 *
 * Both repositories run every vector against their copy of policy.js: the
 * backend (which serves the app) and Tx-Core (which moves the money) must
 * take the same decision. Contract: docs/architecture/service-control.md §5.
 */

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const H = 3600 * 1000;

const state = (scopeType, scopeKey, level, extra = {}) => ({ scopeType, scopeKey, level, userMessage: { fr: "", en: "" }, ...extra });

const VECTORS = [
  { name: "nothing set: operational", states: [], ctx: { features: ["money.withdraw"] }, phase: "initiate", expect: { allowed: true, level: "OPERATIONAL" } },
  { name: "DEGRADED never refuses", states: [state("global", "all", "DEGRADED")], ctx: { features: ["money.withdraw"] }, phase: "initiate", expect: { allowed: true, level: "DEGRADED" } },

  // READ_ONLY
  { name: "global READ_ONLY refuses a new withdrawal", states: [state("global", "all", "READ_ONLY")], ctx: { features: ["money.withdraw"] }, phase: "initiate", expect: { allowed: false, code: "READ_ONLY_MODE" } },
  { name: "global READ_ONLY lets a confirmation finish (drain)", states: [state("global", "all", "READ_ONLY")], ctx: { features: ["money.transfer.internal"] }, phase: "confirm", expect: { allowed: true } },
  { name: "global READ_ONLY keeps reads", states: [state("global", "all", "READ_ONLY")], ctx: { features: [] }, phase: "read", expect: { allowed: true } },
  { name: "global READ_ONLY + Wave OPERATIONAL = READ_ONLY (most restrictive wins)", states: [state("global", "all", "READ_ONLY"), state("provider", "wave", "OPERATIONAL")], ctx: { features: ["money.deposit"], providers: ["wave"] }, phase: "initiate", expect: { allowed: false, code: "READ_ONLY_MODE", level: "READ_ONLY" } },

  // MAINTENANCE, narrow
  { name: "feature MAINTENANCE refuses initiate", states: [state("feature", "money.withdraw", "MAINTENANCE")], ctx: { features: ["money.withdraw"] }, phase: "initiate", expect: { allowed: false, code: "FEATURE_UNAVAILABLE" } },
  { name: "feature MAINTENANCE refuses confirm", states: [state("feature", "money.withdraw", "MAINTENANCE")], ctx: { features: ["money.withdraw"] }, phase: "confirm", expect: { allowed: false, code: "FEATURE_UNAVAILABLE" } },
  { name: "feature MAINTENANCE keeps reads", states: [state("feature", "money.withdraw", "MAINTENANCE")], ctx: { features: ["money.withdraw"] }, phase: "read", expect: { allowed: true } },
  { name: "feature MAINTENANCE does not touch another feature", states: [state("feature", "money.withdraw", "MAINTENANCE")], ctx: { features: ["money.deposit"] }, phase: "initiate", expect: { allowed: true } },
  { name: "group money MAINTENANCE covers card transfers", states: [state("feature", "money", "MAINTENANCE")], ctx: { features: ["money.transfer.card"] }, phase: "initiate", expect: { allowed: false, code: "FEATURE_UNAVAILABLE" } },
  { name: "group money.transfer does not cover deposits", states: [state("feature", "money.transfer", "MAINTENANCE")], ctx: { features: ["money.deposit"] }, phase: "initiate", expect: { allowed: true } },
  { name: "provider MAINTENANCE → PROVIDER_UNAVAILABLE", states: [state("provider", "orange", "MAINTENANCE")], ctx: { features: ["money.deposit"], providers: ["orange"] }, phase: "initiate", expect: { allowed: false, code: "PROVIDER_UNAVAILABLE" } },
  { name: "provider MAINTENANCE spares another operator", states: [state("provider", "orange", "MAINTENANCE")], ctx: { features: ["money.deposit"], providers: ["wave"] }, phase: "initiate", expect: { allowed: true } },
  { name: "country MAINTENANCE → FEATURE_UNAVAILABLE", states: [state("country", "ML", "MAINTENANCE")], ctx: { features: ["money.transfer.mobilemoney"], countries: ["ML"] }, phase: "initiate", expect: { allowed: false, code: "FEATURE_UNAVAILABLE" } },
  { name: "currency READ_ONLY → READ_ONLY_MODE", states: [state("currency", "XOF", "READ_ONLY")], ctx: { features: ["money.deposit"], currencies: ["XOF"] }, phase: "initiate", expect: { allowed: false, code: "READ_ONLY_MODE" } },

  // MAINTENANCE, broad
  { name: "global MAINTENANCE refuses reads", states: [state("global", "all", "MAINTENANCE")], ctx: { features: [] }, phase: "read", expect: { allowed: false, code: "MAINTENANCE_ACTIVE" } },
  { name: "platform ios MAINTENANCE refuses ios", states: [state("platform", "ios", "MAINTENANCE")], ctx: { platform: "ios", features: [] }, phase: "read", expect: { allowed: false, code: "MAINTENANCE_ACTIVE" } },
  { name: "platform ios MAINTENANCE spares android", states: [state("platform", "ios", "MAINTENANCE")], ctx: { platform: "android", features: [] }, phase: "read", expect: { allowed: true } },
  { name: "platform rule ignored when platform unknown", states: [state("platform", "ios", "MAINTENANCE")], ctx: { features: ["money.withdraw"] }, phase: "initiate", expect: { allowed: true } },
  { name: "restore is never refused, even in global MAINTENANCE", states: [state("global", "all", "MAINTENANCE")], ctx: { features: ["money.withdraw"] }, phase: "restore", expect: { allowed: true } },

  // Precedence and message choice
  { name: "MAINTENANCE beats READ_ONLY", states: [state("global", "all", "READ_ONLY"), state("feature", "money.withdraw", "MAINTENANCE")], ctx: { features: ["money.withdraw"] }, phase: "confirm", expect: { allowed: false, code: "FEATURE_UNAVAILABLE", level: "MAINTENANCE" } },
  { name: "equal level: the feature rule speaks (more specific)", states: [state("global", "all", "MAINTENANCE"), state("feature", "money.withdraw", "MAINTENANCE")], ctx: { features: ["money.withdraw"] }, phase: "initiate", expect: { allowed: false, code: "FEATURE_UNAVAILABLE", ruleScope: "feature" } },

  // LOCKDOWN
  { name: "LOCKDOWN refuses every money initiate", states: [state("global", "all", "EMERGENCY_LOCKDOWN")], ctx: { features: ["money.deposit"] }, phase: "initiate", expect: { allowed: false, code: "SERVICE_LOCKDOWN" } },
  { name: "LOCKDOWN refuses money confirm", states: [state("global", "all", "EMERGENCY_LOCKDOWN")], ctx: { features: ["money.transfer.internal"] }, phase: "confirm", expect: { allowed: false, code: "SERVICE_LOCKDOWN" } },
  { name: "LOCKDOWN refuses adding a card", states: [state("global", "all", "EMERGENCY_LOCKDOWN")], ctx: { features: ["cards.add"] }, phase: "initiate", expect: { allowed: false, code: "SERVICE_LOCKDOWN" } },
  { name: "LOCKDOWN keeps reads", states: [state("global", "all", "EMERGENCY_LOCKDOWN")], ctx: { features: [] }, phase: "read", expect: { allowed: true } },
  { name: "LOCKDOWN keeps KYC", states: [state("global", "all", "EMERGENCY_LOCKDOWN")], ctx: { features: ["kyc.submit"] }, phase: "initiate", expect: { allowed: true } },
  { name: "LOCKDOWN lets a cancellation through", states: [state("global", "all", "EMERGENCY_LOCKDOWN")], ctx: { features: ["money.withdraw"] }, phase: "restore", expect: { allowed: true } },
  { name: "LOCKDOWN on a feature scope is ignored (global only)", states: [state("feature", "money.withdraw", "EMERGENCY_LOCKDOWN")], ctx: { features: ["money.withdraw"] }, phase: "initiate", expect: { allowed: true } },

  // Bypass and staff
  { name: "bypass passes MAINTENANCE", states: [state("global", "all", "MAINTENANCE")], ctx: { features: ["money.withdraw"] }, phase: "initiate", bypass: { expiresAt: NOW + H }, expect: { allowed: true } },
  { name: "expired bypass does not pass", states: [state("global", "all", "MAINTENANCE")], ctx: { features: ["money.withdraw"] }, phase: "initiate", bypass: { expiresAt: NOW - 1 }, expect: { allowed: false, code: "MAINTENANCE_ACTIVE" } },
  { name: "revoked bypass does not pass", states: [state("global", "all", "MAINTENANCE")], ctx: { features: ["money.withdraw"] }, phase: "initiate", bypass: { expiresAt: NOW + H, revokedAt: NOW - 1 }, expect: { allowed: false } },
  { name: "bypass does NOT pass LOCKDOWN", states: [state("global", "all", "EMERGENCY_LOCKDOWN")], ctx: { features: ["money.withdraw"] }, phase: "initiate", bypass: { expiresAt: NOW + H }, expect: { allowed: false, code: "SERVICE_LOCKDOWN" } },
  { name: "lockdown-enabled bypass passes LOCKDOWN", states: [state("global", "all", "EMERGENCY_LOCKDOWN")], ctx: { features: ["money.withdraw"] }, phase: "initiate", bypass: { expiresAt: NOW + H, allowLockdown: true }, expect: { allowed: true } },
  { name: "staff pass a non-money control (login)", states: [state("feature", "auth.login", "MAINTENANCE")], ctx: { features: ["auth.login"], isStaff: true }, phase: "initiate", expect: { allowed: true } },
  { name: "customers do not pass a login control", states: [state("feature", "auth.login", "MAINTENANCE")], ctx: { features: ["auth.login"] }, phase: "initiate", expect: { allowed: false, code: "FEATURE_UNAVAILABLE" } },
  { name: "staff get NO implicit money bypass", states: [state("feature", "money.withdraw", "MAINTENANCE")], ctx: { features: ["money.withdraw"], isStaff: true }, phase: "initiate", expect: { allowed: false } },

  // Unreadable state
  { name: "state unavailable: money initiate refused", states: [], controlStatus: "unavailable", ctx: { features: ["money.withdraw"] }, phase: "initiate", expect: { allowed: false, code: "SERVICE_STATUS_UNAVAILABLE" } },
  { name: "state unavailable: money confirm refused", states: [], controlStatus: "unavailable", ctx: { features: ["money.transfer.internal"] }, phase: "confirm", expect: { allowed: false, code: "SERVICE_STATUS_UNAVAILABLE" } },
  { name: "state unavailable: reads open", states: [], controlStatus: "unavailable", ctx: { features: [] }, phase: "read", expect: { allowed: true } },
  { name: "state unavailable: login open", states: [], controlStatus: "unavailable", ctx: { features: ["auth.login"] }, phase: "initiate", expect: { allowed: true } },
  { name: "state unavailable: cancellation open", states: [], controlStatus: "unavailable", ctx: { features: ["money.withdraw"] }, phase: "restore", expect: { allowed: true } },
  { name: "state unavailable + sticky LOCKDOWN stays LOCKDOWN", states: [state("global", "all", "EMERGENCY_LOCKDOWN")], controlStatus: "unavailable", sticky: true, ctx: { features: ["money.deposit"] }, phase: "initiate", expect: { allowed: false, code: "SERVICE_LOCKDOWN" } },
  { name: "state unavailable drops a non-lockdown rule (sticky = lockdown only)", states: [state("feature", "kyc.submit", "MAINTENANCE")], controlStatus: "unavailable", sticky: true, ctx: { features: ["kyc.submit"] }, phase: "initiate", expect: { allowed: true } },

  // Windows switch on and off by the clock
  { name: "active window applies", states: [], windows: [{ id: "w1", scopes: [{ scopeType: "feature", scopeKey: "money.withdraw" }], level: "MAINTENANCE", startsAt: NOW - H, endsAt: NOW + H }], ctx: { features: ["money.withdraw"] }, phase: "initiate", expect: { allowed: false, code: "FEATURE_UNAVAILABLE" } },
  { name: "future window does not apply yet", states: [], windows: [{ id: "w2", scopes: [{ scopeType: "global", scopeKey: "all" }], level: "MAINTENANCE", startsAt: NOW + H, endsAt: NOW + 2 * H }], ctx: { features: [] }, phase: "read", expect: { allowed: true } },
  { name: "ended window no longer applies", states: [], windows: [{ id: "w3", scopes: [{ scopeType: "global", scopeKey: "all" }], level: "MAINTENANCE", startsAt: NOW - 2 * H, endsAt: NOW }], ctx: { features: [] }, phase: "read", expect: { allowed: true } },
  { name: "cancelled window does not apply", states: [], windows: [{ id: "w4", scopes: [{ scopeType: "global", scopeKey: "all" }], level: "MAINTENANCE", startsAt: NOW - H, endsAt: NOW + H, cancelledAt: NOW - 1 }], ctx: { features: [] }, phase: "read", expect: { allowed: true } },
];

/** Money operation → features (Tx-Core vocabulary). */
const FEATURE_MAPPING = [
  { op: { funds: "paynoval", destination: "paynoval" }, expect: ["money.transfer.internal"] },
  { op: { funds: "mobilemoney", destination: "paynoval", txType: "DEPOSIT" }, expect: ["money.deposit"] },
  { op: { funds: "card", destination: "paynoval" }, expect: ["money.deposit"] },
  { op: { funds: "paynoval", destination: "mobilemoney", txType: "WITHDRAW" }, expect: ["money.withdraw"] },
  { op: { funds: "paynoval", destination: "mobilemoney", txType: "TRANSFER" }, expect: ["money.transfer.mobilemoney"] },
  { op: { funds: "paynoval", destination: "card", txType: "TRANSFER" }, expect: ["money.transfer.card"] },
  { op: { funds: "paynoval", destination: "card" }, expect: ["money.withdraw", "money.transfer.card"] },
  { op: {}, expect: ["money.deposit", "money.withdraw", "money.transfer.internal", "money.transfer.mobilemoney", "money.transfer.card"] },
];

/** App version gate. */
const VERSION_VECTORS = [
  { name: "no policy: nothing", policy: null, client: { version: "1.0.0" }, expect: { updateRequired: false, updateAvailable: false } },
  { name: "below minimum: required", policy: { minimumVersion: "1.4.0", storeUrl: "https://apps.apple.com/app/x" }, client: { version: "1.3.9" }, expect: { updateRequired: true, reason: "BELOW_MINIMUM" } },
  { name: "at minimum: fine", policy: { minimumVersion: "1.4.0" }, client: { version: "1.4.0" }, expect: { updateRequired: false } },
  { name: "unknown version: never blocked", policy: { minimumVersion: "9.0.0" }, client: {}, expect: { updateRequired: false } },
  { name: "unreadable version: never blocked", policy: { minimumVersion: "9.0.0" }, client: { version: "abc" }, expect: { updateRequired: false } },
  { name: "blocked version", policy: { blockedVersions: ["1.4.2"] }, client: { version: "1.4.2" }, expect: { updateRequired: true, reason: "VERSION_BLOCKED" } },
  { name: "blocked OTA update", policy: { blockedUpdateIds: ["0f8c2a3e-1b2c-4d5e-8f90-123456789abc"] }, client: { version: "2.0.0", updateId: "0F8C2A3E-1B2C-4D5E-8F90-123456789ABC" }, expect: { updateRequired: true, reason: "UPDATE_BLOCKED" } },
  { name: "embedded bundle never matches a blocked update", policy: { blockedUpdateIds: ["embedded"] }, client: { version: "2.0.0", updateId: "embedded" }, expect: { updateRequired: false } },
  { name: "below recommended: suggested only", policy: { recommendedVersion: "1.5.0" }, client: { version: "1.4.9" }, expect: { updateRequired: false, updateAvailable: true, reason: "BELOW_RECOMMENDED" } },
];

module.exports = { NOW, VECTORS, FEATURE_MAPPING, VERSION_VECTORS };
