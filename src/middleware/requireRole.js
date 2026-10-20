// File: src/middleware/requireRole.js

/**
 * Middleware Express pour restreindre l'accès à certains rôles.
 * Utilisation : requireRole('admin') ou requireRole(['admin','superadmin'])
 */
const { applyStaffTwoFactor } = require("../services/staffTwoFactor");

module.exports = function requireRole(roles) {
  // Supporte string ou tableau
  const allowed = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    // Il faut que req.user soit présent (injecté par protect)
    if (!req.user || !allowed.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: "Accès interdit (role insuffisant)" });
    }
    // Staff 2FA is mandatory (services/staffTwoFactor.js, 2026-10-18): a
    // back-office password alone never reaches an admin action on money.
    if (applyStaffTwoFactor(req, res)) return undefined;
    next();
  };
};
