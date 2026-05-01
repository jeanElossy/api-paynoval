// File: src/services/transactions/shared/transactionEligibility.js
"use strict";

const createError = require("http-errors");

/**
 * --------------------------------------------------------------------------
 * PayNoval TX-Core — Transaction Eligibility
 * --------------------------------------------------------------------------
 *
 * Rôle :
 * - dernière barrière côté tx-core avant création/confirmation transaction
 * - bloque si email/téléphone/KYC/KYB/compte ne sont pas conformes
 * - génère un snapshot propre pour metadata/meta
 *
 * Important :
 * - le backend principal reste la source officielle du profil
 * - le gateway vérifie déjà le profil frais
 * - tx-core vérifie à nouveau depuis la DB users-main pour empêcher
 *   un contournement direct
 * --------------------------------------------------------------------------
 */

const TX_ELIGIBILITY_USER_SELECT = [
  "_id",
  "fullName",
  "email",
  "phone",
  "phoneNumber",

  "emailVerified",
  "isEmailVerified",
  "emailVerifiedAt",
  "emailVerification",
  "verifications",

  "phoneVerified",
  "isPhoneVerified",
  "phoneVerifiedAt",
  "phoneVerification",

  "userType",
  "type",
  "accountType",
  "role",
  "isBusiness",

  "accountStatus",
  "status",
  "staffStatus",
  "isBlocked",
  "blocked",
  "isLoginDisabled",
  "hiddenFromTransfers",
  "frozenUntil",

  "kycStatus",
  "kycLevel",
  "kyc",
  "profile",
  "kycVerified",
  "isKycVerified",

  "kybStatus",
  "businessStatus",
  "businessKYBLevel",
  "business",
  "kyb",
  "kybVerified",
  "isKybVerified",

  "isSystem",
  "systemType",
  "isDeleted",
  "deletedAt",
];

function safeString(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function low(value) {
  return safeString(value).toLowerCase();
}

function normalizeStatus(value) {
  return low(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_");
}

function isPositiveFlag(value) {
  if (value === true) return true;

  if (value instanceof Date) {
    return Number.isFinite(value.getTime());
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0;
  }

  const text = low(value);
  if (!text) return false;

  return [
    "true",
    "yes",
    "oui",
    "verified",
    "verifie",
    "vérifié",
    "validated",
    "valide",
    "validé",
    "approved",
    "complete",
    "completed",
    "success",
    "ok",
    "active",
  ].includes(text);
}

function isApprovedStatus(value) {
  const status = normalizeStatus(value);

  return [
    "approved",
    "validated",
    "valide",
    "verified",
    "verifie",
    "complete",
    "completed",
    "success",
    "accepted",
    "active",
  ].includes(status);
}

function isBlockedStatus(value) {
  const status = normalizeStatus(value);

  return [
    "blocked",
    "bloque",
    "frozen",
    "gele",
    "gelé",
    "suspended",
    "suspendu",
    "disabled",
    "disable",
    "deleted",
    "supprime",
    "banned",
    "closed",
    "inactive",
    "rejected",
    "denied",
  ].includes(status);
}

function isPendingStatus(value) {
  return normalizeStatus(value) === "pending";
}

function isBusinessUser(user = {}) {
  const userType = normalizeStatus(
    user.userType || user.type || user.accountType || user.profile?.userType
  );

  const role = normalizeStatus(user.role);

  return (
    user.isBusiness === true ||
    userType === "entreprise" ||
    userType === "business" ||
    userType === "company" ||
    userType === "merchant" ||
    role === "business"
  );
}

function isEmailVerified(user = {}) {
  return (
    isPositiveFlag(user.emailVerified) ||
    isPositiveFlag(user.isEmailVerified) ||
    isPositiveFlag(user.emailVerifiedAt) ||
    isPositiveFlag(user.emailVerification?.verified) ||
    isPositiveFlag(user.emailVerification?.status) ||
    isPositiveFlag(user.verifications?.email?.verified) ||
    isPositiveFlag(user.verifications?.email?.status) ||
    isPositiveFlag(user.profile?.emailVerified) ||
    isPositiveFlag(user.profile?.emailVerifiedAt)
  );
}

function isPhoneVerified(user = {}) {
  return (
    isPositiveFlag(user.phoneVerified) ||
    isPositiveFlag(user.isPhoneVerified) ||
    isPositiveFlag(user.phoneVerifiedAt) ||
    isPositiveFlag(user.phoneVerification?.verified) ||
    isPositiveFlag(user.phoneVerification?.status) ||
    isPositiveFlag(user.verifications?.phone?.verified) ||
    isPositiveFlag(user.verifications?.phone?.status) ||
    isPositiveFlag(user.profile?.phoneVerified) ||
    isPositiveFlag(user.profile?.phoneVerifiedAt)
  );
}

function isKycVerified(user = {}) {
  const level = Number(user.kycLevel || user.profile?.kycLevel || 0);

  return (
    level >= 2 ||
    isApprovedStatus(user.kycStatus) ||
    isApprovedStatus(user.kyc?.status) ||
    isApprovedStatus(user.kyc?.verificationStatus) ||
    isApprovedStatus(user.verifications?.kyc?.status) ||
    isPositiveFlag(user.kycVerified) ||
    isPositiveFlag(user.isKycVerified)
  );
}

function isKybVerified(user = {}) {
  const businessLevel = Number(
    user.businessKYBLevel ||
      user.business?.businessKYBLevel ||
      user.kybLevel ||
      0
  );

  return (
    businessLevel >= 2 ||
    isApprovedStatus(user.kybStatus) ||
    isApprovedStatus(user.businessStatus) ||
    isApprovedStatus(user.kyb?.status) ||
    isApprovedStatus(user.kyb?.verificationStatus) ||
    isApprovedStatus(user.business?.kybStatus) ||
    isApprovedStatus(user.business?.businessStatus) ||
    isApprovedStatus(user.verifications?.kyb?.status) ||
    isPositiveFlag(user.kybVerified) ||
    isPositiveFlag(user.isKybVerified)
  );
}

function isFrozenNow(user = {}) {
  if (!user.frozenUntil) return false;

  const d = new Date(user.frozenUntil);
  if (!Number.isFinite(d.getTime())) return false;

  return d > new Date();
}

function isAccountBlocked(user = {}) {
  return (
    user.isBlocked === true ||
    user.blocked === true ||
    user.isLoginDisabled === true ||
    user.isDeleted === true ||
    !!user.deletedAt ||
    user.hiddenFromTransfers === true ||
    isFrozenNow(user) ||
    isBlockedStatus(user.status) ||
    isBlockedStatus(user.accountStatus) ||
    isBlockedStatus(user.staffStatus)
  );
}

function buildEligibilityFailures(user = {}) {
  const failures = [];

  if (!user || typeof user !== "object" || !user._id) {
    failures.push({
      code: "USER_PROFILE_NOT_FOUND",
      status: 401,
      message: "Profil utilisateur introuvable.",
    });

    return failures;
  }

  if (user.isSystem === true || user.systemType) {
    failures.push({
      code: "SYSTEM_ACCOUNT_NOT_ALLOWED",
      status: 403,
      message:
        "Les comptes système ne peuvent pas initier de transaction utilisateur.",
    });
  }

  if (isAccountBlocked(user)) {
    failures.push({
      code: "ACCOUNT_BLOCKED",
      status: 403,
      message:
        "Votre compte est bloqué, gelé, suspendu ou inactif. Les transactions sont indisponibles.",
    });
  }

  if (isPendingStatus(user.accountStatus)) {
    failures.push({
      code: "ACCOUNT_PENDING",
      status: 403,
      message:
        "Votre compte est en attente de validation. Les transactions seront disponibles après activation complète.",
    });
  }

  if (!isEmailVerified(user)) {
    failures.push({
      code: "EMAIL_NOT_VERIFIED",
      status: 428,
      message:
        "Veuillez vérifier votre adresse email avant d’effectuer une transaction.",
    });
  }

  if (!isPhoneVerified(user)) {
    failures.push({
      code: "PHONE_NOT_VERIFIED",
      status: 428,
      message:
        "Veuillez vérifier votre numéro de téléphone avant d’effectuer une transaction.",
    });
  }

  if (isBusinessUser(user)) {
    if (!isKybVerified(user)) {
      failures.push({
        code: "KYB_REQUIRED",
        status: 428,
        message:
          "Votre vérification d’entreprise KYB doit être validée avant d’effectuer une transaction.",
      });
    }
  } else if (!isKycVerified(user)) {
    failures.push({
      code: "KYC_REQUIRED",
      status: 428,
      message:
        "Votre vérification d’identité KYC doit être validée avant d’effectuer une transaction.",
    });
  }

  return failures;
}

function buildEligibilitySnapshot(user = {}) {
  const isBusiness = isBusinessUser(user);

  return {
    checkedAt: new Date().toISOString(),
    source: "tx-core-db",
    userId: safeString(user._id || user.id),
    email: safeString(user.email),
    phone: safeString(user.phone || user.phoneNumber),
    emailVerified: isEmailVerified(user),
    phoneVerified: isPhoneVerified(user),
    isBusiness,
    kycVerified: isBusiness ? false : isKycVerified(user),
    kybVerified: isBusiness ? isKybVerified(user) : false,
    accountStatus: safeString(user.accountStatus || user.status || "unknown"),
    blocked: isAccountBlocked(user),
  };
}

function assertUserCanTransact(user = {}, options = {}) {
  const roleLabel = options.roleLabel || "utilisateur";
  const failures = buildEligibilityFailures(user);

  if (!failures.length) {
    return {
      ok: true,
      snapshot: buildEligibilitySnapshot(user),
    };
  }

  const first = failures[0];

  const err = createError(
    first.status || 403,
    `${roleLabel}: ${first.message}`
  );

  err.code = first.code;
  err.details = failures;
  err.requiresVerification = true;

  throw err;
}

function ensurePlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function mergeEligibilityMetadata(base = {}, payload = {}) {
  const cleanBase = ensurePlainObject(base);

  return {
    ...cleanBase,
    transactionEligibility: {
      ...ensurePlainObject(cleanBase.transactionEligibility),
      ...ensurePlainObject(payload),
      source: "tx-core",
      checkedAt: new Date().toISOString(),
    },
  };
}

module.exports = {
  TX_ELIGIBILITY_USER_SELECT,
  assertUserCanTransact,
  buildEligibilityFailures,
  buildEligibilitySnapshot,
  mergeEligibilityMetadata,
  isBusinessUser,
  isEmailVerified,
  isPhoneVerified,
  isKycVerified,
  isKybVerified,
  isAccountBlocked,
};