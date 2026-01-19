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
 * Helpers compat: NEW + LEGACY
 */
const pickFirst = (...vals) => {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
};

const safeToFloat = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};

/**
 * POST /api/v1/transactions/initiate
 * Crée une transaction interne (débit immédiat expéditeur)
 * → fees dynamiques via Gateway /fees/simulate
 */
router.post(
  "/initiate",
  protect,
  [
    body("toEmail")
      .isEmail()
      .withMessage("Email du destinataire invalide")
      .normalizeEmail(),

    // ✅ amount OU amountSource (compat)
    body(["amount", "amountSource"])
      .custom((_, { req }) => {
        const raw = pickFirst(req.body?.amount, req.body?.amountSource);
        const n = safeToFloat(raw);
        if (!Number.isFinite(n) || n <= 0) throw new Error("Le montant doit être supérieur à 0");
        return true;
      })
      .customSanitizer((_, { req }) => {
        // on normalize: on fixe req.body.amount pour le controller legacy
        const raw = pickFirst(req.body?.amount, req.body?.amountSource);
        req.body.amount = safeToFloat(raw);
        return req.body.amount;
      }),

    body("transactionFees")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Les frais doivent être un nombre positif")
      .toFloat(),

    body("funds").notEmpty().withMessage("Type de fonds requis").trim().escape(),

    body("destination")
      .notEmpty()
      .withMessage("Destination requise")
      .trim()
      .escape(),

    // ✅ local currency: accepte localCurrencySymbol OU currencyTarget/localCurrencyCode
    body(["localCurrencySymbol", "currencyTarget", "localCurrencyCode"])
      .custom((_, { req }) => {
        const v = pickFirst(req.body?.localCurrencySymbol, req.body?.currencyTarget, req.body?.localCurrencyCode);
        if (!String(v).trim()) throw new Error("Symbole de la devise locale requis");
        return true;
      })
      .customSanitizer((_, { req }) => {
        const v = pickFirst(req.body?.localCurrencySymbol, req.body?.currencyTarget, req.body?.localCurrencyCode);
        // on force localCurrencySymbol pour legacy controller
        req.body.localCurrencySymbol = String(v).trim();
        return req.body.localCurrencySymbol;
      }),

    // ✅ sender currency: accepte senderCurrencySymbol OU currencySource/senderCurrencyCode/currency
    body(["senderCurrencySymbol", "currencySource", "senderCurrencyCode", "currency"])
      .custom((_, { req }) => {
        const v = pickFirst(
          req.body?.senderCurrencySymbol,
          req.body?.currencySource,
          req.body?.senderCurrencyCode,
          req.body?.currency
        );
        if (!String(v).trim()) throw new Error("Symbole de la devise de l’expéditeur requis");
        return true;
      })
      .customSanitizer((_, { req }) => {
        const v = pickFirst(
          req.body?.senderCurrencySymbol,
          req.body?.currencySource,
          req.body?.senderCurrencyCode,
          req.body?.currency
        );
        // on force senderCurrencySymbol pour legacy controller
        req.body.senderCurrencySymbol = String(v).trim();
        return req.body.senderCurrencySymbol;
      }),

    // ✅ country: accepte country OU destinationCountry
    body(["country", "destinationCountry"])
      .custom((_, { req }) => {
        const c = pickFirst(req.body?.country, req.body?.destinationCountry);
        if (!String(c).trim()) throw new Error("Pays de destination requis");
        return true;
      })
      .customSanitizer((_, { req }) => {
        const c = pickFirst(req.body?.country, req.body?.destinationCountry);
        req.body.country = String(c).trim();
        return req.body.country;
      }),

    body("description").optional().trim().escape(),
    body("recipientInfo.name").optional().trim().escape(),

    // ✅ recipientInfo.email devient optional (car tu as déjà toEmail)
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
    body("securityCode")
      .notEmpty()
      .withMessage("Code de sécurité requis")
      .trim()
      .escape(),
    body("provider")
      .optional()
      .trim()
      .escape(),
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
  [body("transactionId").isMongoId().withMessage("ID de transaction invalide"), body("reason").optional().trim().escape()],
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
