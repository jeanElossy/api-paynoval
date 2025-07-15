// middleware/onlyGateway.js
module.exports = function onlyGateway(req, res, next) {
  if (req.headers['x-internal-token'] !== process.env.INTERNAL_TOKEN) {
    // Astuce : log le remote IP pour détecter les attaques
    console.warn(`[BACKEND] Requête refusée - IP: ${req.ip || req.connection.remoteAddress}`);
    return res.status(403).json({ error: 'Accès interdit. Gateway uniquement.' });
  }
  next();
};
