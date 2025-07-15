// middleware/authz.js

function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ message: "Utilisateur non authentifié" });
    }
    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ message: "Accès refusé" });
    }
    next();
  };
}

module.exports = { requireRole };
