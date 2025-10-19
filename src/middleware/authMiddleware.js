// src/middleware/authMiddleware.js

/**
 * Chargement .env uniquement en DEV (en PROD, l'env vient de la plateforme).
 */
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

// Connexion utilisateurs (évite collisions de modèles entre microservices)
const { getUsersConn } = require('../config/db');
const User = require('../models/User')(getUsersConn());

/* =========================
   Configuration sécurité
   ========================= */
const isProd = process.env.NODE_ENV === 'production';

const hasJWKS = !!process.env.JWKS_URI;
let JWT_ISSUER   = process.env.JWT_ISSUER;
let JWT_AUDIENCE = process.env.JWT_AUDIENCE;
let JWT_SECRET   = process.env.JWT_SECRET;

// En DEV, fournir des valeurs de secours (pour éviter les crashs)
if (!isProd) {
  if (!JWT_SECRET)   JWT_SECRET   = 'dev-secret-change-me';
  if (!JWT_ISSUER)   JWT_ISSUER   = 'http://localhost';
  if (!JWT_AUDIENCE) JWT_AUDIENCE = 'paynoval-transactions-dev';
}

// En PROD, exiger une config correcte (JWKS ou HS256 + iss/aud)
if (isProd) {
  if (hasJWKS) {
    if (!JWT_ISSUER || !JWT_AUDIENCE) {
      throw new Error('JWT_ISSUER et JWT_AUDIENCE sont requis en production quand JWKS_URI est défini.');
    }
  } else {
    if (!JWT_SECRET || !JWT_ISSUER || !JWT_AUDIENCE) {
      throw new Error('Configuration JWT incomplète: fournissez JWT_SECRET, JWT_ISSUER et JWT_AUDIENCE en production (ou bien configurez JWKS_URI).');
    }
  }
}

// Utils
function extractBearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const m = headerValue.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
function looksLikeJwt(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  return parts.length === 3 && parts.every(p => p.length > 0);
}

/* =========================
   RS256 + JWKS (prioritaire)
   ========================= */
let jwksGetKey = null;
if (hasJWKS) {
  try {
    const jwksRsa = require('jwks-rsa');
    const jwksClient = jwksRsa({
      jwksUri: process.env.JWKS_URI,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 10 * 60 * 1000, // 10 min
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });
    jwksGetKey = (header, cb) => {
      jwksClient.getSigningKey(header.kid, (err, key) => {
        if (err) return cb(err);
        const signingKey = key.getPublicKey();
        cb(null, signingKey);
      });
    };
  } catch (e) {
    if (isProd) {
      // En prod, si on a JWKS_URI mais pas la lib, mieux vaut échouer clairement.
      throw new Error("Module 'jwks-rsa' manquant. Installez-le ou retirez JWKS_URI.");
    } else {
      console.warn("[auth] jwks-rsa non installé — fallback HS256 en DEV");
      jwksGetKey = null;
    }
  }
}

/* =========================
   Middleware protect
   ========================= */
exports.protect = asyncHandler(async (req, res, next) => {
  // 1) Source token: UNIQUEMENT Authorization: Bearer
  const hdrAuth = req.get('Authorization') || req.get('authorization');
  const token = extractBearerToken(hdrAuth);
  if (!token) {
    return next(createError(401, 'Non autorisé : token manquant'));
  }
  if (!looksLikeJwt(token)) {
    return next(createError(401, 'Non autorisé : format de token invalide'));
  }

  // 2) Vérification du token
  let decoded;
  const verifyCommon = {
    issuer:   JWT_ISSUER,
    audience: JWT_AUDIENCE,
    clockTolerance: 5,       // tolérance horloge (sec)
    ignoreExpiration: false, // exp obligatoire
  };

  try {
    if (jwksGetKey) {
      // RS256 via JWKS
      decoded = await new Promise((resolve, reject) => {
        jwt.verify(token, jwksGetKey, { ...verifyCommon, algorithms: ['RS256'] }, (err, payload) => {
          if (err) return reject(err);
          resolve(payload);
        });
      });
    } else {
      // HS256 local
      decoded = jwt.verify(token, JWT_SECRET, { ...verifyCommon, algorithms: ['HS256'] });
    }
  } catch (err) {
    return next(createError(401, 'Non autorisé : token invalide ou expiré'));
  }

  // 3) Identifier l’utilisateur (id dans sub ou id)
  const userId = decoded.sub || decoded.id;
  if (!userId) {
    return next(createError(401, 'Non autorisé : jeton sans identifiant utilisateur'));
  }

  // 4) Charger l’utilisateur (DB utilisateurs) — champs sensibles exclus
  const user = await User.findById(userId)
    .select('-password -twoFaSecret -__v')
    .lean();

  if (!user) {
    return next(createError(401, 'Utilisateur non trouvé'));
  }

  // Optionnel : bloquer comptes désactivés/suspendus
  // if (user.disabled || user.status === 'disabled' || user.suspended) {
  //   return next(createError(403, 'Compte désactivé'));
  // }

  // 5) Attacher un profil minimal et poursuivre
  req.user = {
    id: String(user._id),
    email: user.email,
    role: user.role,
    fullName: user.fullName,
  };

  next();
});
