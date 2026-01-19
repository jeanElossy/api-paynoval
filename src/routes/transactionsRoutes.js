// File: src/routes/transactionsRoutes.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const { body } = require("express-validator");
const asyncHandler = require("express-async-handler");

const {
  listInternal,
  initiateInternal,
  confirmController,
  cancelController,
  getTransactionController,
  refundController,
  validateController,
  reassignController,
  archiveController,
  relaunchController,
} = require("../controllers/transactionsController");

const { protect } = require("../middleware/authMiddleware");
const requireRole = require("../middleware/requireRole");
const requestValidator = require("../middleware/requestValidator");

const router = express.Router();

// 🛡 Limiteur pour les routes critiques (anti brute-force)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    status: 429,
    message: "Trop de requêtes, veuillez réessayer plus tard.",
  },
});

// On applique le limiter uniquement sur les actions sensibles
router.use(["/initiate", "/confirm", "/cancel"], limiter);

/**
 * ✅ Middleware de normalisation payload (compat Gateway/Mobile)
 * - Accepte country OU destinationCountry
 * - Accepte senderCurrencySymbol OU senderCurrencyCode/currencySource/currencyCode/currency
 * - Accepte localCurrencySymbol OU localCurrencyCode/currencyTarget
 */
function normalizeInitiateBody(req, _res, next) {
  try {
    const b = req.body || {};

    // --- country / destinationCountry ---
    const cRaw =
      b.country ||
      b.destinationCountry ||
      b.countryTarget || // (au cas où)
      "";
    const c = String(cRaw || "").trim();
    if (c) {
      b.country = c;
      b.destinationCountry = c; // on garde les 2 pour compat, mais on valide UNE seule
    }

    // --- senderCurrencySymbol (ISO) ---
    const sCurRaw =
      b.senderCurrencySymbol ||
      b.senderCurrencyCode ||
      b.currencySource ||
      b.currencyCode ||
      b.currency ||
      "";
    const sCur = String(sCurRaw || "").trim();
    if (sCur) {
      b.senderCurrencySymbol = sCur.toUpperCase(); // ISO: XOF/CAD/EUR/USD
    }

    // --- localCurrencySymbol (ISO) ---
    const tCurRaw =
      b.localCurrencySymbol ||
      b.localCurrencyCode ||
      b.currencyTarget ||
      "";
    const tCur = String(tCurRaw || "").trim();
    if (tCur) {
      b.localCurrencySymbol = tCur.toUpperCase();
    }

    // --- amount fallback ---
    if (b.amount === undefined || b.amount === null || String(b.amount).trim() === "") {
      if (b.amountSource !== undefined && b.amountSource !== null) b.amount = b.amountSource;
    }

    req.body = b;
  } catch {
    // no-op
  }
  next();
}

/**
 * GET /api/v1/transactions/:id
 * Récupère une transaction par ID (mobile/web)
 */
router.get("/:id", protect, asyncHandler(getTransactionController));

/**
 * GET /api/v1/transactions
 * Liste toutes les transactions liées à l'utilisateur connecté
 */
router.get("/", protect, asyncHandler(listInternal));

/**
 * POST /api/v1/transactions/initiate
 * Crée une transaction interne (débit immédiat expéditeur)
 * → fees dynamiques via Gateway /fees/simulate
 */
router.post(
  "/initiate",
  protect,
  normalizeInitiateBody,
  [
    body("toEmail").isEmail().withMessage("Email du destinataire invalide").normalizeEmail(),

    body("amount").isFloat({ gt: 0 }).withMessage("Le montant doit être supérieur à 0").toFloat(),

    body("transactionFees").optional().isFloat({ min: 0 }).withMessage("Les frais doivent être un nombre positif").toFloat(),

    body("funds").notEmpty().withMessage("Type de fonds requis").trim().escape(),

    body("destination").notEmpty().withMessage("Destination requise").trim().escape(),

    // ✅ On valide localCurrencySymbol (normalisé depuis localCurrencyCode/currencyTarget)
    body("localCurrencySymbol").notEmpty().withMessage("Devise cible requise").trim().escape(),

    // ✅ On valide senderCurrencySymbol (normalisé depuis senderCurrencyCode/currencySource/currency)
    body("senderCurrencySymbol").notEmpty().withMessage("Devise source requise").trim().escape(),

    // ✅ IMPORTANT: on ne valide PLUS destinationCountry
    // On valide uniquement country (normalisé depuis destinationCountry si besoin)
    body("country").notEmpty().withMessage("Pays de destination requis").trim().escape(),

    body("description").optional().trim().escape(),

    body("recipientInfo.name").optional().trim().escape(),

    body("recipientInfo.email").isEmail().withMessage("Email du destinataire invalide").normalizeEmail(),

    body("question").notEmpty().withMessage("Question de sécurité requise").trim().escape(),

    body("securityCode").notEmpty().withMessage("Code de sécurité requis").trim().escape(),
  ],
  requestValidator,
  asyncHandler(initiateInternal)
);

/**
 * POST /api/v1/transactions/confirm
 * Confirme une transaction "pending" (crédite le destinataire après securityCode)
 */
router.post(
  "/confirm",
  protect,
  [
    body("transactionId").isMongoId().withMessage("ID de transaction invalide"),
    body("securityCode").notEmpty().withMessage("Code de sécurité requis").trim().escape(),

    // si ton mobile envoie provider, on garde
    body("provider").notEmpty().withMessage("Fournisseur requis").trim().escape(),
  ],
  requestValidator,
  asyncHandler(confirmController)
);

/**
 * POST /api/v1/transactions/cancel
 * Annule une transaction "pending" (remboursement)
 */
router.post(
  "/cancel",
  protect,
  [
    body("transactionId").isMongoId().withMessage("ID de transaction invalide"),
    body("reason").optional().isString().withMessage("Motif invalide").trim().escape(),
  ],
  requestValidator,
  asyncHandler(cancelController)
);

/**
 * POST /api/v1/transactions/refund
 * Rembourse une transaction confirmée (admin/superadmin ONLY)
 */
router.post(
  "/refund",
  protect,
  requireRole(["admin", "superadmin"]),
  [
    body("transactionId").isMongoId().withMessage("ID de transaction invalide"),
    body("reason").optional().trim().escape(),
  ],
  requestValidator,
  asyncHandler(refundController)
);

/**
 * POST /api/v1/transactions/validate
 * Valide une transaction (admin/superadmin ONLY)
 */
router.post(
  "/validate",
  protect,
  requireRole(["admin", "superadmin"]),
  [
    body("transactionId").isMongoId().withMessage("ID de transaction invalide"),
    body("status").notEmpty().isString().withMessage("Nouveau statut requis"),
    body("adminNote").optional().trim().escape(),
  ],
  requestValidator,
  asyncHandler(validateController)
);

/**
 * POST /api/v1/transactions/reassign
 * Réassigne la transaction à un autre destinataire (admin/superadmin ONLY)
 */
router.post(
  "/reassign",
  protect,
  requireRole(["admin", "superadmin"]),
  [
    body("transactionId").isMongoId().withMessage("ID de transaction invalide"),
    body("newReceiverEmail").isEmail().withMessage("Email du nouveau destinataire invalide").normalizeEmail(),
  ],
  requestValidator,
  asyncHandler(reassignController)
);

/**
 * POST /api/v1/transactions/archive
 */
router.post(
  "/archive",
  protect,
  requireRole(["admin", "superadmin"]),
  [body("transactionId").isMongoId().withMessage("ID de transaction invalide")],
  requestValidator,
  asyncHandler(archiveController)
);

/**
 * POST /api/v1/transactions/relaunch
 */
router.post(
  "/relaunch",
  protect,
  requireRole(["admin", "superadmin"]),
  [body("transactionId").isMongoId().withMessage("ID de transaction invalide")],
  requestValidator,
  asyncHandler(relaunchController)
);

module.exports = router;
