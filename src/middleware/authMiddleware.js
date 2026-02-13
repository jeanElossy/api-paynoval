/**
 * src/middleware/authMiddleware.js
 *
 * Middleware 'protect' pour vérifier JWT (HS256 ou RS256 via JWKS).
 *
 * ✅ FIX CRITIQUE (MongoDB projection):
 * - On NE mélange PLUS inclusion + exclusion dans .select()
 *   (sinon: "Cannot do exclusion on field password in inclusion projection")
 *
 * ✅ Features conservées:
 * - Multi-audience: JWT_AUDIENCES="paynoval-api,paynoval-app,paynoval-mobile"
 * - Tolérance si token sans "aud" via JWT_ALLOW_MISSING_AUD=true
 * - RS256 via JWKS_URI (jwks-rsa) OU HS256 via JWT_SECRET
 *
 * ✅ Bonus (TX-core + Gateway):
 * - Support appels internes Gateway => x-internal-token + x-user-id
 *   (utile pour /api/v1/transactions list qui dépend de req.user.id)
 *
 * ✅ Attache req.user._id et req.user.id (compat).
 * - Ajoute les champs nécessaires à AML (kycLevel, isBusiness, securityQuestions, country, etc.)
 * - Logs debug sans fuite de token complet.
 */

"use strict";

/* Chargement .env en DEV uniquement (prod gère via plateforme) */
if (process.env.NODE_ENV !== "production") {
  try {
    require("dotenv-safe").config({ allowEmptyValues: true });
  } catch (e) {
    console.warn("[dotenv-safe] skipped in authMiddleware:", e.message);
  }
}

const jwt = require("jsonwebtoken");
const createError = require("http-errors");
const asyncHandler = require("express-async-handler");
const crypto = require("crypto");

const { getUsersConn } = require("../config/db");
const config = require("../config");
const User = require("../models/User")(getUsersConn());

const isProd = process.env.NODE_ENV === "production";
const hasJWKS = !!process.env.JWKS_URI;

/**
 * Config JWT
 */
let JWT_ISSUER = process.env.JWT_ISSUER || "";
let JWT_SECRET = process.env.JWT_SECRET || "";

const JWT_ALLOW_MISSING_AUD =
  String(process.env.JWT_ALLOW_MISSING_AUD || "").toLowerCase() === "true";

/**
 * ✅ Multi-audience
 */
function parseAudiences() {
  const csv = process.env.JWT_AUDIENCES || process.env.JWT_AUDIENCE || "";
  return String(csv)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
let JWT_AUDIENCES = parseAudiences();

// Defaults in DEV to avoid crash, but remain permissive
if (!isProd) {
  if (!JWT_SECRET) JWT_SECRET = "dev-secret-change-me";
  if (!JWT_ISSUER) JWT_ISSUER = "";
  if (!JWT_AUDIENCES.length) JWT_AUDIENCES = [];
}

if (isProd && !hasJWKS && !JWT_SECRET) {
  throw new Error("[auth] JWT_SECRET manquant en production (HS256).");
}

// JWKS setup (optional)
let jwksGetKey = null;
if (hasJWKS) {
  try {
    const jwksRsa = require("jwks-rsa");
    const jwksClient = jwksRsa({
      jwksUri: process.env.JWKS_URI,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 10 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });

    jwksGetKey = (header, cb) => {
      jwksClient.getSigningKey(header.kid, (err, key) => {
        if (err) return cb(err);
        try {
          const signingKey = key.getPublicKey();
          cb(null, signingKey);
        } catch (e) {
          cb(e);
        }
      });
    };

    console.info("[auth] JWKS configured (RS256)");
  } catch (e) {
    if (isProd) {
      throw new Error(
        "Module 'jwks-rsa' manquant ou JWKS_URI invalide. Installez la dépendance ou retirez JWKS_URI."
      );
    } else {
      console.warn(
        "[auth] jwks-rsa non installé / JWKS_URI unusable — fallback HS256 en DEV"
      );
      jwksGetKey = null;
    }
  }
}

// ---------- util helpers ----------
function extractBearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return null;
  const m = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const t = m[1].trim();
  if (!t || t.toLowerCase() === "null" || t.toLowerCase() === "undefined") return null;
  return t;
}

function looksLikeJwt(token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function base64UrlDecodeToJson(part) {
  try {
    const b64 = String(part)
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(part.length / 4) * 4, "=");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function verifyJwt(token, verifyOpts, algorithms) {
  if (jwksGetKey) {
    return await new Promise((resolve, reject) => {
      jwt.verify(token, jwksGetKey, { ...verifyOpts, algorithms }, (err, payload) => {
        if (err) return reject(err);
        resolve(payload);
      });
    });
  }
  return jwt.verify(token, JWT_SECRET, { ...verifyOpts, algorithms });
}

function buildVerifyOpts({ withAudience = true } = {}) {
  const opts = {
    clockTolerance: 5,
    ignoreExpiration: false,
  };
  if (JWT_ISSUER) opts.issuer = JWT_ISSUER;
  if (withAudience && JWT_AUDIENCES.length) {
    opts.audience = JWT_AUDIENCES; // array accepté
  }
  return opts;
}

async function verifyWithFallback(token) {
  const tokenHeader = base64UrlDecodeToJson(token.split(".")[0]) || null;
  const algos = jwksGetKey ? ["RS256"] : ["HS256"];

  try {
    const payload = await verifyJwt(token, buildVerifyOpts({ withAudience: true }), algos);
    return { payload, tokenHeader, usedFallback: false };
  } catch (err) {
    const msg = String(err?.message || "");
    const isAudError =
      err?.name === "JsonWebTokenError" &&
      (msg.includes("jwt audience invalid") || msg.includes("audience"));

    const decodedUnsafe = jwt.decode(token) || {};
    const hasAudClaim = !!decodedUnsafe?.aud;

    const canFallback =
      JWT_AUDIENCES.length &&
      (!isProd || (JWT_ALLOW_MISSING_AUD && !hasAudClaim));

    if (isAudError && canFallback) {
      const payload = await verifyJwt(token, buildVerifyOpts({ withAudience: false }), algos);
      return { payload, tokenHeader, usedFallback: true };
    }

    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* ✅ INTERNAL (Gateway) helpers                                        */
/* ------------------------------------------------------------------ */
function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || "").trim(), "utf8");
  const bb = Buffer.from(String(b || "").trim(), "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function getInternalHeaderToken(req) {
  const raw =
    req.headers["x-internal-token"] ||
    req.headers["x_internal_token"] ||
    req.headers["x-internal"] ||
    "";
  return Array.isArray(raw) ? raw[0] : raw;
}

function getUserIdHeader(req) {
  const raw =
    req.headers["x-user-id"] ||
    req.headers["x-userid"] ||
    req.headers["x-user_id"] ||
    "";
  return Array.isArray(raw) ? raw[0] : raw;
}

function getExpectedInternalToken() {
  // ordre : token gateway dédié > config.internalTokens.gateway > INTERNAL_TOKEN legacy
  const legacy = String(process.env.INTERNAL_TOKEN || config.internalToken || "").trim();
  const gw = String(
    process.env.GATEWAY_INTERNAL_TOKEN || config?.internalTokens?.gateway || legacy
  ).trim();
  return gw;
}

/**
 * ✅ PROJECTION SAFE
 * MongoDB interdit de mélanger inclusion + exclusion.
 *
 * Donc:
 * - On inclut tout par défaut, et on EXCLUT les secrets.
 * - Si tu veux limiter, fais un "inclusion only" sans "-password".
 */
const USER_SAFE_EXCLUDE = [
  "-password",
  "-twoFaSecret",
  "-otpSecret",
  "-mfaSecret",
  "-pin",
  "-securityCode",
  "-__v",
].join(" ");

// protect middleware
exports.protect = asyncHandler(async (req, _res, next) => {
  // 0) ✅ Autoriser les appels internes du Gateway
  const gotInternal = String(getInternalHeaderToken(req) || "").trim();
  const expectedInternal = getExpectedInternalToken();

  if (gotInternal && expectedInternal && timingSafeEqualStr(gotInternal, expectedInternal)) {
    const uid = String(getUserIdHeader(req) || "").trim();

    if (!uid) {
      // Gateway call sans user => autorisé mais pas de userId
      req.user = { _id: null, id: null, role: "gateway" };
      req.auth = { internal: true, scope: "gateway", tokenPreview: `${gotInternal.slice(0, 6)}...` };
      return next();
    }

    const user = await User.findById(uid)
      .select(USER_SAFE_EXCLUDE) // ✅ exclusion-only => pas d'erreur
      .lean();

    if (!user) {
      return next(createError(401, "Utilisateur non trouvé"));
    }

    req.user = {
      _id: String(user._id),
      id: String(user._id),

      email: user.email,
      role: user.role,
      fullName: user.fullName,

      // ✅ AML fields
      kycLevel: user.kycLevel,
      type: user.type,
      isBusiness: user.isBusiness,
      kybStatus: user.kybStatus,
      businessId: user.businessId,

      securityQuestions: Array.isArray(user.securityQuestions) ? user.securityQuestions : [],

      country: user.country,
      countryCode: user.countryCode,
      selectedCountry: user.selectedCountry,
    };

    req.auth = { internal: true, scope: "gateway", usedFallback: false };
    return next();
  }

  // 1) JWT classique
  const hdrAuth = req.get("Authorization") || req.get("authorization") || "";
  const token = extractBearerToken(hdrAuth);

  if (!token) {
    console.debug("[auth][protect] missing token header", {
      hasAuthorizationHeader: !!hdrAuth,
    });
    return next(createError(401, "Non autorisé : token manquant"));
  }

  if (!looksLikeJwt(token)) {
    console.warn("[auth][protect] token does not look like JWT (malformed)", {
      preview: token.slice(0, 12),
    });
    return next(createError(401, "Non autorisé : format de token invalide"));
  }

  let decoded;
  let usedFallback = false;

  try {
    const r = await verifyWithFallback(token);
    decoded = r.payload;
    usedFallback = !!r.usedFallback;
  } catch (err) {
    console.error("[auth][protect] jwt.verify failed", {
      name: err?.name,
      message: err?.message,
      tokenHeader: base64UrlDecodeToJson(token.split(".")[0]),
      issuerExpected: JWT_ISSUER || null,
      audiencesExpected: JWT_AUDIENCES.length ? JWT_AUDIENCES : null,
      allowMissingAud: JWT_ALLOW_MISSING_AUD,
      usingJWKS: !!jwksGetKey,
    });
    return next(createError(401, "Non autorisé : token invalide ou expiré"));
  }

  const userId = decoded?.sub || decoded?.id || decoded?.userId || decoded?._id || null;
  if (!userId) {
    console.warn("[auth][protect] token missing user identifier (sub/id)", {
      decodedKeys: Object.keys(decoded || {}),
    });
    return next(createError(401, "Non autorisé : jeton sans identifiant utilisateur"));
  }

  /**
   * ✅ IMPORTANT: NE PAS faire .select(["-password", "email", ...])
   * car c'est un mix exclusion + inclusion => ERREUR Mongo.
   *
   * On fait plutôt:
   * - exclusion-only des secrets, et on récupère aussi les champs AML
   * (c'est ok, car on ne limite pas les champs; on exclut seulement les secrets).
   */
  const user = await User.findById(userId)
    .select(USER_SAFE_EXCLUDE) // ✅ FIX CRITIQUE
    .lean();

  if (!user) {
    console.warn("[auth][protect] user not found for id from token", { userId: String(userId) });
    return next(createError(401, "Utilisateur non trouvé"));
  }

  req.user = {
    _id: String(user._id),
    id: String(user._id),

    email: user.email,
    role: user.role,
    fullName: user.fullName,

    // ✅ AML fields
    kycLevel: user.kycLevel,
    type: user.type,
    isBusiness: user.isBusiness,
    kybStatus: user.kybStatus,
    businessId: user.businessId,

    securityQuestions: Array.isArray(user.securityQuestions) ? user.securityQuestions : [],

    country: user.country,
    countryCode: user.countryCode,
    selectedCountry: user.selectedCountry,
  };

  req.auth = {
    tokenPreview: `${token.slice(0, 10)}...`,
    alg: base64UrlDecodeToJson(token.split(".")[0])?.alg || null,
    usedFallback,
    internal: false,
  };

  next();
});
