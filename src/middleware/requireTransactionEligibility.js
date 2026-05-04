// // File: src/middleware/requireTransactionEligibility.js
// "use strict";

// const createError = require("http-errors");

// const runtime = require("../services/transactions/shared/runtime");

// const {
//   TX_ELIGIBILITY_USER_SELECT,
//   assertUserCanTransact,
//   buildEligibilitySnapshot,
//   mergeEligibilityMetadata,
// } = require("../services/transactions/shared/transactionEligibility");

// /**
//  * --------------------------------------------------------------------------
//  * TX-Core — Middleware d’éligibilité transactionnelle
//  * --------------------------------------------------------------------------
//  *
//  * Rôle :
//  * - dernière barrière côté tx-core
//  * - recharge TOUJOURS le profil frais depuis users-main
//  * - réhydrate req.user avec le profil frais pour les middlewares suivants
//  * - refuse initiate/confirm si :
//  *   - email non vérifié
//  *   - téléphone non vérifié
//  *   - KYC non validé pour compte personnel
//  *   - KYB non validé pour compte entreprise
//  *   - compte bloqué / gelé / suspendu / supprimé
//  *
//  * Important :
//  * - à utiliser sur /initiate et /confirm
//  * - ne pas utiliser sur /cancel, refund, auto-cancel, webhooks
//  * --------------------------------------------------------------------------
//  */

// function cleanString(value) {
//   return String(value ?? "").trim();
// }

// function cleanEmail(value) {
//   return cleanString(value).toLowerCase();
// }

// function getRequesterId(req) {
//   return cleanString(
//     req.user?._id ||
//       req.user?.id ||
//       req.user?.userId ||
//       req.auth?._id ||
//       req.auth?.id ||
//       req.auth?.userId ||
//       req.body?.userId ||
//       req.body?.meta?.userId ||
//       req.body?.metadata?.userId ||
//       ""
//   );
// }

// function getRequesterEmail(req) {
//   return cleanEmail(
//     req.user?.email ||
//       req.auth?.email ||
//       req.body?.senderEmail ||
//       req.body?.meta?.senderEmail ||
//       req.body?.metadata?.senderEmail ||
//       ""
//   );
// }

// function ensurePlainObject(value) {
//   return value && typeof value === "object" && !Array.isArray(value)
//     ? value
//     : {};
// }

// function getLogger() {
//   return runtime.logger || console;
// }

// function getUserSelectString() {
//   if (Array.isArray(TX_ELIGIBILITY_USER_SELECT)) {
//     return TX_ELIGIBILITY_USER_SELECT.join(" ");
//   }

//   return String(TX_ELIGIBILITY_USER_SELECT || "").trim();
// }

// function buildResponseError(err) {
//   const status = err.status || err.statusCode || 403;

//   return {
//     status,
//     body: {
//       success: false,
//       code: err.code || "TRANSACTION_ELIGIBILITY_FAILED",
//       error:
//         err.message ||
//         "Votre profil ne permet pas encore d’effectuer cette transaction.",
//       message:
//         err.message ||
//         "Votre profil ne permet pas encore d’effectuer cette transaction.",
//       details: Array.isArray(err.details) ? err.details : [],
//       requiresVerification: err.requiresVerification === true,
//     },
//   };
// }

// function buildDebugUserSnapshot(user = null) {
//   if (!user) return null;

//   return {
//     id: cleanString(user._id || user.id),
//     email: cleanEmail(user.email),
//     fullName: cleanString(user.fullName),

//     userType: cleanString(user.userType || user.type || user.accountType),
//     role: cleanString(user.role),
//     isBusiness: user.isBusiness === true,

//     emailVerified: user.emailVerified,
//     isEmailVerified: user.isEmailVerified,
//     emailVerifiedAt: user.emailVerifiedAt || null,
//     emailVerification: user.emailVerification || null,
//     emailVerificationNested:
//       user.verifications?.email?.verified ??
//       user.verifications?.email?.status ??
//       null,

//     phoneVerified: user.phoneVerified,
//     isPhoneVerified: user.isPhoneVerified,
//     phoneVerifiedAt: user.phoneVerifiedAt || null,
//     phoneVerification: user.phoneVerification || null,
//     phoneVerificationNested:
//       user.verifications?.phone?.verified ??
//       user.verifications?.phone?.status ??
//       null,

//     kycStatus: user.kycStatus,
//     kycLevel: user.kycLevel,
//     kycVerified: user.kycVerified,
//     isKycVerified: user.isKycVerified,

//     kybStatus: user.kybStatus,
//     businessStatus: user.businessStatus,
//     businessKYBLevel: user.businessKYBLevel,
//     kybVerified: user.kybVerified,
//     isKybVerified: user.isKybVerified,

//     accountStatus: user.accountStatus,
//     status: user.status,
//     staffStatus: user.staffStatus,

//     isBlocked: user.isBlocked,
//     blocked: user.blocked,
//     isLoginDisabled: user.isLoginDisabled,
//     hiddenFromTransfers: user.hiddenFromTransfers,
//     frozenUntil: user.frozenUntil || null,

//     isSystem: user.isSystem,
//     systemType: user.systemType,

//     isDeleted: user.isDeleted,
//     deletedAt: user.deletedAt || null,
//   };
// }

// function hydrateReqUserFromFreshProfile(req, user, snapshot) {
//   const userId = cleanString(user?._id || user?.id);

//   const hydrated = {
//     ...(ensurePlainObject(req.user) ? req.user : {}),

//     _id: user._id,
//     id: userId,
//     userId,

//     fullName: user.fullName || req.user?.fullName || "",
//     email: user.email || req.user?.email || "",
//     phone: user.phone || user.phoneNumber || req.user?.phone || "",

//     role: user.role || req.user?.role || "user",
//     userType: user.userType || user.type || user.accountType || req.user?.userType,
//     accountType: user.accountType || req.user?.accountType,
//     isBusiness: user.isBusiness === true,

//     accountStatus: user.accountStatus || user.status || "active",
//     status: user.status || user.accountStatus || "active",

//     emailVerified: snapshot.emailVerified === true,
//     isEmailVerified: snapshot.emailVerified === true,

//     phoneVerified: snapshot.phoneVerified === true,
//     isPhoneVerified: snapshot.phoneVerified === true,

//     kycStatus: user.kycStatus,
//     kycLevel: user.kycLevel,
//     kycVerified: snapshot.kycVerified === true,
//     isKycVerified: snapshot.kycVerified === true,

//     kybStatus: user.kybStatus,
//     businessStatus: user.businessStatus,
//     businessKYBLevel: user.businessKYBLevel,
//     kybVerified: snapshot.kybVerified === true,
//     isKybVerified: snapshot.kybVerified === true,

//     isBlocked: user.isBlocked === true,
//     blocked: user.blocked === true,
//     isLoginDisabled: user.isLoginDisabled === true,
//     hiddenFromTransfers: user.hiddenFromTransfers === true,

//     isSystem: user.isSystem === true,
//     systemType: user.systemType || null,

//     isDeleted: user.isDeleted === true,
//     deletedAt: user.deletedAt || null,
//   };

//   req.user = hydrated;

//   if (ensurePlainObject(req.auth)) {
//     req.auth = {
//       ...req.auth,
//       _id: user._id,
//       id: userId,
//       userId,
//       email: hydrated.email,
//       emailVerified: hydrated.emailVerified,
//       phoneVerified: hydrated.phoneVerified,
//       kycVerified: hydrated.kycVerified,
//       kybVerified: hydrated.kybVerified,
//       accountStatus: hydrated.accountStatus,
//     };
//   }
// }

// async function findFreshUser(req) {
//   const User = runtime.User;

//   if (!User) {
//     throw createError(
//       500,
//       "User model indisponible pour contrôle transactionnel."
//     );
//   }

//   const requesterId = getRequesterId(req);
//   const requesterEmail = getRequesterEmail(req);
//   const select = getUserSelectString();

//   if (!requesterId && !requesterEmail) {
//     const err = createError(401, "Utilisateur non authentifié.");
//     err.code = "USER_NOT_AUTHENTICATED";
//     err.requiresVerification = false;
//     throw err;
//   }

//   let user = null;

//   if (requesterId) {
//     user = await User.findById(requesterId).select(select).lean();
//   }

//   if (
//     user &&
//     requesterEmail &&
//     cleanEmail(user.email) &&
//     cleanEmail(user.email) !== requesterEmail
//   ) {
//     const emailUser = await User.findOne({
//       email: requesterEmail,
//       isDeleted: { $ne: true },
//     })
//       .select(select)
//       .lean();

//     if (emailUser) {
//       user = emailUser;
//     }
//   }

//   if (!user && requesterEmail) {
//     user = await User.findOne({
//       email: requesterEmail,
//       isDeleted: { $ne: true },
//     })
//       .select(select)
//       .lean();
//   }

//   if (!user) {
//     const err = createError(401, "Profil utilisateur introuvable.");
//     err.code = "USER_PROFILE_NOT_FOUND";
//     err.requiresVerification = true;
//     throw err;
//   }

//   return user;
// }

// module.exports = async function requireTransactionEligibility(req, res, next) {
//   const logger = getLogger();

//   try {
//     const user = await findFreshUser(req);
//     const snapshot = buildEligibilitySnapshot(user);

//     try {
//       logger.info?.("[TX ELIGIBILITY] fresh user loaded", {
//         userId: cleanString(user?._id || user?.id),
//         email: cleanEmail(user?.email),
//         path: req.originalUrl || req.url,
//         method: req.method,
//         eligibilitySnapshot: snapshot,
//         rawUserFlags: buildDebugUserSnapshot(user),
//       });
//     } catch {}

//     const result = assertUserCanTransact(user, {
//       roleLabel: "utilisateur",
//       codePrefix: "USER",
//     });

//     const requesterSnapshot = result.snapshot || snapshot;

//     hydrateReqUserFromFreshProfile(req, user, requesterSnapshot);

//     req.transactionEligibility = {
//       ok: true,
//       checkedAt: new Date().toISOString(),
//       user: requesterSnapshot,
//     };

//     req.verifiedUserProfile = user;

//     const body = ensurePlainObject(req.body);

//     body.metadata = mergeEligibilityMetadata(body.metadata, {
//       requester: requesterSnapshot,
//     });

//     body.meta = mergeEligibilityMetadata(body.meta, {
//       requester: requesterSnapshot,
//     });

//     req.body = body;

//     try {
//       logger.info?.("[TX ELIGIBILITY] req.user hydrated", {
//         userId: req.user?.id || req.user?._id || null,
//         email: req.user?.email || null,
//         emailVerified: req.user?.emailVerified,
//         phoneVerified: req.user?.phoneVerified,
//         kycVerified: req.user?.kycVerified,
//         kybVerified: req.user?.kybVerified,
//         path: req.originalUrl || req.url,
//       });
//     } catch {}

//     return next();
//   } catch (err) {
//     try {
//       logger.warn?.("[TX ELIGIBILITY] transaction blocked", {
//         code: err.code || "TRANSACTION_ELIGIBILITY_FAILED",
//         status: err.status || err.statusCode || 403,
//         message: err.message,
//         details: Array.isArray(err.details) ? err.details : [],
//         userId: getRequesterId(req) || null,
//         email: getRequesterEmail(req) || null,
//         path: req.originalUrl || req.url,
//         method: req.method,
//       });
//     } catch {}

//     const { status, body } = buildResponseError(err);

//     return res.status(status).json(body);
//   }
// };






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

const {
  isAppleReviewUserId,
  isAppleReviewEmail,
} = require("../utils/sandboxUser");

/**
 * --------------------------------------------------------------------------
 * TX-Core — Middleware d’éligibilité transactionnelle
 * --------------------------------------------------------------------------
 *
 * Rôle :
 * - dernière barrière côté tx-core
 * - recharge TOUJOURS le profil frais depuis users-main
 * - réhydrate req.user avec le profil frais pour les middlewares suivants
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

const SANDBOX_SELECT_FIELDS = [
  "isSandbox",
  "isReviewerAccount",
  "sandboxReason",
  "sandboxCreatedAt",
  "sandboxDisabledAt",
  "currency",
  "currencyCode",
  "defaultCurrency",
  "country",
  "countryCode",
];

function cleanString(value) {
  return String(value ?? "").trim();
}

function cleanEmail(value) {
  return cleanString(value).toLowerCase();
}

function getRequesterId(req) {
  return cleanString(
    req.user?._id ||
      req.user?.id ||
      req.user?.userId ||
      req.auth?._id ||
      req.auth?.id ||
      req.auth?.userId ||
      req.body?.userId ||
      req.body?.meta?.userId ||
      req.body?.metadata?.userId ||
      ""
  );
}

function getRequesterEmail(req) {
  return cleanEmail(
    req.user?.email ||
      req.auth?.email ||
      req.body?.senderEmail ||
      req.body?.meta?.senderEmail ||
      req.body?.metadata?.senderEmail ||
      ""
  );
}

function ensurePlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function getLogger() {
  return runtime.logger || console;
}

function uniqueWords(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split(/\s+/)
        .map((v) => v.trim())
        .filter(Boolean)
    )
  ).join(" ");
}

function getUserSelectString() {
  const base = Array.isArray(TX_ELIGIBILITY_USER_SELECT)
    ? TX_ELIGIBILITY_USER_SELECT.join(" ")
    : String(TX_ELIGIBILITY_USER_SELECT || "").trim();

  return uniqueWords(`${base} ${SANDBOX_SELECT_FIELDS.join(" ")}`);
}

function isAppleReviewerProfile(user = {}) {
  return (
    isAppleReviewUserId(user?._id || user?.id || user?.userId) ||
    isAppleReviewEmail(user?.email)
  );
}

function resolveSandboxFlags(user = {}) {
  const isAppleReviewer = isAppleReviewerProfile(user);

  const disabled =
    user?.sandboxDisabledAt instanceof Date ||
    Boolean(user?.sandboxDisabledAt);

  const isSandbox =
    disabled === false &&
    (user?.isSandbox === true ||
      user?.isReviewerAccount === true ||
      isAppleReviewer);

  const isReviewerAccount =
    disabled === false &&
    (user?.isReviewerAccount === true || isAppleReviewer);

  return {
    isSandbox,
    isReviewerAccount,
    sandboxReason:
      user?.sandboxReason ||
      (isAppleReviewer ? "Apple App Review" : null),
    sandboxCreatedAt: user?.sandboxCreatedAt || null,
    sandboxDisabledAt: user?.sandboxDisabledAt || null,
  };
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

function buildDebugUserSnapshot(user = null) {
  if (!user) return null;

  const sandbox = resolveSandboxFlags(user);

  return {
    id: cleanString(user._id || user.id),
    email: cleanEmail(user.email),
    fullName: cleanString(user.fullName),

    userType: cleanString(user.userType || user.type || user.accountType),
    role: cleanString(user.role),
    isBusiness: user.isBusiness === true,

    country: user.country || user.countryCode || null,
    currency: user.currency || user.currencyCode || user.defaultCurrency || null,

    isSandbox: sandbox.isSandbox,
    isReviewerAccount: sandbox.isReviewerAccount,
    sandboxReason: sandbox.sandboxReason,
    sandboxCreatedAt: sandbox.sandboxCreatedAt,
    sandboxDisabledAt: sandbox.sandboxDisabledAt,

    emailVerified: user.emailVerified,
    isEmailVerified: user.isEmailVerified,
    emailVerifiedAt: user.emailVerifiedAt || null,
    emailVerification: user.emailVerification || null,
    emailVerificationNested:
      user.verifications?.email?.verified ??
      user.verifications?.email?.status ??
      null,

    phoneVerified: user.phoneVerified,
    isPhoneVerified: user.isPhoneVerified,
    phoneVerifiedAt: user.phoneVerifiedAt || null,
    phoneVerification: user.phoneVerification || null,
    phoneVerificationNested:
      user.verifications?.phone?.verified ??
      user.verifications?.phone?.status ??
      null,

    kycStatus: user.kycStatus,
    kycLevel: user.kycLevel,
    kycVerified: user.kycVerified,
    isKycVerified: user.isKycVerified,

    kybStatus: user.kybStatus,
    businessStatus: user.businessStatus,
    businessKYBLevel: user.businessKYBLevel,
    kybVerified: user.kybVerified,
    isKybVerified: user.isKybVerified,

    accountStatus: user.accountStatus,
    status: user.status,
    staffStatus: user.staffStatus,

    isBlocked: user.isBlocked,
    blocked: user.blocked,
    isLoginDisabled: user.isLoginDisabled,
    hiddenFromTransfers: user.hiddenFromTransfers,
    frozenUntil: user.frozenUntil || null,

    isSystem: user.isSystem,
    systemType: user.systemType,

    isDeleted: user.isDeleted,
    deletedAt: user.deletedAt || null,
  };
}

function hydrateReqUserFromFreshProfile(req, user, snapshot) {
  const userId = cleanString(user?._id || user?.id);
  const sandbox = resolveSandboxFlags(user);

  const hydrated = {
    ...(ensurePlainObject(req.user) ? req.user : {}),

    _id: user._id,
    id: userId,
    userId,

    fullName: user.fullName || req.user?.fullName || "",
    email: user.email || req.user?.email || "",
    phone: user.phone || user.phoneNumber || req.user?.phone || "",

    country:
      user.country ||
      user.selectedCountry ||
      user.registrationCountry ||
      user.residenceCountry ||
      req.user?.country ||
      "",

    countryCode: user.countryCode || req.user?.countryCode || "",

    currency:
      user.currency ||
      user.currencyCode ||
      user.defaultCurrency ||
      user.wallet?.currency ||
      req.user?.currency ||
      "",

    currencyCode:
      user.currencyCode ||
      user.currency ||
      user.defaultCurrency ||
      req.user?.currencyCode ||
      "",

    role: user.role || req.user?.role || "user",
    userType:
      user.userType || user.type || user.accountType || req.user?.userType,
    accountType: user.accountType || req.user?.accountType,
    isBusiness: user.isBusiness === true,

    accountStatus: user.accountStatus || user.status || "active",
    status: user.status || user.accountStatus || "active",

    emailVerified: snapshot.emailVerified === true,
    isEmailVerified: snapshot.emailVerified === true,

    phoneVerified: snapshot.phoneVerified === true,
    isPhoneVerified: snapshot.phoneVerified === true,

    kycStatus: user.kycStatus,
    kycLevel: user.kycLevel,
    kycVerified: snapshot.kycVerified === true,
    isKycVerified: snapshot.kycVerified === true,

    kybStatus: user.kybStatus,
    businessStatus: user.businessStatus,
    businessKYBLevel: user.businessKYBLevel,
    kybVerified: snapshot.kybVerified === true,
    isKybVerified: snapshot.kybVerified === true,

    isBlocked: user.isBlocked === true,
    blocked: user.blocked === true,
    isLoginDisabled: user.isLoginDisabled === true,
    hiddenFromTransfers: user.hiddenFromTransfers === true,

    isSystem: user.isSystem === true,
    systemType: user.systemType || null,

    isDeleted: user.isDeleted === true,
    deletedAt: user.deletedAt || null,

    isSandbox: sandbox.isSandbox,
    isReviewerAccount: sandbox.isReviewerAccount,
    sandboxReason: sandbox.sandboxReason,
    sandboxCreatedAt: sandbox.sandboxCreatedAt,
    sandboxDisabledAt: sandbox.sandboxDisabledAt,
  };

  req.user = hydrated;

  if (ensurePlainObject(req.auth)) {
    req.auth = {
      ...req.auth,
      _id: user._id,
      id: userId,
      userId,
      email: hydrated.email,
      phone: hydrated.phone,
      country: hydrated.country,
      currency: hydrated.currency,
      emailVerified: hydrated.emailVerified,
      phoneVerified: hydrated.phoneVerified,
      kycVerified: hydrated.kycVerified,
      kybVerified: hydrated.kybVerified,
      accountStatus: hydrated.accountStatus,
      isSandbox: hydrated.isSandbox,
      isReviewerAccount: hydrated.isReviewerAccount,
      sandboxReason: hydrated.sandboxReason,
    };
  }
}

async function findFreshUser(req) {
  const User = runtime.User;

  if (!User) {
    throw createError(
      500,
      "User model indisponible pour contrôle transactionnel."
    );
  }

  const requesterId = getRequesterId(req);
  const requesterEmail = getRequesterEmail(req);
  const select = getUserSelectString();

  if (!requesterId && !requesterEmail) {
    const err = createError(401, "Utilisateur non authentifié.");
    err.code = "USER_NOT_AUTHENTICATED";
    err.requiresVerification = false;
    throw err;
  }

  let user = null;

  if (requesterId) {
    user = await User.findById(requesterId).select(select).lean();
  }

  if (
    user &&
    requesterEmail &&
    cleanEmail(user.email) &&
    cleanEmail(user.email) !== requesterEmail
  ) {
    const emailUser = await User.findOne({
      email: requesterEmail,
      isDeleted: { $ne: true },
    })
      .select(select)
      .lean();

    if (emailUser) {
      user = emailUser;
    }
  }

  if (!user && requesterEmail) {
    user = await User.findOne({
      email: requesterEmail,
      isDeleted: { $ne: true },
    })
      .select(select)
      .lean();
  }

  if (!user) {
    const err = createError(401, "Profil utilisateur introuvable.");
    err.code = "USER_PROFILE_NOT_FOUND";
    err.requiresVerification = true;
    throw err;
  }

  return user;
}

module.exports = async function requireTransactionEligibility(req, res, next) {
  const logger = getLogger();

  try {
    const user = await findFreshUser(req);
    const snapshot = buildEligibilitySnapshot(user);

    try {
      logger.info?.("[TX ELIGIBILITY] fresh user loaded", {
        userId: cleanString(user?._id || user?.id),
        email: cleanEmail(user?.email),
        path: req.originalUrl || req.url,
        method: req.method,
        eligibilitySnapshot: snapshot,
        rawUserFlags: buildDebugUserSnapshot(user),
      });
    } catch {}

    const result = assertUserCanTransact(user, {
      roleLabel: "utilisateur",
      codePrefix: "USER",
    });

    const requesterSnapshot = result.snapshot || snapshot;
    const sandbox = resolveSandboxFlags(user);

    hydrateReqUserFromFreshProfile(req, user, requesterSnapshot);

    req.transactionEligibility = {
      ok: true,
      checkedAt: new Date().toISOString(),
      user: {
        ...requesterSnapshot,
        isSandbox: sandbox.isSandbox,
        isReviewerAccount: sandbox.isReviewerAccount,
        sandboxReason: sandbox.sandboxReason,
      },
    };

    req.verifiedUserProfile = {
      ...user,
      isSandbox: sandbox.isSandbox,
      isReviewerAccount: sandbox.isReviewerAccount,
      sandboxReason: sandbox.sandboxReason,
    };

    const body = ensurePlainObject(req.body);

    body.metadata = mergeEligibilityMetadata(body.metadata, {
      requester: req.transactionEligibility.user,
    });

    body.meta = mergeEligibilityMetadata(body.meta, {
      requester: req.transactionEligibility.user,
    });

    req.body = body;

    try {
      logger.info?.("[TX ELIGIBILITY] req.user hydrated", {
        userId: req.user?.id || req.user?._id || null,
        email: req.user?.email || null,
        emailVerified: req.user?.emailVerified,
        phoneVerified: req.user?.phoneVerified,
        kycVerified: req.user?.kycVerified,
        kybVerified: req.user?.kybVerified,
        isSandbox: req.user?.isSandbox === true,
        isReviewerAccount: req.user?.isReviewerAccount === true,
        sandboxReason: req.user?.sandboxReason || null,
        path: req.originalUrl || req.url,
      });
    } catch {}

    return next();
  } catch (err) {
    try {
      logger.warn?.("[TX ELIGIBILITY] transaction blocked", {
        code: err.code || "TRANSACTION_ELIGIBILITY_FAILED",
        status: err.status || err.statusCode || 403,
        message: err.message,
        details: Array.isArray(err.details) ? err.details : [],
        userId: getRequesterId(req) || null,
        email: getRequesterEmail(req) || null,
        path: req.originalUrl || req.url,
        method: req.method,
      });
    } catch {}

    const { status, body } = buildResponseError(err);

    return res.status(status).json(body);
  }
};