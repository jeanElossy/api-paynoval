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
const amlMiddleware = require("../middleware/aml");
const requireRole = require("../middleware/requireRole");
const requestValidator = require("../middleware/requestValidator");

const router = express.Router();

/* ---------------------------------------------------------- */
/* Rate limit (anti brute force)                              */
/* ---------------------------------------------------------- */
/**
 * ✅ IMPORTANT:
 * - On SKIP le rate-limit si l’appel vient du Gateway (x-internal-token)
 * - Parce que le Gateway peut rafraîchir /transactions souvent (home screen)
 *
 * Ton middleware protect gère déjà l’auth interne (si tu as appliqué la version corrigée).
 */
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
  skip: (req) => {
    // ✅ Skip si appel interne (Gateway / Principal)
    const t =
      req.headers["x-internal-token"] ||
      req.headers["X-Internal-Token"] ||
      req.headers["x-internal-token".toUpperCase()] ||
      "";
    return !!String(t || "").trim();
  },
});

// limiter seulement sur les endpoints sensibles
router.use(["/initiate", "/confirm", "/cancel"], limiter);

/* ---------------------------------------------------------- */
/* Helpers                                                    */
/* ---------------------------------------------------------- */
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

const MOBILEMONEY_PROVIDERS = ["wave", "orange", "mtn", "moov", "flutterwave"];

// ce que ton model Transaction accepte (enum)
const FUNDS_ALLOWED = [
  "paynoval",
  "stripe",
  "bank",
  "mobilemoney",
  "visa_direct",
  "stripe2momo",
  "cashin",
  "cashout",
];

const DEST_ALLOWED = [
  "paynoval",
  "stripe",
  "bank",
  "mobilemoney",
  "visa_direct",
  "stripe2momo",
  "cashin",
  "cashout",
];

/**
 * Normalise funds/destination:
 * - si on reçoit funds="wave|orange|mtn|moov|flutterwave" => funds="mobilemoney" + metadata.provider
 * - idem pour destination
 * - accepte aussi provider au top-level, et le pousse dans metadata.provider
 */
function normalizeProviderRails(b) {
  if (!b || typeof b !== "object") return b;

  // assure metadata objet
  if (!b.metadata || typeof b.metadata !== "object") b.metadata = {};

  // provider explicite (top-level ou metadata)
  const pRaw = pickFirst(b.provider, b.metadata.provider);
  const p = String(pRaw || "").trim().toLowerCase();
  if (p) b.metadata.provider = p;

  // normalize funds
  const fRaw = String(b.funds || "").trim().toLowerCase();
  if (MOBILEMONEY_PROVIDERS.includes(fRaw)) {
    b.funds = "mobilemoney";
    b.metadata.provider = b.metadata.provider || fRaw;
  }

  // normalize destination
  const dRaw = String(b.destination || "").trim().toLowerCase();
  if (MOBILEMONEY_PROVIDERS.includes(dRaw)) {
    b.destination = "mobilemoney";
    b.metadata.provider = b.metadata.provider || dRaw;
  }

  // ✅ expose aussi provider au top-level (compat)
  if (!b.provider && b.metadata.provider) b.provider = b.metadata.provider;

  return b;
}

/**
 * ✅ Normalisation payload initiate (NEW + LEGACY)
 */
function normalizeInitiateBody(req, _res, next) {
  try {
    const b = req.body || {};

    // provider rails normalization FIRST (avant validations)
    normalizeProviderRails(b);

    // amount
    const rawAmount = pickFirst(b.amount, b.amountSource);
    if (rawAmount !== "") b.amount = safeToFloat(rawAmount);

    // country
    const rawCountry = pickFirst(b.country, b.destinationCountry);
    if (rawCountry) {
      b.country = String(rawCountry).trim();
      if (!b.destinationCountry) b.destinationCountry = b.country; // alias compat
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
    const rawTgt = pickFirst(
      b.localCurrencySymbol,
      b.currencyTarget,
      b.localCurrencyCode
    );
    if (rawTgt) b.localCurrencySymbol = upISO(rawTgt);

    // security (NEW canonical)
    if (!b.securityQuestion) b.securityQuestion = pickFirst(b.securityQuestion, b.question);
    if (!b.securityAnswer) b.securityAnswer = pickFirst(b.securityAnswer, b.securityCode);

    req.body = b;
  } catch {
    // no-op
  }
  next();
}

/**
 * ✅ Normalisation payload confirm (NEW + LEGACY)
 */
function normalizeConfirmBody(req, _res, next) {
  try {
    const b = req.body || {};

    normalizeProviderRails(b);

    if (!b.securityAnswer) b.securityAnswer = pickFirst(b.securityAnswer, b.securityCode);

    req.body = b;
  } catch {
    // no-op
  }
  next();
}

/* ---------------------------------------------------------- */
/* Routes                                                     */
/* ---------------------------------------------------------- */

/**
 * GET /api/v1/transactions/:id
 */
router.get("/:id", protect, asyncHandler(getTransactionController));

/**
 * GET /api/v1/transactions
 */
router.get("/", protect, asyncHandler(listInternal));

/**
 * POST /api/v1/transactions/initiate
 * ✅ AML branché ici (après validations)
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

    body("funds")
      .notEmpty()
      .withMessage("Type de fonds requis")
      .custom((v) => {
        const vv = String(v || "").trim().toLowerCase();
        if (!FUNDS_ALLOWED.includes(vv)) throw new Error(`funds invalide (${v})`);
        return true;
      })
      .customSanitizer((v, { req }) => {
        req.body.funds = String(v || "").trim().toLowerCase();
        return req.body.funds;
      }),

    body("destination")
      .notEmpty()
      .withMessage("Destination requise")
      .custom((v) => {
        const vv = String(v || "").trim().toLowerCase();
        if (!DEST_ALLOWED.includes(vv)) throw new Error(`destination invalide (${v})`);
        return true;
      })
      .customSanitizer((v, { req }) => {
        req.body.destination = String(v || "").trim().toLowerCase();
        return req.body.destination;
      }),

    body("localCurrencySymbol")
      .custom((v) => {
        if (!String(v || "").trim()) throw new Error("Devise locale requise");
        return true;
      })
      .customSanitizer((v, { req }) => {
        req.body.localCurrencySymbol = upISO(v);
        return req.body.localCurrencySymbol;
      }),

    body("senderCurrencySymbol")
      .custom((v) => {
        if (!String(v || "").trim()) throw new Error("Devise expéditeur requise");
        return true;
      })
      .customSanitizer((v, { req }) => {
        req.body.senderCurrencySymbol = upISO(v);
        return req.body.senderCurrencySymbol;
      }),

    body("country")
      .custom((v) => {
        if (!String(v || "").trim()) throw new Error("Pays de destination requis");
        return true;
      })
      .customSanitizer((v, { req }) => {
        req.body.country = String(v || "").trim();
        if (!req.body.destinationCountry) req.body.destinationCountry = req.body.country;
        return req.body.country;
      }),

    body("description").optional().trim().escape(),
    body("recipientInfo.name").optional().trim().escape(),

    body("recipientInfo.email")
      .optional()
      .isEmail()
      .withMessage("Email destinataire invalide")
      .normalizeEmail(),

    body("securityQuestion")
      .custom((v) => {
        if (!String(v || "").trim()) throw new Error("securityQuestion requis");
        return true;
      })
      .trim()
      .escape(),

    body("securityAnswer")
      .custom((v) => {
        if (!String(v || "").trim()) throw new Error("securityAnswer requis");
        return true;
      })
      .trim()
      .escape(),

    body("metadata.provider")
      .optional()
      .custom((v) => {
        const vv = String(v || "").trim().toLowerCase();
        if (!vv) return true;
        if (!MOBILEMONEY_PROVIDERS.includes(vv)) {
          throw new Error("metadata.provider doit être wave|orange|mtn|moov|flutterwave");
        }
        return true;
      })
      .customSanitizer((v, { req }) => {
        if (!req.body.metadata || typeof req.body.metadata !== "object") req.body.metadata = {};
        req.body.metadata.provider = String(v || "").trim().toLowerCase();
        if (!req.body.provider) req.body.provider = req.body.metadata.provider;
        return req.body.metadata.provider;
      }),
  ],
  requestValidator,
  amlMiddleware,
  asyncHandler(initiateInternal)
);

/**
 * POST /api/v1/transactions/confirm
 */
router.post(
  "/confirm",
  protect,
  normalizeConfirmBody,
  [
    body("transactionId").isMongoId().withMessage("ID de transaction invalide"),

    body("securityAnswer")
      .custom((v) => {
        if (!String(v || "").trim()) throw new Error("securityAnswer requis");
        return true;
      })
      .trim()
      .escape(),

    body("metadata.provider")
      .optional()
      .custom((v) => {
        const vv = String(v || "").trim().toLowerCase();
        if (!vv) return true;
        if (!MOBILEMONEY_PROVIDERS.includes(vv)) {
          throw new Error("metadata.provider doit être wave|orange|mtn|moov|flutterwave");
        }
        return true;
      })
      .customSanitizer((v, { req }) => {
        if (!req.body.metadata || typeof req.body.metadata !== "object") req.body.metadata = {};
        req.body.metadata.provider = String(v || "").trim().toLowerCase();
        if (!req.body.provider) req.body.provider = req.body.metadata.provider;
        return req.body.metadata.provider;
      }),
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
    body("newReceiverEmail")
      .isEmail()
      .withMessage("Email du nouveau destinataire invalide")
      .normalizeEmail(),
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
