// src/middleware/authMiddleware.js

// Prérequis dans server.js :
// const cookieParser = require('cookie-parser');
// app.use(cookieParser());

require('dotenv-safe').config();
const jwt = require('jsonwebtoken');
const createError = require('http-errors');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');

// Vérifier la clé secrète
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET est requis pour l’authentification');
}

/**
 * Middleware de protection de route
 */
exports.protect = asyncHandler(async (req, res, next) => {
  let token;
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.cookies?.token) {
    token = req.cookies.token;
  } else if (req.headers['x-access-token']) {
    token = req.headers['x-access-token'];
  }

  if (!token) {
    return next(createError(401, 'Non autorisé : token manquant'));
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return next(createError(401, 'Non autorisé : token invalide ou expiré'));
  }

  const user = await User.findById(decoded.id).select('-password -twoFactorSecret');
  if (!user) {
    return next(createError(401, 'Utilisateur non trouvé'));  
  }

  req.user = user;
  next();
});

/**
 * Middleware d'autorisation par rôles
 */
exports.authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(createError(403, 'Accès refusé : permissions insuffisantes'));
  }
  next();
};
