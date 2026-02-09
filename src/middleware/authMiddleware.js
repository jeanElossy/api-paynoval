// /**
//  * src/middleware/authMiddleware.js
//  *
//  * Middleware 'protect' pour vérifier JWT (HS256 ou RS256 via JWKS).
//  *
//  * ✅ FIX IMPORTANT (2025-12):
//  * - Support multi-audience : JWT_AUDIENCES="paynoval-api,paynoval-app,paynoval-mobile"
//  * - Tolérance contrôlée si le token n'a pas de claim "aud" (migration) via JWT_ALLOW_MISSING_AUD=true
//  *
//  * - Attache req.user._id et req.user.id (compatibilité avec le reste des services).
//  * - Log des erreurs de vérification pour faciliter le débogage (sans exposer le token complet).
//  * - En DEV, tolérance accrue si issuer/audience non fournis.
//  */

// /* Chargement .env en DEV uniquement (prod gère via plateforme) */
// if (process.env.NODE_ENV !== 'production') {
//   try {
//     require('dotenv-safe').config({ allowEmptyValues: true });
//   } catch (e) {
//     console.warn('[dotenv-safe] skipped in authMiddleware:', e.message);
//   }
// }

// 'use strict';

// const jwt = require('jsonwebtoken');
// const createError = require('http-errors');
// const asyncHandler = require('express-async-handler');

// const { getUsersConn } = require('../config/db');
// const User = require('../models/User')(getUsersConn());

// const isProd = process.env.NODE_ENV === 'production';
// const hasJWKS = !!process.env.JWKS_URI;

// /**
//  * Config JWT
//  * - JWT_ISSUER : issuer attendu (optionnel)
//  * - JWT_AUDIENCE : legacy (une valeur)
//  * - JWT_AUDIENCES : recommandé (liste CSV)
//  * - JWT_ALLOW_MISSING_AUD : tolère token sans "aud" (migration)
//  */
// let JWT_ISSUER = process.env.JWT_ISSUER || '';
// let JWT_SECRET = process.env.JWT_SECRET || '';

// const JWT_ALLOW_MISSING_AUD =
//   String(process.env.JWT_ALLOW_MISSING_AUD || '').toLowerCase() === 'true';

// /**
//  * ✅ Multi-audience
//  * - Priorité: JWT_AUDIENCES (CSV)
//  * - Fallback: JWT_AUDIENCE (single)
//  */
// function parseAudiences() {
//   const csv = process.env.JWT_AUDIENCES || process.env.JWT_AUDIENCE || '';
//   return String(csv)
//     .split(',')
//     .map((s) => s.trim())
//     .filter(Boolean);
// }
// let JWT_AUDIENCES = parseAudiences();

// // Defaults in DEV to avoid crash, but remain permissive
// if (!isProd) {
//   if (!JWT_SECRET) JWT_SECRET = 'dev-secret-change-me';
//   if (!JWT_ISSUER) JWT_ISSUER = '';
//   // En DEV, si non fourni, on laisse vide (pas de contrôle audience)
//   if (!JWT_AUDIENCES.length) JWT_AUDIENCES = [];
// }

// /**
//  * En PROD:
//  * - Si pas de JWKS, il faut un JWT_SECRET.
//  * - Si JWKS présent, JWT_SECRET peut être vide (RS256).
//  */
// if (isProd && !hasJWKS && !JWT_SECRET) {
//   throw new Error('[auth] JWT_SECRET manquant en production (HS256).');
// }

// // JWKS setup (optional)
// let jwksGetKey = null;
// if (hasJWKS) {
//   try {
//     const jwksRsa = require('jwks-rsa');
//     const jwksClient = jwksRsa({
//       jwksUri: process.env.JWKS_URI,
//       cache: true,
//       cacheMaxEntries: 5,
//       cacheMaxAge: 10 * 60 * 1000,
//       rateLimit: true,
//       jwksRequestsPerMinute: 10,
//     });

//     jwksGetKey = (header, cb) => {
//       jwksClient.getSigningKey(header.kid, (err, key) => {
//         if (err) return cb(err);
//         try {
//           const signingKey = key.getPublicKey();
//           cb(null, signingKey);
//         } catch (e) {
//           cb(e);
//         }
//       });
//     };

//     console.info('[auth] JWKS configured (RS256)');
//   } catch (e) {
//     // En prod, échouer si la config est mal installée
//     if (isProd) {
//       throw new Error(
//         "Module 'jwks-rsa' manquant ou JWKS_URI invalide. Installez la dépendance ou retirez JWKS_URI."
//       );
//     } else {
//       console.warn(
//         "[auth] jwks-rsa non installé / JWKS_URI unusable — fallback HS256 en DEV"
//       );
//       jwksGetKey = null;
//     }
//   }
// }

// // ---------- util helpers ----------
// function extractBearerToken(headerValue) {
//   if (!headerValue || typeof headerValue !== 'string') return null;
//   const m = headerValue.match(/^Bearer\s+(.+)$/i);
//   if (!m) return null;
//   const t = m[1].trim();
//   if (!t || t.toLowerCase() === 'null' || t.toLowerCase() === 'undefined') return null;
//   return t;
// }

// function looksLikeJwt(token) {
//   if (typeof token !== 'string') return false;
//   const parts = token.split('.');
//   return parts.length === 3 && parts.every((p) => p.length > 0);
// }

// /**
//  * JWT est en base64url, pas base64 standard.
//  * On décode proprement le header sans casser sur '-' '_' et padding.
//  */
// function base64UrlDecodeToJson(part) {
//   try {
//     const b64 = String(part)
//       .replace(/-/g, '+')
//       .replace(/_/g, '/')
//       .padEnd(Math.ceil(part.length / 4) * 4, '=');
//     const json = Buffer.from(b64, 'base64').toString('utf8');
//     return JSON.parse(json);
//   } catch {
//     return null;
//   }
// }

// /**
//  * Vérifie un token avec HS256 ou RS256(JWKS).
//  * Retourne payload (decoded).
//  */
// async function verifyJwt(token, verifyOpts, algorithms) {
//   if (jwksGetKey) {
//     // RS256 via JWKS
//     return await new Promise((resolve, reject) => {
//       jwt.verify(token, jwksGetKey, { ...verifyOpts, algorithms }, (err, payload) => {
//         if (err) return reject(err);
//         resolve(payload);
//       });
//     });
//   }
//   // HS256 local secret
//   return jwt.verify(token, JWT_SECRET, { ...verifyOpts, algorithms });
// }

// /**
//  * Construit les options de verify:
//  * - issuer si fourni
//  * - audience si fourni (liste)
//  */
// function buildVerifyOpts({ withAudience = true } = {}) {
//   const opts = {
//     clockTolerance: 5,
//     ignoreExpiration: false,
//   };
//   if (JWT_ISSUER) opts.issuer = JWT_ISSUER;

//   // ✅ Audience: uniquement si on a une liste et si withAudience=true
//   if (withAudience && JWT_AUDIENCES.length) {
//     // jsonwebtoken accepte un array d'audience
//     opts.audience = JWT_AUDIENCES;
//   }
//   return opts;
// }

// /**
//  * ✅ Strategy anti-"audience invalid" :
//  * 1) On tente verify strict (issuer + audience si configurés)
//  * 2) Si ça échoue pour audience (ou token sans aud) :
//  *    - En DEV : fallback sans audience
//  *    - En PROD : fallback uniquement si JWT_ALLOW_MISSING_AUD=true ET token n’a pas 'aud'
//  */
// async function verifyWithFallback(token) {
//   const tokenHeader = base64UrlDecodeToJson(token.split('.')[0]) || null;

//   // algo attendu selon config
//   const algos = jwksGetKey ? ['RS256'] : ['HS256'];

//   // 1) strict
//   try {
//     const payload = await verifyJwt(token, buildVerifyOpts({ withAudience: true }), algos);
//     return { payload, tokenHeader, usedFallback: false };
//   } catch (err) {
//     const msg = String(err?.message || '');
//     const isAudError =
//       err?.name === 'JsonWebTokenError' &&
//       (msg.includes('jwt audience invalid') || msg.includes('audience'));

//     // 2) fallback sans audience si autorisé (migration)
//     //    - si token n’a pas de aud, certains tokens legacy échouent quand audience est imposée
//     const decodedUnsafe = jwt.decode(token) || {};
//     const hasAudClaim = !!decodedUnsafe?.aud;

//     const canFallback =
//       !JWT_AUDIENCES.length
//         ? false
//         : !isProd // DEV => oui
//         ? true
//         : JWT_ALLOW_MISSING_AUD && !hasAudClaim; // PROD => seulement si missing aud et flag activé

//     if (isAudError && canFallback) {
//       const payload = await verifyJwt(token, buildVerifyOpts({ withAudience: false }), algos);
//       return { payload, tokenHeader, usedFallback: true };
//     }

//     // Re-throw sinon
//     throw err;
//   }
// }

// // protect middleware
// exports.protect = asyncHandler(async (req, _res, next) => {
//   const hdrAuth = req.get('Authorization') || req.get('authorization') || '';
//   const token = extractBearerToken(hdrAuth);

//   if (!token) {
//     console.debug('[auth][protect] missing token header', {
//       hasAuthorizationHeader: !!hdrAuth,
//     });
//     return next(createError(401, 'Non autorisé : token manquant'));
//   }

//   if (!looksLikeJwt(token)) {
//     console.warn('[auth][protect] token does not look like JWT (malformed)', {
//       preview: token.slice(0, 12),
//     });
//     return next(createError(401, 'Non autorisé : format de token invalide'));
//   }

//   let decoded;
//   let usedFallback = false;

//   try {
//     const r = await verifyWithFallback(token);
//     decoded = r.payload;
//     usedFallback = !!r.usedFallback;
//   } catch (err) {
//     // Log detailed reason to help debug 401s (will not leak token)
//     console.error('[auth][protect] jwt.verify failed', {
//       name: err?.name,
//       message: err?.message,
//       tokenHeader: base64UrlDecodeToJson(token.split('.')[0]),
//       issuerExpected: JWT_ISSUER || null,
//       audiencesExpected: JWT_AUDIENCES.length ? JWT_AUDIENCES : null,
//       allowMissingAud: JWT_ALLOW_MISSING_AUD,
//       usingJWKS: !!jwksGetKey,
//     });
//     return next(createError(401, 'Non autorisé : token invalide ou expiré'));
//   }

//   // Require a user id in token (sub or id)
//   const userId = decoded?.sub || decoded?.id || decoded?.userId || decoded?._id || null;
//   if (!userId) {
//     console.warn('[auth][protect] token missing user identifier (sub/id)', {
//       decodedKeys: Object.keys(decoded || {}),
//     });
//     return next(createError(401, 'Non autorisé : jeton sans identifiant utilisateur'));
//   }

//   // Load user from users DB connection
//   const user = await User.findById(userId).select('-password -twoFaSecret -__v').lean();
//   if (!user) {
//     console.warn('[auth][protect] user not found for id from token', { userId: String(userId) });
//     return next(createError(401, 'Utilisateur non trouvé'));
//   }

//   // Attach minimal profile with both _id and id to keep compatibility
//   req.user = {
//     _id: String(user._id),
//     id: String(user._id),
//     email: user.email,
//     role: user.role,
//     fullName: user.fullName,
//   };

//   /**
//    * ⚠️ Important:
//    * Évite de propager tout le payload JWT dans req (ça peut contenir des claims sensibles).
//    * On attache seulement un minimum utile pour debug/audit.
//    */
//   req.auth = {
//     tokenPreview: `${token.slice(0, 10)}...`,
//     alg: base64UrlDecodeToJson(token.split('.')[0])?.alg || null,
//     usedFallback, // ✅ true si on a dû ignorer l'audience (migration)
//   };

//   next();
// });




/**
 * src/middleware/authMiddleware.js
 *
 * Middleware 'protect' pour vérifier JWT (HS256 ou RS256 via JWKS).
 *
 * ✅ FIX IMPORTANT (2025-12):
 * - Support multi-audience : JWT_AUDIENCES="paynoval-api,paynoval-app,paynoval-mobile"
 * - Tolérance contrôlée si le token n'a pas de claim "aud" (migration) via JWT_ALLOW_MISSING_AUD=true
 *
 * - Attache req.user._id et req.user.id (compatibilité).
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

const { getUsersConn } = require("../config/db");
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

// protect middleware
exports.protect = asyncHandler(async (req, _res, next) => {
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

  // ✅ IMPORTANT: récupérer les champs requis pour AML
  const user = await User.findById(userId)
    .select([
      "-password",
      "-twoFaSecret",
      "-__v",
      // champs utiles AML/flows
      "email",
      "role",
      "fullName",
      "kycLevel",
      "type",
      "isBusiness",
      "kybStatus",
      "businessId",
      "securityQuestions",
      "country",
      "countryCode",
      "selectedCountry",
    ])
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
  };

  next();
});
