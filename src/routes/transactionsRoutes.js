// File: src/routes/transactionsRoutes.js
"use strict";

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
 * Helpers compat: NEW + LEGACY
 */
const pickFirst = (...vals) => {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
};

const safeToFloat = (v) => {
  const n =
    typeof v === "number"
      ? v
      : parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};

const upISO = (v) => String(v || "").trim().toUpperCase();

/**
 * ✅ Normalisation payload initiate (évite doubles erreurs)
 * - country <- country OR destinationCountry
 * - destinationCountry <- country (alias, optionnel)
 * - senderCurrencySymbol <- senderCurrencySymbol OR currencySource OR senderCurrencyCode OR currency OR currencyCode
 * - localCurrencySymbol <- localCurrencySymbol OR currencyTarget OR localCurrencyCode
 * - amount <- amount OR amountSource
 */
function normalizeInitiateBody(req, _res, next) {
  try {
    const b = req.body || {};

    // amount
    const rawAmount = pickFirst(b.amount, b.amountSource);
    if (rawAmount !== "") b.amount = safeToFloat(rawAmount);

    // country
    const rawCountry = pickFirst(b.country, b.destinationCountry);
    if (rawCountry) {
      b.country = String(rawCountry).trim();
      // on garde destinationCountry comme alias (utile côté gateway), mais on NE VALIDE PAS ce champ
      if (!b.destinationCountry) b.destinationCountry = b.country;
    }

    // sender currency (ISO)
    const rawSrc = pickFirst(
      b.senderCurrencySymbol,
      b.currencySource,
      b.senderCurrencyCode,
      b.currencyCode,
      b.currency
    );
    if (rawSrc) b.senderCurrencySymbol = upISO(rawSrc);

    // target currency (ISO)
    const rawTgt = pickFirst(b.localCurrencySymbol, b.currencyTarget, b.localCurrencyCode);
    if (rawTgt) b.localCurrencySymbol = upISO(rawTgt);

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
    body("toEmail")
      .isEmail()
      .withMessage("Email du destinataire invalide")
      .normalizeEmail(),

    // ✅ amount (déjà normalisé depuis amountSource si besoin)
    body("amount")
      .custom((v) => {
        const n = safeToFloat(v);
        if (!Number.isFinite(n) || n <= 0) throw new Error("Le montant doit être supérieur à 0");
        return true;
      })
      .customSanitizer((v, { req }) => {
        req.body.amount = safeToFloat(v);
        return req.body.amount;
      }),

    body("transactionFees")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Les frais doivent être un nombre positif")
      .toFloat(),

    body("funds")
      .notEmpty()
      .withMessage("Type de fonds requis")
      .trim()
      .escape(),

    body("destination")
      .notEmpty()
      .withMessage("Destination requise")
      .trim()
      .escape(),

    // ✅ localCurrencySymbol (déjà normalisé depuis currencyTarget/localCurrencyCode)
    body("localCurrencySymbol")
      .custom((v) => {
        if (!String(v || "").trim()) throw new Error("Symbole de la devise locale requis");
        return true;
      })
      .customSanitizer((v, { req }) => {
        req.body.localCurrencySymbol = upISO(v);
        return req.body.localCurrencySymbol;
      }),

    // ✅ senderCurrencySymbol (déjà normalisé depuis currencySource/senderCurrencyCode/currency)
    body("senderCurrencySymbol")
      .custom((v) => {
        if (!String(v || "").trim()) throw new Error("Symbole de la devise de l’expéditeur requis");
        return true;
      })
      .customSanitizer((v, { req }) => {
        req.body.senderCurrencySymbol = upISO(v);
        return req.body.senderCurrencySymbol;
      }),

    // ✅ country (déjà normalisé depuis destinationCountry)
    body("country")
      .custom((v) => {
        if (!String(v || "").trim()) throw new Error("Pays de destination requis");
        return true;
      })
      .customSanitizer((v, { req }) => {
        req.body.country = String(v || "").trim();
        // alias compat
        if (!req.body.destinationCountry) req.body.destinationCountry = req.body.country;
        return req.body.country;
      }),

    body("description").optional().trim().escape(),
    body("recipientInfo.name").optional().trim().escape(),

    // ✅ recipientInfo.email optional (car tu as déjà toEmail)
    body("recipientInfo.email")
      .optional()
      .isEmail()
      .withMessage("Email du destinataire invalide")
      .normalizeEmail(),

    body("question")
      .notEmpty()
      .withMessage("Question de sécurité requise")
      .trim()
      .escape(),

    body("securityCode")
      .notEmpty()
      .withMessage("Code de sécurité requis")
      .trim()
      .escape(),
  ],
  requestValidator,
  asyncHandler(initiateInternal)
);

/**
 * POST /api/v1/transactions/confirm
 */
router.post(
  "/confirm",
  protect,
  [
    body("transactionId").isMongoId().withMessage("ID de transaction invalide"),
    body("securityCode").notEmpty().withMessage("Code de sécurité requis").trim().escape(),
    body("provider").optional().trim().escape(),
  ],
  requestValidator,
  asyncHandler(confirmController)
);

/**
 * POST /api/v1/transactions/cancel
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
 * POST /api/v1/transactions/refund (admin)
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
 * POST /api/v1/transactions/validate (admin)
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
 * POST /api/v1/transactions/reassign (admin)
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
 * POST /api/v1/transactions/archive (admin)
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
 * POST /api/v1/transactions/relaunch (admin)
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
