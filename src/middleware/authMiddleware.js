/* src/middleware/authMiddleware.js */
require('dotenv-safe').config();
const jwt = require('jsonwebtoken');
const createError = require('http-errors');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');

// Vérification de la présence de la clé secrète
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET requis pour l\'authentification');
}

/**
 * Middleware de protection de route :
 * - Récupère le token depuis l'entête Authorization ou le cookie
 * - Vérifie et décode le token JWT
 * - Charge l'utilisateur depuis la base (sans le password)
 * - Ajoute l'objet user à req.user
 */
exports.protect = asyncHandler(async (req, res, next) => {
  let token;

  // 1) Récupération du token
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return next(createError(401, 'Non autorisé, token manquant'));
  }

  // 2) Vérification du token
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return next(createError(401, 'Non autorisé, token invalide ou expiré'));
  }

  // 3) Chargement de l'utilisateur
  const user = await User.findById(decoded.id).select('-password');
  if (!user) {
    return next(createError(401, 'Utilisateur non trouvé'));
  }

  // 4) Injection de l'utilisateur dans req
  req.user = user;
  next();
});

/**
 * Middleware d'autorisation selon les rôles
 * Usage : authorize('admin', 'manager')
 */
exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(createError(403, 'Accès refusé : permissions insuffisantes'));
    }
    next();
  };
};
