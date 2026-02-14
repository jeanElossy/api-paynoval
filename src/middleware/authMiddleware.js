/**
 * src/middleware/authMiddleware.js
 *
 * - protect: JWT (HS256 ou RS256 via JWKS)
 * - internalProtect: token interne (x-internal-token) pour routes /internal/*
 *
 * ✅ FIX CRITIQUE: projection Mongo => pas de mix inclusion/exclusion
 * ✅ Bonus: support appels internes (gateway/tx-core/principal) via x-internal-token + x-user-id
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
      console.warn("[auth] jwks-rsa non installé / JWKS_URI unusable — fallback HS256 en DEV");
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
    opts.audience = JWT_AUDIENCES;
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
/* ✅ INTERNAL helpers                                                  */
/* ------------------------------------------------------------------ */
function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || "").trim(), "utf8");
  const bb = Buffer.from(String(b || "").trim(), "utf8");
  if (!aa.length || !bb.length) return false;
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

/**
 * ✅ IMPORTANT: accepter plusieurs tokens internes
 * Tu peux mettre:
 * INTERNAL_TOKEN="token1,token2"
 */
function parseInternalTokens(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Détermine les tokens acceptés.
 * On inclut plusieurs variables pour compat (principal/gateway/tx-core).
 */
function getExpectedInternalTokens() {
  const candidates = [
    process.env.TX_CORE_INTERNAL_TOKEN,
    process.env.PRINCIPAL_INTERNAL_TOKEN,
    process.env.GATEWAY_INTERNAL_TOKEN,
    process.env.INTERNAL_TOKEN,
    config?.internalTokens?.txcore,
    config?.internalTokens?.principal,
    config?.internalTokens?.gateway,
    config?.internalToken,
  ].filter(Boolean);

  const merged = [];
  for (const c of candidates) merged.push(...parseInternalTokens(c));
  // unique
  return Array.from(new Set(merged));
}

function isValidInternalToken(got) {
  const expectedList = getExpectedInternalTokens();
  if (!got || !expectedList.length) return false;
  return expectedList.some((exp) => timingSafeEqualStr(got, exp));
}

/**
 * ✅ PROJECTION SAFE: exclusion-only
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

/**
 * ✅ internalProtect
 * - Vérifie x-internal-token
 * - Optionnel: charge user si x-user-id fourni
 */
exports.internalProtect = asyncHandler(async (req, _res, next) => {
  const gotInternal = String(getInternalHeaderToken(req) || "").trim();

  if (!isValidInternalToken(gotInternal)) {
    return next(createError(401, "Non autorisé : internal token invalide"));
  }

  const uid = String(getUserIdHeader(req) || "").trim();

  // si pas de user fourni, on autorise quand même
  if (!uid) {
    req.user = { _id: null, id: null, role: "internal" };
    req.auth = { internal: true, scope: "internal", tokenPreview: `${gotInternal.slice(0, 6)}...` };
    return next();
  }

  const user = await User.findById(uid).select(USER_SAFE_EXCLUDE).lean();
  if (!user) {
    return next(createError(401, "Utilisateur non trouvé"));
  }

  req.user = {
    _id: String(user._id),
    id: String(user._id),
    email: user.email,
    role: user.role,
    fullName: user.fullName,

    // AML fields
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

  req.auth = { internal: true, scope: "internal", usedFallback: false };
  return next();
});

/**
 * ✅ protect (JWT) + support appels internes gateway (x-internal-token + x-user-id)
 */
exports.protect = asyncHandler(async (req, _res, next) => {
  // 0) ✅ Autoriser les appels internes du Gateway / services internes
  const gotInternal = String(getInternalHeaderToken(req) || "").trim();

  if (gotInternal && isValidInternalToken(gotInternal)) {
    const uid = String(getUserIdHeader(req) || "").trim();

    if (!uid) {
      req.user = { _id: null, id: null, role: "gateway" };
      req.auth = { internal: true, scope: "gateway", tokenPreview: `${gotInternal.slice(0, 6)}...` };
      return next();
    }

    const user = await User.findById(uid).select(USER_SAFE_EXCLUDE).lean();
    if (!user) return next(createError(401, "Utilisateur non trouvé"));

    req.user = {
      _id: String(user._id),
      id: String(user._id),

      email: user.email,
      role: user.role,
      fullName: user.fullName,

      // AML fields
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
    return next(createError(401, "Non autorisé : token manquant"));
  }

  if (!looksLikeJwt(token)) {
    return next(createError(401, "Non autorisé : format de token invalide"));
  }

  let decoded;
  let usedFallback = false;

  try {
    const r = await verifyWithFallback(token);
    decoded = r.payload;
    usedFallback = !!r.usedFallback;
  } catch (_err) {
    return next(createError(401, "Non autorisé : token invalide ou expiré"));
  }

  const userId = decoded?.sub || decoded?.id || decoded?.userId || decoded?._id || null;
  if (!userId) {
    return next(createError(401, "Non autorisé : jeton sans identifiant utilisateur"));
  }

  const user = await User.findById(userId).select(USER_SAFE_EXCLUDE).lean();
  if (!user) {
    return next(createError(401, "Utilisateur non trouvé"));
  }

  req.user = {
    _id: String(user._id),
    id: String(user._id),

    email: user.email,
    role: user.role,
    fullName: user.fullName,

    // AML fields
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

  return next();
});
