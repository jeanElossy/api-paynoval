/**
 * src/middleware/authMiddleware.js
 *
 * - protect: JWT (HS256 ou RS256 via JWKS)
 * - internalProtect: token interne (x-internal-token) pour routes /internal/*
 *
 * ✅ FIX CRITIQUE: projection Mongo => pas de mix inclusion/exclusion
 * ✅ Bonus: support appels internes (gateway/tx-core/principal) via x-internal-token + x-user-id
 * ✅ Robustesse: User model lazy (évite crash si Users DB pas prête au require)
 */

"use strict";

/* Chargement .env en DEV uniquement (prod gère via plateforme) */
if (process.env.NODE_ENV !== "production") {
  try {
    require("dotenv-safe").config({ allowEmptyValues: true });
  } catch (e) {
    // Pas bloquant
    console.warn("[dotenv-safe] skipped in authMiddleware:", e.message);
  }
}

const jwt = require("jsonwebtoken");
const createError = require("http-errors");
const asyncHandler = require("express-async-handler");

const mongoose = require("mongoose");

const { getUsersConn } = require("../config/db");
const {
  resolveDeviceId,
  evaluateDeviceBinding,
  buildDeviceQuery,
} = require("./deviceBinding");
const config = require("../config");
const { getVerificationKey, readKid } = require("../utils/jwtKeyring");

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

// ─────────────────────────────────────────────────────────────
// JWKS setup (optional)
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// Lazy User Model (évite crash si DB pas prête au require)
// ─────────────────────────────────────────────────────────────
let _UserModel = null;
/**
 * Modèle `Device`, résolu PARESSEUSEMENT comme `User` : la connexion Users
 * n'existe qu'après `connectTransactionsDB()`, et le résoudre à l'import
 * rendrait ce middleware — donc tout le service — impossible à charger hors
 * d'un processus serveur démarré.
 *
 * Rend `null` plutôt que de lever : l'appelant traite l'indisponibilité en
 * FAIL-CLOSED (503), ce qui est plus lisible qu'une exception remontée.
 */
let _DeviceModel = null;

function getDeviceModel() {
  if (_DeviceModel) return _DeviceModel;

  try {
    const conn = getUsersConn?.();
    if (!conn) return null;

    _DeviceModel = require("../models/Device")(conn);
    return _DeviceModel;
  } catch (_err) {
    return null;
  }
}

function getUserModel() {
  if (_UserModel) return _UserModel;

  const conn = getUsersConn?.();
  if (!conn) {
    // On laisse remonter une erreur claire au runtime
    throw createError(500, "Users DB connection indisponible");
  }

  // IMPORTANT: le modèle est une factory dans ton projet
  // eslint-disable-next-line global-require
  _UserModel = require("../models/User")(conn);
  return _UserModel;
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
  /**
   * ⚠️ CLÉ CHOISIE PAR `kid` — POSÉ LE 2026-09-03.
   *
   * Tx Core vérifie ce que le backend principal signe. Depuis que celui-ci
   * signe avec un trousseau, il faut savoir choisir la même clé — sinon la
   * première rotation refuserait ici tous les jetons utilisateur, c'est-à-dire
   * bloquerait le moteur transactionnel.
   *
   * `JWT_SECRET` reste le repli pour les jetons sans `kid` (tous ceux émis
   * avant ce déploiement). Le régime JWKS, s'il est actif, passe au-dessus :
   * il porte sa propre résolution de clé.
   */
  const cle = getVerificationKey(readKid(token)) || JWT_SECRET;

  return jwt.verify(token, cle, { ...verifyOpts, algorithms });
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

  // Si JWKS est configuré, on s’attend à RS256.
  // Sinon HS256.
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
      JWT_AUDIENCES.length && (!isProd || (JWT_ALLOW_MISSING_AUD && !hasAudClaim));

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
/**
 * Comparaison à temps constant — UNE SEULE implémentation pour tout le service.
 *
 * Il en existait trois jusqu'au 2026-09-03, et les deux copies locales
 * retournaient tôt sur une différence de longueur :
 *
 *     if (left.length !== right.length) return false;   // ← la fuite
 *
 * Ce retour anticipé rend le temps de réponse dépendant de la LONGUEUR du
 * secret attendu : un appelant non authentifié peut la mesurer statistiquement,
 * ce qui réduit d'autant l'espace à explorer. `utils/internalTokens.js` complète
 * les tampons par des zéros AVANT de comparer, puis vérifie l'égalité des
 * longueurs — l'ordre est ce qui fait la propriété.
 *
 * Même geste que `requireRole.js` côté passerelle : un doublon divergent sur un
 * chemin d'autorisation finit toujours par diverger du mauvais côté.
 */
const { timingSafeEqualStr: comparaisonSure } = require("../utils/internalTokens");

function timingSafeEqualStr(a, b) {
  // Un token vide n'authentifie personne : garde conservée de l'implémentation
  // locale, elle ne dépend d'aucun secret et ne fuit donc rien.
  const gauche = String(a || "").trim();
  const droite = String(b || "").trim();
  if (!gauche || !droite) return false;

  return comparaisonSure(gauche, droite);
}

function getInternalHeaderToken(req) {
  // Node lower-case les headers, mais on accepte plusieurs alias
  const raw =
    req.headers["x-internal-token"] ||
    req.headers["x_internal_token"] ||
    req.headers["x-internal"] ||
    req.headers["x_internal"] ||
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
 * Tu peux mettre: INTERNAL_TOKEN="token1,token2"
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

    // config fallback
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
 * (pas de mix inclusion/exclusion)
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
 * Map User -> req.user (format stable)
 */
function mapUserToReqUser(userDoc) {
  return {
    _id: String(userDoc._id),
    id: String(userDoc._id),

    email: userDoc.email,
    role: userDoc.role,
    fullName: userDoc.fullName,

    // AML fields
    kycLevel: userDoc.kycLevel,
    type: userDoc.type,
    isBusiness: userDoc.isBusiness,
    kybStatus: userDoc.kybStatus,
    businessId: userDoc.businessId,

    securityQuestions: Array.isArray(userDoc.securityQuestions) ? userDoc.securityQuestions : [],

    country: userDoc.country,
    countryCode: userDoc.countryCode,
    selectedCountry: userDoc.selectedCountry,
  };
}

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

  // Si pas de user fourni, on autorise quand même (appel service->service)
  if (!uid) {
    req.user = { _id: null, id: null, role: "internal" };
    req.auth = {
      internal: true,
      scope: "internal",
      tokenPreview: `${gotInternal.slice(0, 6)}...`,
      usedFallback: false,
    };
    req.isInternal = true;
    return next();
  }

  const User = getUserModel();
  const user = await User.findById(uid).select(USER_SAFE_EXCLUDE).lean();

  if (!user) {
    return next(createError(401, "Utilisateur non trouvé"));
  }

  req.user = mapUserToReqUser(user);
  req.auth = {
    internal: true,
    scope: "internal",
    tokenPreview: `${gotInternal.slice(0, 6)}...`,
    usedFallback: false,
  };
  req.isInternal = true;
  return next();
});

/**
 * ✅ protect (JWT) + support appels internes gateway (x-internal-token + x-user-id)
 */
/**
 * ============================================================================
 * IDENTITÉ PROUVÉE CONTRE IDENTITÉ ASSERTÉE
 * ============================================================================
 *
 * ⚠️ CE MIDDLEWARE LAISSAIT N'IMPORTE QUEL PORTEUR DU JETON INTERNE SE
 * DÉCLARER N'IMPORTE QUEL UTILISATEUR — SUPERADMIN COMPRIS.
 *
 * L'ancienne première branche était : `x-internal-token` valide + `x-user-id`
 * ⇒ on charge cet utilisateur et on lui rend son rôle réel, **sans jamais
 * vérifier le JWT**. Elle rendait la main AVANT même de regarder l'en-tête
 * `Authorization`. Un secret de service devenait donc une clé d'usurpation
 * universelle : c'est le « député confus » dans sa forme la plus directe.
 *
 * LA RÈGLE APPLIQUÉE MAINTENANT — celle des grands émetteurs de paiement :
 *
 *   **Un jeton de service authentifie un SERVICE. Jamais un UTILISATEUR.**
 *
 * D'où trois cas, et un seul chemin vers le privilège :
 *
 *   1. **Jeton interne + JWT utilisateur** → le JWT GAGNE. L'identité est
 *      PROUVÉE (l'utilisateur l'a présentée), le rôle réel s'applique, et le
 *      jeton interne ne sert plus qu'à marquer `req.isInternal` — une confiance
 *      réseau, pas une identité. C'est le cas de la passerelle, qui relaie déjà
 *      l'`Authorization` d'origine.
 *
 *   2. **Jeton interne + `x-user-id`, sans JWT** → identité ASSERTÉE. Le
 *      service agit POUR le compte, sans que celui-ci l'ait présenté. On charge
 *      bien l'utilisateur — un virement doit être rattaché à quelqu'un — mais
 *      **le rôle est ramené à `user`**. Une identité assertée ne porte AUCUN
 *      privilège d'exploitation : elle ne peut ni valider, ni rembourser, ni
 *      annuler autre chose que ce que le compte pourrait faire lui-même.
 *      C'est exactement le motif « on-behalf-of » : agir pour un client, jamais
 *      en tant que personnel.
 *
 *   3. **Jeton interne seul** → principal de SERVICE (`role: "gateway"`), sans
 *      identité utilisateur. Inchangé.
 *
 * Conséquence concrète : le secret de service, s'il fuite, ne donne plus accès
 * qu'à ce qu'un utilisateur ordinaire peut faire sur son propre compte. Le
 * privilège d'exploitation exige un JWT valide et un rôle en base.
 */
exports.protect = asyncHandler(async (req, _res, next) => {
  const gotInternal = String(getInternalHeaderToken(req) || "").trim();
  const isInternalCaller = Boolean(gotInternal && isValidInternalToken(gotInternal));

  const hdrAuth = req.get("Authorization") || req.get("authorization") || "";
  const token = extractBearerToken(hdrAuth);

  /* ==========================================================================
   * CAS 3 — jeton de service seul : aucune identité utilisateur
   * ======================================================================== */
  if (isInternalCaller && !token) {
    const uid = String(getUserIdHeader(req) || "").trim();

    if (!uid) {
      req.user = { _id: null, id: null, role: "gateway" };
      req.auth = {
        internal: true,
        scope: "gateway",
        assertedIdentity: false,
        tokenPreview: `${gotInternal.slice(0, 6)}...`,
        usedFallback: false,
      };
      req.isInternal = true;
      return next();
    }

    /* ========================================================================
     * CAS 2 — identité ASSERTÉE : on agit POUR le compte, sans privilège
     * ====================================================================== */
    if (!mongoose.isValidObjectId(uid)) {
      return next(createError(400, "En-tête x-user-id invalide"));
    }

    const User = getUserModel();
    const user = await User.findById(uid).select(USER_SAFE_EXCLUDE).lean();
    if (!user) return next(createError(401, "Utilisateur non trouvé"));

    const mapped = mapUserToReqUser(user);

    /**
     * ⚠️ LA LIGNE QUI FERME LA PORTE. Le rôle réel de ce compte n'est PAS
     * appliqué : personne n'a prouvé que son titulaire est à l'origine de
     * l'appel. Un compte administrateur asserté par en-tête agit comme un
     * utilisateur ordinaire — et c'est tout ce dont les appels de service
     * légitimes (miroir de transactions, relance de file) ont besoin.
     */
    req.user = { ...mapped, role: "user", assertedRole: true };
    req.auth = {
      internal: true,
      scope: "gateway",
      assertedIdentity: true,
      tokenPreview: `${gotInternal.slice(0, 6)}...`,
      usedFallback: false,
    };
    req.isInternal = true;
    return next();
  }

  /* ==========================================================================
   * CAS 1 — identité PROUVÉE par JWT (avec ou sans jeton de service)
   * ======================================================================== */
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

  const User = getUserModel();
  const user = await User.findById(userId).select(USER_SAFE_EXCLUDE).lean();

  if (!user) {
    return next(createError(401, "Utilisateur non trouvé"));
  }

  /* ==========================================================================
   * LIAISON À L'APPAREIL — la révocation de session s'arrêtait à la porte
   * ========================================================================
   * Voir `middleware/deviceBinding.js`. En résumé : un jeton exfiltré était
   * refusé par le backend principal et ACCEPTÉ ICI, c'est-à-dire par le service
   * qui détient les soldes et exécute les virements.
   */
  const binding = resolveDeviceId({ payload: decoded, headers: req.headers });

  if (binding.mismatch) {
    return next(createError(401, "Appareil incohérent avec le jeton"));
  }

  if (binding.deviceId) {
    const Device = getDeviceModel();

    if (!Device) {
      // Fail-closed : un jeton lié à un appareil ne passe jamais sans que la
      // vérification ait pu avoir lieu.
      return next(createError(503, "Vérification de l'appareil indisponible"));
    }

    let device;
    try {
      device = await Device.findOne(
        buildDeviceQuery(binding.deviceId, String(user._id)),
        "sessionInvalidBefore status user"
      ).lean();
    } catch (_err) {
      // Fail-closed également sur panne base.
      return next(createError(503, "Vérification de l'appareil indisponible"));
    }

    const verdict = evaluateDeviceBinding({
      device,
      payloadIat: decoded?.iat,
    });

    if (!verdict.ok) {
      /**
       * ⚠️ DIAGNOSTIC — sans lui, un défaut de configuration se présente comme
       * un 401 opaque sur TOUTES les requêtes mobiles.
       *
       * Le cas redouté : la connexion Users de TX Core ne pointe pas sur la même
       * base que celle où le backend écrit les appareils. Le contrôle échoue
       * alors en `UNKNOWN_DEVICE` pour tout le monde, et rien ne distingue « la
       * session a été révoquée » de « je ne regarde pas au bon endroit ».
       *
       * L'identifiant d'appareil n'est pas un secret : le journaliser est sans
       * risque, et c'est ce qui rend la panne diagnosticable en une ligne.
       */
      try {
        // eslint-disable-next-line no-console
        console.warn(
          `[auth] appareil refusé (${verdict.code}) user=${String(user._id)} device=${binding.deviceId}`
        );
      } catch {}

      return next(createError(verdict.status, verdict.message));
    }

    req.device = device;
  }

  req.user = mapUserToReqUser(user);

  req.auth = {
    tokenPreview: `${token.slice(0, 10)}...`,
    alg: base64UrlDecodeToJson(token.split(".")[0])?.alg || null,
    usedFallback,
    internal: isInternalCaller,
    assertedIdentity: false,
  };

  // Le jeton de service reste une information de confiance RÉSEAU, jamais une
  // identité : il ne change ni l'utilisateur ni son rôle.
  req.isInternal = isInternalCaller;
  return next();
});
