// src/middleware/authMiddleware.js

// Assurez-vous d'avoir installé et utilisé 'cookie-parser' dans votre application Express :
// const cookieParser = require('cookie-parser');
// app.use(cookieParser());

require('dotenv-safe').config();
const jwt = require('jsonwebtoken');
const createError = require('http-errors');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');

// Vérification de la présence de la clé secrète JWT
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET est requis pour l\'authentification');
}

/**
 * Middleware de protection de route
 * - Récupère le token depuis :
 *   - Authorization Bearer
 *   - Cookie 'token'
 *   - Header 'x-access-token'
 * - Vérifie et décode le token (expiration incluse)
 * - Charge l'utilisateur sans champs sensibles
 * - Attache l'utilisateur à req.user
 */
exports.protect = asyncHandler(async (req, res, next) => {
  let token;

  // Extraction du token
  if (req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies?.token) {
    token = req.cookies.token;
  } else if (req.headers['x-access-token']) {
    token = req.headers['x-access-token'];
  }

  if (!token) {
    return next(createError(401, 'Non autorisé : token manquant'));
  }

  // Vérification du token et gestion de l'expiration
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return next(createError(401, 'Non autorisé : token invalide ou expiré'));
  }

  // Chargement de l'utilisateur sans champs sensibles
  const user = await User.findById(decoded.id)
    .select('-password -twoFactorSecret');
  if (!user) {
    return next(createError(401, 'Utilisateur non trouvé'));
  }

  // Injection de l'utilisateur dans la requête
  req.user = user;
  next();
});

/**
 * Middleware d'autorisation selon les rôles
 * Usage : authorize('admin', 'manager')
 */
exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(createError(403, 'Accès refusé : permissions insuffisantes'));
    }
    next();
  };
};
