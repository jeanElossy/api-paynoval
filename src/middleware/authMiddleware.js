/**
 * src/middleware/authMiddleware.js
 *
 * Middleware 'protect' pour vérifier JWT (HS256 ou RS256 via JWKS).
 * - Attache req.user._id et req.user.id (compatibilité avec le reste des services).
 * - Log des erreurs de vérification pour faciliter le débogage.
 * - En DEV, tolérance accrue si issuer/audience non fournis.
 */

/* Chargement .env en DEV uniquement (prod gère via plateforme) */
if (process.env.NODE_ENV !== 'production') {
  try {
    require('dotenv-safe').config({ allowEmptyValues: true });
  } catch (e) {
    console.warn('[dotenv-safe] skipped in authMiddleware:', e.message);
  }
}

const jwt = require('jsonwebtoken');
const createError = require('http-errors');
const asyncHandler = require('express-async-handler');

const { getUsersConn } = require('../config/db');
const User = require('../models/User')(getUsersConn());

const isProd = process.env.NODE_ENV === 'production';
const hasJWKS = !!process.env.JWKS_URI;

let JWT_ISSUER   = process.env.JWT_ISSUER || '';
let JWT_AUDIENCE = process.env.JWT_AUDIENCE || '';
let JWT_SECRET   = process.env.JWT_SECRET || '';

// Defaults in DEV to avoid crash, but we remain permissive
if (!isProd) {
  if (!JWT_SECRET)   JWT_SECRET   = 'dev-secret-change-me';
  if (!JWT_ISSUER)   JWT_ISSUER   = '';
  if (!JWT_AUDIENCE) JWT_AUDIENCE = '';
}

// JWKS setup (optional)
let jwksGetKey = null;
if (hasJWKS) {
  try {
    const jwksRsa = require('jwks-rsa');
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
        } catch (e) { cb(e); }
      });
    };
    console.info('[auth] JWKS configured (RS256)');
  } catch (e) {
    // En prod, échouer si la config est mal installée
    if (isProd) {
      throw new Error("Module 'jwks-rsa' manquant ou JWKS_URI invalide. Installez la dépendance ou retirez JWKS_URI.");
    } else {
      console.warn("[auth] jwks-rsa non installé / JWKS_URI unusable — fallback HS256 en DEV");
      jwksGetKey = null;
    }
  }
}

// ---------- util helpers ----------
function extractBearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const m = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const t = m[1].trim();
  if (!t || t.toLowerCase() === 'null') return null;
  return t;
}
function looksLikeJwt(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  return parts.length === 3 && parts.every(p => p.length > 0);
}

// protect middleware
exports.protect = asyncHandler(async (req, res, next) => {
  const hdrAuth = req.get('Authorization') || req.get('authorization') || '';
  const token = extractBearerToken(hdrAuth);

  if (!token) {
    // debug minimal info
    console.debug('[auth][protect] missing token header', { hasAuthorizationHeader: !!hdrAuth });
    return next(createError(401, 'Non autorisé : token manquant'));
  }

  if (!looksLikeJwt(token)) {
    console.warn('[auth][protect] token does not look like JWT (malformed)', { preview: token.slice(0,8) });
    return next(createError(401, 'Non autorisé : format de token invalide'));
  }

  // Build verify options: include issuer/audience only if provided (to allow dev tokens)
  const verifyOpts = {
    clockTolerance: 5,
    ignoreExpiration: false,
  };
  if (JWT_ISSUER) verifyOpts.issuer = JWT_ISSUER;
  if (JWT_AUDIENCE) verifyOpts.audience = JWT_AUDIENCE;

  let decoded;
  try {
    if (jwksGetKey) {
      // RS256 via JWKS
      decoded = await new Promise((resolve, reject) => {
        jwt.verify(token, jwksGetKey, { ...verifyOpts, algorithms: ['RS256'] }, (err, payload) => {
          if (err) return reject(err);
          resolve(payload);
        });
      });
    } else {
      // HS256 local secret
      decoded = jwt.verify(token, JWT_SECRET, { ...verifyOpts, algorithms: ['HS256'] });
    }
  } catch (err) {
    // Log detailed reason to help debug 401s (will not leak token)
    console.error('[auth][protect] jwt.verify failed', {
      name: err.name,
      message: err.message,
      // preview token header (no payload) — decode safe (no verification) for debug only
      tokenHeader: (() => {
        try {
          const p = token.split('.');
          const header = JSON.parse(Buffer.from(p[0], 'base64').toString('utf8'));
          return header;
        } catch (e) { return null; }
      })(),
      issuerExpected: JWT_ISSUER || null,
      audienceExpected: JWT_AUDIENCE || null,
      usingJWKS: !!jwksGetKey,
    });
    // Uniform message to client
    return next(createError(401, 'Non autorisé : token invalide ou expiré'));
  }

  // Require an user id in token (sub or id)
  const userId = decoded.sub || decoded.id || decoded.userId || null;
  if (!userId) {
    console.warn('[auth][protect] token missing user identifier (sub/id)', { decodedKeys: Object.keys(decoded || {}) });
    return next(createError(401, 'Non autorisé : jeton sans identifiant utilisateur'));
  }

  // Load user from users DB connection
  const user = await User.findById(userId).select('-password -twoFaSecret -__v').lean();
  if (!user) {
    console.warn('[auth][protect] user not found for id from token', { userId });
    return next(createError(401, 'Utilisateur non trouvé'));
  }

  // Attach minimal profile with both _id and id to keep compatibility
  req.user = {
    _id: String(user._id),
    id: String(user._id),
    email: user.email,
    role: user.role,
    fullName: user.fullName,
  };

  // Optional: attach raw token info for downstream audit (masked)
  req.auth = {
    tokenPreview: `${token.slice(0,8)}...`,
    jwtPayload: decoded, // caution: may contain sensitive claims; remove if needed
  };

  next();
});
