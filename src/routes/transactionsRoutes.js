// // File: src/routes/transactionsRoutes.js
// "use strict";

// const express = require("express");
// const rateLimit = require("express-rate-limit");
// const { body } = require("express-validator");
// const asyncHandler = require("express-async-handler");

// const {
//   listInternal,
//   initiateInternal,
//   confirmController,
//   cancelController,
//   getTransactionController,
//   refundController,
//   validateController,
//   reassignController,
//   archiveController,
//   relaunchController,
// } = require("../controllers/transactionsController");

// const { protect } = require("../middleware/authMiddleware");
// const amlMiddleware = require("../middleware/aml");
// const requireRole = require("../middleware/requireRole");
// const requestValidator = require("../middleware/requestValidator");

// const router = express.Router();

// /* ---------------------------------------------------------- */
// /* Helpers                                                    */
// /* ---------------------------------------------------------- */
// const pickFirst = (...vals) => {
//   for (const v of vals) {
//     if (v !== undefined && v !== null && String(v).trim() !== "") return v;
//   }
//   return "";
// };

// const safeToFloat = (v) => {
//   const n =
//     typeof v === "number"
//       ? v
//       : parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
//   return Number.isFinite(n) ? n : NaN;
// };

// const upISO = (v) => String(v || "").trim().toUpperCase();

// const MOBILEMONEY_PROVIDERS = ["wave", "orange", "mtn", "moov", "flutterwave"];
// const isMMProvider = (v) =>
//   MOBILEMONEY_PROVIDERS.includes(String(v || "").trim().toLowerCase());

// // ce que ton model Transaction accepte (enum)
// const FUNDS_ALLOWED = [
//   "paynoval",
//   "stripe",
//   "bank",
//   "mobilemoney",
//   "visa_direct",
//   "stripe2momo",
//   "cashin",
//   "cashout",
// ];

// const DEST_ALLOWED = [
//   "paynoval",
//   "stripe",
//   "bank",
//   "mobilemoney",
//   "visa_direct",
//   "stripe2momo",
//   "cashin",
//   "cashout",
// ];

// /* ---------------------------------------------------------- */
// /* Rate limit (anti brute force)                              */
// /* ---------------------------------------------------------- */
// /**
//  * ✅ IMPORTANT:
//  * - On SKIP le rate-limit si l’appel vient d’un appel interne (Gateway/Principal)
//  * - Node lower-case automatiquement les headers => req.get() est case-insensitive
//  */
// const limiter = rateLimit({
//   windowMs: 60 * 1000, // 1 minute
//   max: 10,
//   standardHeaders: true,
//   legacyHeaders: false,
//   message: {
//     success: false,
//     status: 429,
//     message: "Trop de requêtes, veuillez réessayer plus tard.",
//   },
//   skip: (req) => {
//     const t = req.get("x-internal-token");
//     return !!String(t || "").trim();
//   },
// });

// // limiter seulement sur les endpoints sensibles
// router.use(["/initiate", "/confirm", "/cancel"], limiter);

// /* ---------------------------------------------------------- */
// /* Normalisation provider rails                               */
// /* ---------------------------------------------------------- */
// /**
//  * Normalise funds/destination:
//  * - si on reçoit funds="wave|orange|mtn|moov|flutterwave" => funds="mobilemoney" + metadata.provider
//  * - idem pour destination
//  * - accepte provider au top-level, et le pousse dans metadata.provider
//  */
// function normalizeProviderRails(b) {
//   if (!b || typeof b !== "object") return b;

//   // assure metadata objet
//   if (!b.metadata || typeof b.metadata !== "object") b.metadata = {};

//   // provider explicite (top-level ou metadata)
//   const pRaw = pickFirst(b.provider, b.metadata.provider, b.mmProvider, b.operator, b.providerSelected);
//   const p = String(pRaw || "").trim().toLowerCase();
//   if (p) b.metadata.provider = p;

//   // normalize funds
//   const fRaw = String(b.funds || "").trim().toLowerCase();
//   if (isMMProvider(fRaw)) {
//     b.funds = "mobilemoney";
//     b.metadata.provider = b.metadata.provider || fRaw;
//   }

//   // normalize destination
//   const dRaw = String(b.destination || "").trim().toLowerCase();
//   if (isMMProvider(dRaw)) {
//     b.destination = "mobilemoney";
//     b.metadata.provider = b.metadata.provider || dRaw;
//   }

//   // ✅ expose aussi provider au top-level (compat)
//   if (!b.provider && b.metadata.provider) b.provider = b.metadata.provider;

//   return b;
// }

// /**
//  * ✅ Normalisation payload initiate (NEW + LEGACY)
//  */
// function normalizeInitiateBody(req, _res, next) {
//   try {
//     const b = req.body || {};

//     // provider rails normalization FIRST (avant validations)
//     normalizeProviderRails(b);

//     // amount
//     const rawAmount = pickFirst(b.amount, b.amountSource, b.fundsAmount, b.value);
//     if (rawAmount !== "") b.amount = safeToFloat(rawAmount);

//     // country
//     const rawCountry = pickFirst(b.country, b.destinationCountry);
//     if (rawCountry) {
//       b.country = String(rawCountry).trim();
//       if (!b.destinationCountry) b.destinationCountry = b.country; // alias compat
//     }

//     // sender currency (ISO)
//     const rawSrc = pickFirst(
//       b.senderCurrencySymbol,
//       b.currencySource,
//       b.senderCurrencyCode,
//       b.currencyCode,
//       b.currency
//     );
//     if (rawSrc) b.senderCurrencySymbol = upISO(rawSrc);

//     // target currency (ISO)
//     const rawTgt = pickFirst(
//       b.localCurrencySymbol,
//       b.currencyTarget,
//       b.localCurrencyCode
//     );
//     if (rawTgt) b.localCurrencySymbol = upISO(rawTgt);

//     // security (NEW canonical) + legacy aliases
//     b.securityQuestion = pickFirst(b.securityQuestion, b.question, b.validationQuestion);
//     b.securityAnswer = pickFirst(b.securityAnswer, b.securityCode, b.validationCode);

//     req.body = b;
//   } catch {
//     // no-op
//   }
//   next();
// }

// /**
//  * ✅ Normalisation payload confirm (NEW + LEGACY)
//  */
// function normalizeConfirmBody(req, _res, next) {
//   try {
//     const b = req.body || {};

//     normalizeProviderRails(b);

//     b.securityAnswer = pickFirst(b.securityAnswer, b.securityCode, b.validationCode);

//     req.body = b;
//   } catch {
//     // no-op
//   }
//   next();
// }

// /* ---------------------------------------------------------- */
// /* Routes                                                     */
// /* ---------------------------------------------------------- */

// /**
//  * GET /api/v1/transactions/:id
//  */
// router.get("/:id", protect, asyncHandler(getTransactionController));

// /**
//  * GET /api/v1/transactions
//  */
// router.get("/", protect, asyncHandler(listInternal));

// /**
//  * POST /api/v1/transactions/initiate
//  * ✅ AML branché ici (après validations)
//  */
// router.post(
//   "/initiate",
//   protect,
//   normalizeInitiateBody,
//   [
//     body("toEmail")
//       .isEmail()
//       .withMessage("Email du destinataire invalide")
//       .normalizeEmail(),

//     body("amount")
//       .custom((v, { req }) => {
//         const n = safeToFloat(v ?? req.body?.amount);
//         if (!Number.isFinite(n) || n <= 0) {
//           throw new Error("Le montant doit être supérieur à 0");
//         }
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         req.body.amount = safeToFloat(v);
//         return req.body.amount;
//       }),

//     body("funds")
//       .notEmpty()
//       .withMessage("Type de fonds requis")
//       .custom((v) => {
//         const vv = String(v || "").trim().toLowerCase();
//         if (!FUNDS_ALLOWED.includes(vv)) throw new Error(`funds invalide (${v})`);
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         req.body.funds = String(v || "").trim().toLowerCase();
//         return req.body.funds;
//       }),

//     body("destination")
//       .notEmpty()
//       .withMessage("Destination requise")
//       .custom((v) => {
//         const vv = String(v || "").trim().toLowerCase();
//         if (!DEST_ALLOWED.includes(vv)) throw new Error(`destination invalide (${v})`);
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         req.body.destination = String(v || "").trim().toLowerCase();
//         return req.body.destination;
//       }),

//     // ✅ provider obligatoire SI mobilemoney est impliqué
//     body("metadata.provider")
//       .custom((v, { req }) => {
//         const funds = String(req.body?.funds || "").toLowerCase();
//         const dest = String(req.body?.destination || "").toLowerCase();
//         const needs = funds === "mobilemoney" || dest === "mobilemoney";

//         const vv = String(v || req.body?.provider || "").trim().toLowerCase();

//         if (!needs) return true;
//         if (!vv) {
//           throw new Error("metadata.provider requis pour mobilemoney (wave|orange|mtn|moov|flutterwave)");
//         }
//         if (!isMMProvider(vv)) {
//           throw new Error("metadata.provider doit être wave|orange|mtn|moov|flutterwave");
//         }
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         if (!req.body.metadata || typeof req.body.metadata !== "object") req.body.metadata = {};
//         const vv = String(v || req.body?.provider || "").trim().toLowerCase();
//         if (vv) req.body.metadata.provider = vv;
//         if (!req.body.provider && req.body.metadata.provider) req.body.provider = req.body.metadata.provider;
//         return req.body.metadata.provider;
//       }),

//     body("localCurrencySymbol")
//       .custom((v) => {
//         if (!String(v || "").trim()) throw new Error("Devise locale requise");
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         req.body.localCurrencySymbol = upISO(v);
//         return req.body.localCurrencySymbol;
//       }),

//     body("senderCurrencySymbol")
//       .custom((v) => {
//         if (!String(v || "").trim()) throw new Error("Devise expéditeur requise");
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         req.body.senderCurrencySymbol = upISO(v);
//         return req.body.senderCurrencySymbol;
//       }),

//     body("country")
//       .custom((v) => {
//         if (!String(v || "").trim()) throw new Error("Pays de destination requis");
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         req.body.country = String(v || "").trim();
//         if (!req.body.destinationCountry) req.body.destinationCountry = req.body.country;
//         return req.body.country;
//       }),

//     body("description").optional().trim().escape(),
//     body("recipientInfo.name").optional().trim().escape(),

//     body("recipientInfo.email")
//       .optional()
//       .isEmail()
//       .withMessage("Email destinataire invalide")
//       .normalizeEmail(),

//     body("securityQuestion")
//       .custom((v, { req }) => {
//         const vv = pickFirst(v, req.body?.question, req.body?.validationQuestion);
//         if (!String(vv || "").trim()) throw new Error("securityQuestion requis");
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         req.body.securityQuestion = pickFirst(v, req.body?.question, req.body?.validationQuestion).trim();
//         return req.body.securityQuestion;
//       })
//       .trim()
//       .escape(),

//     body("securityAnswer")
//       .custom((v, { req }) => {
//         const vv = pickFirst(v, req.body?.securityCode, req.body?.validationCode);
//         if (!String(vv || "").trim()) throw new Error("securityAnswer requis");
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         req.body.securityAnswer = pickFirst(v, req.body?.securityCode, req.body?.validationCode).trim();
//         return req.body.securityAnswer;
//       })
//       .trim()
//       .escape(),
//   ],
//   requestValidator,
//   amlMiddleware,
//   asyncHandler(initiateInternal)
// );

// /**
//  * POST /api/v1/transactions/confirm
//  */
// router.post(
//   "/confirm",
//   protect,
//   normalizeConfirmBody,
//   [
//     body("transactionId").isMongoId().withMessage("ID de transaction invalide"),

//     body("securityAnswer")
//       .custom((v, { req }) => {
//         const vv = pickFirst(v, req.body?.securityCode, req.body?.validationCode);
//         if (!String(vv || "").trim()) throw new Error("securityAnswer requis");
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         req.body.securityAnswer = pickFirst(v, req.body?.securityCode, req.body?.validationCode).trim();
//         return req.body.securityAnswer;
//       })
//       .trim()
//       .escape(),

//     // ✅ provider obligatoire SI mobilemoney est impliqué (confirm aussi)
//     body("metadata.provider")
//       .custom((v, { req }) => {
//         const funds = String(req.body?.funds || "").toLowerCase();
//         const dest = String(req.body?.destination || "").toLowerCase();
//         const needs = funds === "mobilemoney" || dest === "mobilemoney";

//         const vv = String(v || req.body?.provider || "").trim().toLowerCase();

//         if (!needs) return true;
//         if (!vv) {
//           throw new Error("metadata.provider requis pour mobilemoney (wave|orange|mtn|moov|flutterwave)");
//         }
//         if (!isMMProvider(vv)) {
//           throw new Error("metadata.provider doit être wave|orange|mtn|moov|flutterwave");
//         }
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         if (!req.body.metadata || typeof req.body.metadata !== "object") req.body.metadata = {};
//         const vv = String(v || req.body?.provider || "").trim().toLowerCase();
//         if (vv) req.body.metadata.provider = vv;
//         if (!req.body.provider && req.body.metadata.provider) req.body.provider = req.body.metadata.provider;
//         return req.body.metadata.provider;
//       }),
//   ],
//   requestValidator,
//   asyncHandler(confirmController)
// );

// /**
//  * POST /api/v1/transactions/cancel
//  */
// router.post(
//   "/cancel",
//   protect,
//   [
//     body("transactionId").isMongoId().withMessage("ID de transaction invalide"),
//     body("reason").optional().isString().withMessage("Motif invalide").trim().escape(),
//   ],
//   requestValidator,
//   asyncHandler(cancelController)
// );

// /**
//  * POST /api/v1/transactions/refund (admin)
//  */
// router.post(
//   "/refund",
//   protect,
//   requireRole(["admin", "superadmin"]),
//   [
//     body("transactionId").isMongoId().withMessage("ID de transaction invalide"),
//     body("reason").optional().trim().escape(),
//   ],
//   requestValidator,
//   asyncHandler(refundController)
// );

// /**
//  * POST /api/v1/transactions/validate (admin)
//  */
// router.post(
//   "/validate",
//   protect,
//   requireRole(["admin", "superadmin"]),
//   [
//     body("transactionId").isMongoId().withMessage("ID de transaction invalide"),
//     body("status").notEmpty().isString().withMessage("Nouveau statut requis"),
//     body("adminNote").optional().trim().escape(),
//   ],
//   requestValidator,
//   asyncHandler(validateController)
// );

// /**
//  * POST /api/v1/transactions/reassign (admin)
//  */
// router.post(
//   "/reassign",
//   protect,
//   requireRole(["admin", "superadmin"]),
//   [
//     body("transactionId").isMongoId().withMessage("ID de transaction invalide"),
//     body("newReceiverEmail")
//       .isEmail()
//       .withMessage("Email du nouveau destinataire invalide")
//       .normalizeEmail(),
//   ],
//   requestValidator,
//   asyncHandler(reassignController)
// );

// /**
//  * POST /api/v1/transactions/archive (admin)
//  */
// router.post(
//   "/archive",
//   protect,
//   requireRole(["admin", "superadmin"]),
//   [body("transactionId").isMongoId().withMessage("ID de transaction invalide")],
//   requestValidator,
//   asyncHandler(archiveController)
// );

// /**
//  * POST /api/v1/transactions/relaunch (admin)
//  */
// router.post(
//   "/relaunch",
//   protect,
//   requireRole(["admin", "superadmin"]),
//   [body("transactionId").isMongoId().withMessage("ID de transaction invalide")],
//   requestValidator,
//   asyncHandler(relaunchController)
// );

// module.exports = router;





"use strict";

/**
 * --------------------------------------------------------------------------
 * Routes Transactions (TX Core / PayNoval service)
 * --------------------------------------------------------------------------
 * Ce routeur couvre actuellement :
 * - lecture transaction
 * - liste transaction
 * - initiate interne PayNoval -> PayNoval
 * - confirm/cancel du flow interne existant
 * - actions admin
 *
 * IMPORTANT :
 * - ce fichier est maintenant mieux durci et préparé
 * - mais les flows externes (mobile money / bank / card) doivent avoir
 *   des controllers dédiés et ne doivent PAS réutiliser aveuglément
 *   confirm/cancel interne
 * --------------------------------------------------------------------------
 */

const express = require("express");
const rateLimit = require("express-rate-limit");
const { body, param, query } = require("express-validator");
const asyncHandler = require("express-async-handler");

const {
  listInternal,
  initiateByFlow,
  confirmController,
  cancelController,
  getTransactionController,
  refundController,
  validateController,
  reassignController,
  archiveController,
  relaunchController,
  settleExternalTransactionWebhook,
} = require("../controllers/transactionsController");

const { protect } = require("../middleware/authMiddleware");
const amlMiddleware = require("../middleware/aml");
const requireRole = require("../middleware/requireRole");
const requestValidator = require("../middleware/requestValidator");

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* Constantes                                                                 */
/* -------------------------------------------------------------------------- */

const MOBILEMONEY_PROVIDERS = ["wave", "orange", "mtn", "moov", "flutterwave"];

const RAILS_ALLOWED = [
  "paynoval",
  "stripe",
  "bank",
  "mobilemoney",
  "visa_direct",
  "stripe2momo",
  "cashin",
  "cashout",
];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

function safeToFloat(v) {
  const n =
    typeof v === "number"
      ? v
      : parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function upISO(v) {
  return String(v || "").trim().toUpperCase();
}

function low(v) {
  return String(v || "").trim().toLowerCase();
}

function isMMProvider(v) {
  return MOBILEMONEY_PROVIDERS.includes(low(v));
}

function ensureMetadata(body) {
  if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
    body.metadata = {};
  }
  return body.metadata;
}

/* -------------------------------------------------------------------------- */
/* Rate limit                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Rate-limit sur actions sensibles.
 * Le bypass via x-internal-token est autorisé uniquement pour trafic serveur
 * interne maîtrisé.
 */
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    status: 429,
    message: "Trop de requêtes, veuillez réessayer plus tard.",
  },
  skip: (req) => {
    const t = req.get("x-internal-token");
    return !!String(t || "").trim();
  },
});

router.use(["/initiate", "/confirm", "/cancel"], sensitiveLimiter);

/* -------------------------------------------------------------------------- */
/* Middlewares de normalisation                                               */
/* -------------------------------------------------------------------------- */

/**
 * Normalise les rails/provider mobile money :
 * - funds=wave => funds=mobilemoney + metadata.provider=wave
 * - destination=orange => destination=mobilemoney + metadata.provider=orange
 * - provider top-level => poussé dans metadata.provider
 */
function normalizeProviderRails(req, _res, next) {
  try {
    const b = req.body || {};
    const metadata = ensureMetadata(b);

    const explicitProvider = low(
      pickFirst(
        b.provider,
        metadata.provider,
        b.mmProvider,
        b.operator,
        b.providerSelected
      )
    );

    if (explicitProvider) {
      metadata.provider = explicitProvider;
      b.provider = explicitProvider;
    }

    const fundsRaw = low(b.funds);
    if (isMMProvider(fundsRaw)) {
      b.funds = "mobilemoney";
      metadata.provider = metadata.provider || fundsRaw;
      b.provider = b.provider || metadata.provider;
    }

    const destinationRaw = low(b.destination);
    if (isMMProvider(destinationRaw)) {
      b.destination = "mobilemoney";
      metadata.provider = metadata.provider || destinationRaw;
      b.provider = b.provider || metadata.provider;
    }

    req.body = b;
  } catch {
    // no-op volontaire
  }

  next();
}

/**
 * Normalisation payload initiate.
 * Cette normalisation n’exécute aucune logique métier :
 * elle harmonise seulement les champs entrants.
 */
function normalizeInitiateBody(req, _res, next) {
  try {
    const b = req.body || {};

    const rawAmount = pickFirst(b.amount, b.amountSource, b.fundsAmount, b.value);
    if (rawAmount !== "") {
      b.amount = safeToFloat(rawAmount);
    }

    const rawCountry = pickFirst(
      b.country,
      b.destinationCountry,
      b.toCountry,
      req.user?.selectedCountry,
      req.user?.country
    );
    if (rawCountry) {
      b.country = String(rawCountry).trim();

      if (!b.destinationCountry) b.destinationCountry = b.country;
      if (!b.toCountry) b.toCountry = b.destinationCountry || b.country;
      if (!b.fromCountry) {
        b.fromCountry = req.user?.selectedCountry || req.user?.country || b.country;
      }
    }

    const rawSrc = pickFirst(
      b.senderCurrencyCode,
      b.currencySource,
      b.senderCurrencySymbol,
      b.currencyCode,
      b.fromCurrency,
      b.currency
    );

    if (rawSrc) {
      const cur = upISO(rawSrc);
      b.senderCurrencyCode = cur;
      b.currencySource = cur;
      b.senderCurrencySymbol = cur;
      if (!b.fromCurrency) b.fromCurrency = cur;
    }

    const rawTgt = pickFirst(
      b.localCurrencyCode,
      b.currencyTarget,
      b.localCurrencySymbol,
      b.toCurrency
    );

    if (rawTgt) {
      const cur = upISO(rawTgt);
      b.localCurrencyCode = cur;
      b.currencyTarget = cur;
      b.localCurrencySymbol = cur;
      if (!b.toCurrency) b.toCurrency = cur;
    }

    b.securityQuestion = pickFirst(
      b.securityQuestion,
      b.question,
      b.validationQuestion
    );

    b.securityAnswer = pickFirst(
      b.securityAnswer,
      b.securityCode,
      b.validationCode
    );

    if (!b.method) {
      if (low(b.funds) === "mobilemoney" || low(b.destination) === "mobilemoney") {
        b.method = "MOBILEMONEY";
      } else if (low(b.destination) === "paynoval") {
        b.method = "INTERNAL";
      }
    }

    if (!b.txType) {
      const action = low(b.action);
      if (action === "deposit") b.txType = "DEPOSIT";
      else if (action === "withdraw") b.txType = "WITHDRAW";
      else b.txType = "TRANSFER";
    }

    req.body = b;
  } catch {
    // no-op volontaire
  }

  next();
}

/**
 * Normalisation payload confirm.
 */
function normalizeConfirmBody(req, _res, next) {
  try {
    const b = req.body || {};

    b.securityAnswer = pickFirst(
      b.securityAnswer,
      b.securityCode,
      b.validationCode
    );

    req.body = b;
  } catch {
    // no-op volontaire
  }

  next();
}

/* -------------------------------------------------------------------------- */
/* Validators communs                                                         */
/* -------------------------------------------------------------------------- */

const txIdValidator = body("transactionId")
  .isMongoId()
  .withMessage("ID de transaction invalide");

const metadataProviderValidator = body("metadata.provider")
  .optional({ nullable: true })
  .custom((v, { req }) => {
    const funds = low(req.body?.funds);
    const dest = low(req.body?.destination);
    const needs = funds === "mobilemoney" || dest === "mobilemoney";

    const vv = low(v || req.body?.provider);

    if (!needs) return true;

    if (!vv) {
      throw new Error(
        "metadata.provider requis pour mobilemoney (wave|orange|mtn|moov|flutterwave)"
      );
    }

    if (!isMMProvider(vv)) {
      throw new Error("metadata.provider doit être wave|orange|mtn|moov|flutterwave");
    }

    return true;
  })
  .customSanitizer((v, { req }) => {
    const metadata = ensureMetadata(req.body);
    const vv = low(v || req.body?.provider);
    if (vv) {
      metadata.provider = vv;
      req.body.provider = vv;
    }
    return metadata.provider || null;
  });

const amountValidator = body("amount")
  .custom((v, { req }) => {
    const n = safeToFloat(v ?? req.body?.amount);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("Le montant doit être supérieur à 0");
    }
    return true;
  })
  .customSanitizer((v, { req }) => {
    req.body.amount = safeToFloat(v);
    return req.body.amount;
  });

const railFundsValidator = body("funds")
  .notEmpty()
  .withMessage("Type de fonds requis")
  .custom((v) => {
    const vv = low(v);
    if (!RAILS_ALLOWED.includes(vv)) {
      throw new Error(`funds invalide (${v})`);
    }
    return true;
  })
  .customSanitizer((v, { req }) => {
    req.body.funds = low(v);
    return req.body.funds;
  });

const railDestinationValidator = body("destination")
  .notEmpty()
  .withMessage("Destination requise")
  .custom((v) => {
    const vv = low(v);
    if (!RAILS_ALLOWED.includes(vv)) {
      throw new Error(`destination invalide (${v})`);
    }
    return true;
  })
  .customSanitizer((v, { req }) => {
    req.body.destination = low(v);
    return req.body.destination;
  });

/* -------------------------------------------------------------------------- */
/* Routes lecture                                                             */
/* -------------------------------------------------------------------------- */

router.get(
  "/:id",
  protect,
  [param("id").isMongoId().withMessage("ID de transaction invalide")],
  requestValidator,
  asyncHandler(getTransactionController)
);

router.get(
  "/",
  protect,
  [
    query("skip").optional().isInt({ min: 0 }).withMessage("skip invalide"),
    query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit invalide"),
  ],
  requestValidator,
  asyncHandler(listInternal)
);

/* -------------------------------------------------------------------------- */
/* Initiate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * NOTE :
 * Cette route appelle encore initiateInternal.
 * Donc, à ce stade, elle reste stricte pour le flow interne PayNoval -> PayNoval.
 * Les flows externes devront avoir des controllers dédiés plus tard.
 */
// router.post(
//   "/initiate",
//   protect,
//   normalizeProviderRails,
//   normalizeInitiateBody,
//   [
//     body("toEmail")
//       .isEmail()
//       .withMessage("Email du destinataire invalide")
//       .normalizeEmail(),

//     amountValidator,
//     railFundsValidator,
//     railDestinationValidator,
//     metadataProviderValidator,

//     body("localCurrencySymbol")
//       .custom((v) => {
//         if (!String(v || "").trim()) throw new Error("Devise locale requise");
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         const cur = upISO(v);
//         req.body.localCurrencySymbol = cur;
//         req.body.localCurrencyCode = cur;
//         req.body.currencyTarget = cur;
//         if (!req.body.toCurrency) req.body.toCurrency = cur;
//         return cur;
//       }),

//     body("senderCurrencySymbol")
//       .custom((v) => {
//         if (!String(v || "").trim()) throw new Error("Devise expéditeur requise");
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         const cur = upISO(v);
//         req.body.senderCurrencySymbol = cur;
//         req.body.senderCurrencyCode = cur;
//         req.body.currencySource = cur;
//         if (!req.body.fromCurrency) req.body.fromCurrency = cur;
//         return cur;
//       }),

//     body("country")
//       .custom((v) => {
//         if (!String(v || "").trim()) throw new Error("Pays requis");
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         req.body.country = String(v || "").trim();
//         if (!req.body.destinationCountry) req.body.destinationCountry = req.body.country;
//         if (!req.body.toCountry) req.body.toCountry = req.body.destinationCountry || req.body.country;
//         if (!req.body.fromCountry) {
//           req.body.fromCountry = req.user?.selectedCountry || req.user?.country || req.body.country;
//         }
//         return req.body.country;
//       }),

//     body("description").optional().isString().trim().escape(),
//     body("recipientInfo.name").optional().isString().trim().escape(),

//     body("recipientInfo.email")
//       .optional()
//       .isEmail()
//       .withMessage("Email destinataire invalide")
//       .normalizeEmail(),

//     body("securityQuestion")
//       .custom((v, { req }) => {
//         const vv = pickFirst(v, req.body?.question, req.body?.validationQuestion);
//         if (!String(vv || "").trim()) throw new Error("securityQuestion requis");
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         req.body.securityQuestion = pickFirst(
//           v,
//           req.body?.question,
//           req.body?.validationQuestion
//         ).trim();
//         return req.body.securityQuestion;
//       })
//       .trim()
//       .escape(),

//     body("securityAnswer")
//       .custom((v, { req }) => {
//         const vv = pickFirst(v, req.body?.securityCode, req.body?.validationCode);
//         if (!String(vv || "").trim()) throw new Error("securityAnswer requis");
//         return true;
//       })
//       .customSanitizer((v, { req }) => {
//         req.body.securityAnswer = pickFirst(
//           v,
//           req.body?.securityCode,
//           req.body?.validationCode
//         ).trim();
//         return req.body.securityAnswer;
//       })
//       .trim()
//       .escape(),
//   ],
//   requestValidator,
//   amlMiddleware,
//   asyncHandler(initiateInternal)
// );


router.post(
  "/initiate",
  protect,
  normalizeProviderRails,
  normalizeInitiateBody,
  [
    amountValidator,
    railFundsValidator,
    railDestinationValidator,
    metadataProviderValidator,

    body("localCurrencySymbol")
      .custom((v) => {
        if (!String(v || "").trim()) throw new Error("Devise locale requise");
        return true;
      })
      .customSanitizer((v, { req }) => {
        const cur = upISO(v);
        req.body.localCurrencySymbol = cur;
        req.body.localCurrencyCode = cur;
        req.body.currencyTarget = cur;
        if (!req.body.toCurrency) req.body.toCurrency = cur;
        return cur;
      }),

    body("senderCurrencySymbol")
      .custom((v) => {
        if (!String(v || "").trim()) throw new Error("Devise expéditeur requise");
        return true;
      })
      .customSanitizer((v, { req }) => {
        const cur = upISO(v);
        req.body.senderCurrencySymbol = cur;
        req.body.senderCurrencyCode = cur;
        req.body.currencySource = cur;
        if (!req.body.fromCurrency) req.body.fromCurrency = cur;
        return cur;
      }),

    body("country")
      .custom((v) => {
        if (!String(v || "").trim()) throw new Error("Pays requis");
        return true;
      })
      .customSanitizer((v, { req }) => {
        req.body.country = String(v || "").trim();
        if (!req.body.destinationCountry) req.body.destinationCountry = req.body.country;
        if (!req.body.toCountry) req.body.toCountry = req.body.destinationCountry || req.body.country;
        if (!req.body.fromCountry) {
          req.body.fromCountry = req.user?.selectedCountry || req.user?.country || req.body.country;
        }
        return req.body.country;
      }),

    body("description").optional().isString().trim().escape(),
    body("recipientInfo.name").optional().isString().trim().escape(),
    body("recipientInfo.email")
      .optional()
      .isEmail()
      .withMessage("Email destinataire invalide")
      .normalizeEmail(),
  ],
  requestValidator,
  amlMiddleware,
  asyncHandler(initiateByFlow)
);


router.post(
  "/webhooks/:provider",
  asyncHandler(settleExternalTransactionWebhook)
);


/* -------------------------------------------------------------------------- */
/* Confirm                                                                    */
/* -------------------------------------------------------------------------- */

router.post(
  "/confirm",
  protect,
  normalizeProviderRails,
  normalizeConfirmBody,
  [
    txIdValidator,

    body("securityAnswer")
      .custom((v, { req }) => {
        const vv = pickFirst(v, req.body?.securityCode, req.body?.validationCode);
        if (!String(vv || "").trim()) throw new Error("securityAnswer requis");
        return true;
      })
      .customSanitizer((v, { req }) => {
        req.body.securityAnswer = pickFirst(
          v,
          req.body?.securityCode,
          req.body?.validationCode
        ).trim();
        return req.body.securityAnswer;
      })
      .trim()
      .escape(),

    metadataProviderValidator,
  ],
  requestValidator,
  asyncHandler(confirmController)
);

/* -------------------------------------------------------------------------- */
/* Cancel                                                                     */
/* -------------------------------------------------------------------------- */

router.post(
  "/cancel",
  protect,
  [
    txIdValidator,
    body("reason").optional().isString().withMessage("Motif invalide").trim().escape(),
  ],
  requestValidator,
  asyncHandler(cancelController)
);

/* -------------------------------------------------------------------------- */
/* Admin actions                                                              */
/* -------------------------------------------------------------------------- */

router.post(
  "/refund",
  protect,
  requireRole(["admin", "superadmin"]),
  [txIdValidator, body("reason").optional().trim().escape()],
  requestValidator,
  asyncHandler(refundController)
);

router.post(
  "/validate",
  protect,
  requireRole(["admin", "superadmin"]),
  [
    txIdValidator,
    body("status").notEmpty().isString().withMessage("Nouveau statut requis"),
    body("adminNote").optional().trim().escape(),
  ],
  requestValidator,
  asyncHandler(validateController)
);

router.post(
  "/reassign",
  protect,
  requireRole(["admin", "superadmin"]),
  [
    txIdValidator,
    body("newReceiverEmail")
      .isEmail()
      .withMessage("Email du nouveau destinataire invalide")
      .normalizeEmail(),
  ],
  requestValidator,
  asyncHandler(reassignController)
);

router.post(
  "/archive",
  protect,
  requireRole(["admin", "superadmin"]),
  [txIdValidator],
  requestValidator,
  asyncHandler(archiveController)
);

router.post(
  "/relaunch",
  protect,
  requireRole(["admin", "superadmin"]),
  [txIdValidator],
  requestValidator,
  asyncHandler(relaunchController)
);

module.exports = router;