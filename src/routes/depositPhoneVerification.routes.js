"use strict";

/**
 * ============================================================================
 * VÉRIFICATION D'UN NUMÉRO DE DÉPÔT — `/api/v1/phone-verification`
 * ============================================================================
 *
 * Ce chemin est celui que l'application mobile appelle DÉJÀ
 * (`payNoval-master/tools/api.js`, `GATEWAY_PHONE_VERIFY_*`). Il rendait 404 :
 * le bord ne montait rien à cette adresse et ne relayait pas le préfixe. Le
 * conserver à l'identique évite de faire dépendre le correctif d'une mise à
 * jour du mobile — les anciennes installations sont réparées sans rien publier.
 *
 * ⚠️ À NE PAS CONFONDRE avec `/api/v1/verification/start-phone` du backend
 * principal, qui vérifie le numéro DU COMPTE et écrit `users.phoneVerified`.
 * Deux capacités, deux propriétaires, deux chemins — c'est leur confusion qui a
 * produit trois implémentations dont une morte.
 */

const express = require("express");
const rateLimit = require("express-rate-limit");
const { body, query } = require("express-validator");

const { protect } = require("../middleware/authMiddleware");
const requestValidator = require("../middleware/requestValidator");
const {
  status,
  start,
  verify,
  list,
} = require("../controllers/depositPhoneVerification.controller");

const router = express.Router();

/**
 * ⚠️ SEAU PAR UTILISATEUR, PAS PAR ADRESSE IP.
 *
 * Tx-Core ne voit que les adresses de la passerelle : compter par IP mettrait
 * tous les clients dans un seul seau, et un utilisateur seul suffirait à
 * renvoyer 429 à tout le monde. C'est arrivé le 2026-08-19 sur
 * `GET /api/v1/transactions` ; voir `utils/rateLimitKey.js`.
 *
 * Ce limiteur est un FILET, pas le contrôle. Le vrai anti-abus est en base
 * (délai de renvoi, quota par fenêtre, blocage), parce qu'il doit survivre au
 * redémarrage du processus et valoir pour toutes les instances.
 */
function seauUtilisateur(req) {
  const id = req.user?._id || req.user?.id;
  return id ? `u:${String(id)}` : `ip:${req.ip || "inconnu"}`;
}

const limiteurEnvoi = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: seauUtilisateur,
  message: {
    success: false,
    error: "Trop de demandes de vérification. Réessaie plus tard.",
    code: "OTP_RATE_LIMIT",
  },
});

const limiteurLecture = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: seauUtilisateur,
  message: {
    success: false,
    error: "Trop de requêtes.",
    code: "RATE_LIMIT",
  },
});

/**
 * `protect` AVANT le limiteur : sans `req.user`, le seau retomberait sur l'IP
 * de la passerelle — c'est-à-dire sur un seau commun à tous les clients.
 */
router.get(
  "/status",
  protect,
  limiteurLecture,
  query("phoneNumber").exists().isString().trim().isLength({ min: 4, max: 20 }),
  query("country").optional().isString().trim().isLength({ max: 4 }),
  requestValidator,
  status
);

router.post(
  "/start",
  protect,
  limiteurEnvoi,
  body("phoneNumber").exists().isString().trim().isLength({ min: 4, max: 20 }),
  body("country").optional().isString().trim().isLength({ max: 4 }),
  body("channel").optional().isString().trim().isIn(["sms", "whatsapp", "call"]),
  requestValidator,
  start
);

router.post(
  "/verify",
  protect,
  limiteurEnvoi,
  body("phoneNumber").exists().isString().trim().isLength({ min: 4, max: 20 }),
  body("country").optional().isString().trim().isLength({ max: 4 }),

  /**
   * Le code est borné en longueur ET restreint aux chiffres. Sans cette borne,
   * une chaîne arbitraire est relayée jusqu'à Twilio : on paie une vérification
   * facturée pour une valeur qui ne pouvait pas être un code.
   */
  body("code").exists().isString().trim().isLength({ min: 4, max: 10 }).isNumeric(),

  requestValidator,
  verify
);

router.get("/list", protect, limiteurLecture, list);

module.exports = router;
