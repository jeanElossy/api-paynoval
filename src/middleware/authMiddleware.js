

// src/middleware/authMiddleware.js
require('dotenv-safe').config();
const jwt = require('jsonwebtoken');
const createError = require('http-errors');
const asyncHandler = require('express-async-handler');
const User = require('../models/User')();


if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET est requis pour l’authentification');
}

exports.protect = asyncHandler(async (req, res, next) => {
  // 1. Récupérer le token
  const authHeader = req.get('Authorization'); // gère la casse
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.cookies?.token) {
    token = req.cookies.token;
  } else if (req.get('x-access-token')) {
    token = req.get('x-access-token');
  }

  if (!token) {
    return next(createError(401, 'Non autorisé : token manquant'));
  }

  // 2. Vérifier le token JWT
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return next(createError(401, 'Non autorisé : token invalide ou expiré'));
  }

  // 3. Charger l’utilisateur
  const user = await User.findById(decoded.id).select('-password -twoFactorSecret');
  if (!user) {
    return next(createError(401, 'Utilisateur non trouvé'));
  }

  // 4. Attacher et continuer
  req.user = user;
  next();
});
