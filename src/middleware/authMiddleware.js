// src/middleware/authMiddleware.js

require('dotenv-safe').config();
const jwt = require('jsonwebtoken');
const createError = require('http-errors');
const asyncHandler = require('express-async-handler');

// Toujours injecter la connexion pour éviter les collisions de modèle (microservice)
const { getUsersConn } = require('../config/db');
const User = require('../models/User')(getUsersConn());

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET est requis pour l’authentification');
}

exports.protect = asyncHandler(async (req, res, next) => {
  // 1️⃣ Récupérer le token
  let token = null;
  const authHeader = req.get('Authorization') || req.get('authorization');
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

  // 2️⃣ Vérifier le token JWT
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return next(createError(401, 'Non autorisé : token invalide ou expiré'));
  }

  // 3️⃣ Charger l’utilisateur (toujours sur la bonne DB)
  const user = await User.findById(decoded.id).select('-password -twoFaSecret');
  if (!user) {
    return next(createError(401, 'Utilisateur non trouvé'));
  }

  // 4️⃣ Attacher l’utilisateur et continuer
  req.user = {
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    fullName: user.fullName,
    // Ajoute d'autres champs ici si besoin
  };
  next();
});
