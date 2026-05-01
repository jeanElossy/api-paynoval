// "use strict";

// /**
//  * --------------------------------------------------------------------------
//  * Routes Transactions (TX Core / PayNoval service)
//  * --------------------------------------------------------------------------
//  * Ce routeur couvre actuellement :
//  * - lecture transaction
//  * - liste transaction
//  * - initiate interne PayNoval -> PayNoval
//  * - confirm/cancel du flow interne existant
//  * - actions admin
//  *
//  * IMPORTANT :
//  * - ce fichier est maintenant mieux durci et préparé
//  * - mais les flows externes (mobile money / bank / card) doivent avoir
//  *   des controllers dédiés et ne doivent PAS réutiliser aveuglément
//  *   confirm/cancel interne
//  * --------------------------------------------------------------------------
//  */

// const express = require("express");
// const rateLimit = require("express-rate-limit");
// const { body, param, query } = require("express-validator");
// const asyncHandler = require("express-async-handler");

// const {
//   listInternal,
//   initiateByFlow,
//   confirmController,
//   cancelController,
//   getTransactionController,
//   refundController,
//   validateController,
//   reassignController,
//   archiveController,
//   relaunchController,
//   settleExternalTransactionWebhook,
// } = require("../controllers/transactionsController");

// const { protect } = require("../middleware/authMiddleware");
// const amlMiddleware = require("../middleware/aml");
// const requireRole = require("../middleware/requireRole");
// const requestValidator = require("../middleware/requestValidator");

// const router = express.Router();

// /* -------------------------------------------------------------------------- */
// /* Constantes                                                                 */
// /* -------------------------------------------------------------------------- */

// const MOBILEMONEY_PROVIDERS = ["wave", "orange", "mtn", "moov", "flutterwave"];

// const RAILS_ALLOWED = [
//   "paynoval",
//   "stripe",
//   "bank",
//   "mobilemoney",
//   "visa_direct",
//   "stripe2momo",
//   "cashin",
//   "cashout",
// ];

// /* -------------------------------------------------------------------------- */
// /* Helpers                                                                    */
// /* -------------------------------------------------------------------------- */

// function pickFirst(...vals) {
//   for (const v of vals) {
//     if (v !== undefined && v !== null && String(v).trim() !== "") return v;
//   }
//   return "";
// }

// function safeToFloat(v) {
//   const n =
//     typeof v === "number"
//       ? v
//       : parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", "."));
//   return Number.isFinite(n) ? n : NaN;
// }

// function upISO(v) {
//   return String(v || "").trim().toUpperCase();
// }

// function low(v) {
//   return String(v || "").trim().toLowerCase();
// }

// function isMMProvider(v) {
//   return MOBILEMONEY_PROVIDERS.includes(low(v));
// }

// function ensureMetadata(body) {
//   if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
//     body.metadata = {};
//   }
//   return body.metadata;
// }

// /* -------------------------------------------------------------------------- */
// /* Rate limit                                                                 */
// /* -------------------------------------------------------------------------- */

// /**
//  * Rate-limit sur actions sensibles.
//  * Le bypass via x-internal-token est autorisé uniquement pour trafic serveur
//  * interne maîtrisé.
//  */
// const sensitiveLimiter = rateLimit({
//   windowMs: 60 * 1000,
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

// router.use(["/initiate", "/confirm", "/cancel"], sensitiveLimiter);

// /* -------------------------------------------------------------------------- */
// /* Middlewares de normalisation                                               */
// /* -------------------------------------------------------------------------- */

// /**
//  * Normalise les rails/provider mobile money :
//  * - funds=wave => funds=mobilemoney + metadata.provider=wave
//  * - destination=orange => destination=mobilemoney + metadata.provider=orange
//  * - provider top-level => poussé dans metadata.provider
//  */
// function normalizeProviderRails(req, _res, next) {
//   try {
//     const b = req.body || {};
//     const metadata = ensureMetadata(b);

//     const explicitProvider = low(
//       pickFirst(
//         b.provider,
//         metadata.provider,
//         b.mmProvider,
//         b.operator,
//         b.providerSelected
//       )
//     );

//     if (explicitProvider) {
//       metadata.provider = explicitProvider;
//       b.provider = explicitProvider;
//     }

//     const fundsRaw = low(b.funds);
//     if (isMMProvider(fundsRaw)) {
//       b.funds = "mobilemoney";
//       metadata.provider = metadata.provider || fundsRaw;
//       b.provider = b.provider || metadata.provider;
//     }

//     const destinationRaw = low(b.destination);
//     if (isMMProvider(destinationRaw)) {
//       b.destination = "mobilemoney";
//       metadata.provider = metadata.provider || destinationRaw;
//       b.provider = b.provider || metadata.provider;
//     }

//     req.body = b;
//   } catch {
//     // no-op volontaire
//   }

//   next();
// }

// /**
//  * Normalisation payload initiate.
//  * Cette normalisation n’exécute aucune logique métier :
//  * elle harmonise seulement les champs entrants.
//  */
// function normalizeInitiateBody(req, _res, next) {
//   try {
//     const b = req.body || {};

//     const rawAmount = pickFirst(b.amount, b.amountSource, b.fundsAmount, b.value);
//     if (rawAmount !== "") {
//       b.amount = safeToFloat(rawAmount);
//     }

//     const rawCountry = pickFirst(
//       b.country,
//       b.destinationCountry,
//       b.toCountry,
//       req.user?.selectedCountry,
//       req.user?.country
//     );
//     if (rawCountry) {
//       b.country = String(rawCountry).trim();

//       if (!b.destinationCountry) b.destinationCountry = b.country;
//       if (!b.toCountry) b.toCountry = b.destinationCountry || b.country;
//       if (!b.fromCountry) {
//         b.fromCountry = req.user?.selectedCountry || req.user?.country || b.country;
//       }
//     }

//     const rawSrc = pickFirst(
//       b.senderCurrencyCode,
//       b.currencySource,
//       b.senderCurrencySymbol,
//       b.currencyCode,
//       b.fromCurrency,
//       b.currency
//     );

//     if (rawSrc) {
//       const cur = upISO(rawSrc);
//       b.senderCurrencyCode = cur;
//       b.currencySource = cur;
//       b.senderCurrencySymbol = cur;
//       if (!b.fromCurrency) b.fromCurrency = cur;
//     }

//     const rawTgt = pickFirst(
//       b.localCurrencyCode,
//       b.currencyTarget,
//       b.localCurrencySymbol,
//       b.toCurrency
//     );

//     if (rawTgt) {
//       const cur = upISO(rawTgt);
//       b.localCurrencyCode = cur;
//       b.currencyTarget = cur;
//       b.localCurrencySymbol = cur;
//       if (!b.toCurrency) b.toCurrency = cur;
//     }

//     b.securityQuestion = pickFirst(
//       b.securityQuestion,
//       b.question,
//       b.validationQuestion
//     );

//     b.securityAnswer = pickFirst(
//       b.securityAnswer,
//       b.securityCode,
//       b.validationCode
//     );

//     if (!b.method) {
//       if (low(b.funds) === "mobilemoney" || low(b.destination) === "mobilemoney") {
//         b.method = "MOBILEMONEY";
//       } else if (low(b.destination) === "paynoval") {
//         b.method = "INTERNAL";
//       }
//     }

//     if (!b.txType) {
//       const action = low(b.action);
//       if (action === "deposit") b.txType = "DEPOSIT";
//       else if (action === "withdraw") b.txType = "WITHDRAW";
//       else b.txType = "TRANSFER";
//     }

//     req.body = b;
//   } catch {
//     // no-op volontaire
//   }

//   next();
// }

// /**
//  * Normalisation payload confirm.
//  */
// function normalizeConfirmBody(req, _res, next) {
//   try {
//     const b = req.body || {};

//     b.securityAnswer = pickFirst(
//       b.securityAnswer,
//       b.securityCode,
//       b.validationCode
//     );

//     req.body = b;
//   } catch {
//     // no-op volontaire
//   }

//   next();
// }

// /* -------------------------------------------------------------------------- */
// /* Validators communs                                                         */
// /* -------------------------------------------------------------------------- */

// const txIdValidator = body("transactionId")
//   .isMongoId()
//   .withMessage("ID de transaction invalide");

// const metadataProviderValidator = body("metadata.provider")
//   .optional({ nullable: true })
//   .custom((v, { req }) => {
//     const funds = low(req.body?.funds);
//     const dest = low(req.body?.destination);
//     const needs = funds === "mobilemoney" || dest === "mobilemoney";

//     const vv = low(v || req.body?.provider);

//     if (!needs) return true;

//     if (!vv) {
//       throw new Error(
//         "metadata.provider requis pour mobilemoney (wave|orange|mtn|moov|flutterwave)"
//       );
//     }

//     if (!isMMProvider(vv)) {
//       throw new Error("metadata.provider doit être wave|orange|mtn|moov|flutterwave");
//     }

//     return true;
//   })
//   .customSanitizer((v, { req }) => {
//     const metadata = ensureMetadata(req.body);
//     const vv = low(v || req.body?.provider);
//     if (vv) {
//       metadata.provider = vv;
//       req.body.provider = vv;
//     }
//     return metadata.provider || null;
//   });

// const amountValidator = body("amount")
//   .custom((v, { req }) => {
//     const n = safeToFloat(v ?? req.body?.amount);
//     if (!Number.isFinite(n) || n <= 0) {
//       throw new Error("Le montant doit être supérieur à 0");
//     }
//     return true;
//   })
//   .customSanitizer((v, { req }) => {
//     req.body.amount = safeToFloat(v);
//     return req.body.amount;
//   });

// const railFundsValidator = body("funds")
//   .notEmpty()
//   .withMessage("Type de fonds requis")
//   .custom((v) => {
//     const vv = low(v);
//     if (!RAILS_ALLOWED.includes(vv)) {
//       throw new Error(`funds invalide (${v})`);
//     }
//     return true;
//   })
//   .customSanitizer((v, { req }) => {
//     req.body.funds = low(v);
//     return req.body.funds;
//   });

// const railDestinationValidator = body("destination")
//   .notEmpty()
//   .withMessage("Destination requise")
//   .custom((v) => {
//     const vv = low(v);
//     if (!RAILS_ALLOWED.includes(vv)) {
//       throw new Error(`destination invalide (${v})`);
//     }
//     return true;
//   })
//   .customSanitizer((v, { req }) => {
//     req.body.destination = low(v);
//     return req.body.destination;
//   });

// /* -------------------------------------------------------------------------- */
// /* Routes lecture                                                             */
// /* -------------------------------------------------------------------------- */

// router.get(
//   "/:id",
//   protect,
//   [param("id").isMongoId().withMessage("ID de transaction invalide")],
//   requestValidator,
//   asyncHandler(getTransactionController)
// );

// router.get(
//   "/",
//   protect,
//   [
//     query("skip").optional().isInt({ min: 0 }).withMessage("skip invalide"),
//     query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit invalide"),
//   ],
//   requestValidator,
//   asyncHandler(listInternal)
// );

// /* -------------------------------------------------------------------------- */
// /* Initiate                                                                   */
// /* -------------------------------------------------------------------------- */

// /**
//  * NOTE :
//  * Cette route appelle encore initiateInternal.
//  * Donc, à ce stade, elle reste stricte pour le flow interne PayNoval -> PayNoval.
//  * Les flows externes devront avoir des controllers dédiés plus tard.
//  */
// // router.post(
// //   "/initiate",
// //   protect,
// //   normalizeProviderRails,
// //   normalizeInitiateBody,
// //   [
// //     body("toEmail")
// //       .isEmail()
// //       .withMessage("Email du destinataire invalide")
// //       .normalizeEmail(),

// //     amountValidator,
// //     railFundsValidator,
// //     railDestinationValidator,
// //     metadataProviderValidator,

// //     body("localCurrencySymbol")
// //       .custom((v) => {
// //         if (!String(v || "").trim()) throw new Error("Devise locale requise");
// //         return true;
// //       })
// //       .customSanitizer((v, { req }) => {
// //         const cur = upISO(v);
// //         req.body.localCurrencySymbol = cur;
// //         req.body.localCurrencyCode = cur;
// //         req.body.currencyTarget = cur;
// //         if (!req.body.toCurrency) req.body.toCurrency = cur;
// //         return cur;
// //       }),

// //     body("senderCurrencySymbol")
// //       .custom((v) => {
// //         if (!String(v || "").trim()) throw new Error("Devise expéditeur requise");
// //         return true;
// //       })
// //       .customSanitizer((v, { req }) => {
// //         const cur = upISO(v);
// //         req.body.senderCurrencySymbol = cur;
// //         req.body.senderCurrencyCode = cur;
// //         req.body.currencySource = cur;
// //         if (!req.body.fromCurrency) req.body.fromCurrency = cur;
// //         return cur;
// //       }),

// //     body("country")
// //       .custom((v) => {
// //         if (!String(v || "").trim()) throw new Error("Pays requis");
// //         return true;
// //       })
// //       .customSanitizer((v, { req }) => {
// //         req.body.country = String(v || "").trim();
// //         if (!req.body.destinationCountry) req.body.destinationCountry = req.body.country;
// //         if (!req.body.toCountry) req.body.toCountry = req.body.destinationCountry || req.body.country;
// //         if (!req.body.fromCountry) {
// //           req.body.fromCountry = req.user?.selectedCountry || req.user?.country || req.body.country;
// //         }
// //         return req.body.country;
// //       }),

// //     body("description").optional().isString().trim().escape(),
// //     body("recipientInfo.name").optional().isString().trim().escape(),

// //     body("recipientInfo.email")
// //       .optional()
// //       .isEmail()
// //       .withMessage("Email destinataire invalide")
// //       .normalizeEmail(),

// //     body("securityQuestion")
// //       .custom((v, { req }) => {
// //         const vv = pickFirst(v, req.body?.question, req.body?.validationQuestion);
// //         if (!String(vv || "").trim()) throw new Error("securityQuestion requis");
// //         return true;
// //       })
// //       .customSanitizer((v, { req }) => {
// //         req.body.securityQuestion = pickFirst(
// //           v,
// //           req.body?.question,
// //           req.body?.validationQuestion
// //         ).trim();
// //         return req.body.securityQuestion;
// //       })
// //       .trim()
// //       .escape(),

// //     body("securityAnswer")
// //       .custom((v, { req }) => {
// //         const vv = pickFirst(v, req.body?.securityCode, req.body?.validationCode);
// //         if (!String(vv || "").trim()) throw new Error("securityAnswer requis");
// //         return true;
// //       })
// //       .customSanitizer((v, { req }) => {
// //         req.body.securityAnswer = pickFirst(
// //           v,
// //           req.body?.securityCode,
// //           req.body?.validationCode
// //         ).trim();
// //         return req.body.securityAnswer;
// //       })
// //       .trim()
// //       .escape(),
// //   ],
// //   requestValidator,
// //   amlMiddleware,
// //   asyncHandler(initiateInternal)
// // );


// router.post(
//   "/initiate",
//   protect,
//   normalizeProviderRails,
//   normalizeInitiateBody,
//   [
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
//   ],
//   requestValidator,
//   amlMiddleware,
//   asyncHandler(initiateByFlow)
// );


// router.post(
//   "/webhooks/:provider",
//   asyncHandler(settleExternalTransactionWebhook)
// );


// /* -------------------------------------------------------------------------- */
// /* Confirm                                                                    */
// /* -------------------------------------------------------------------------- */

// router.post(
//   "/confirm",
//   protect,
//   normalizeProviderRails,
//   normalizeConfirmBody,
//   [
//     txIdValidator,

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

//     metadataProviderValidator,
//   ],
//   requestValidator,
//   asyncHandler(confirmController)
// );

// /* -------------------------------------------------------------------------- */
// /* Cancel                                                                     */
// /* -------------------------------------------------------------------------- */

// router.post(
//   "/cancel",
//   protect,
//   [
//     txIdValidator,
//     body("reason").optional().isString().withMessage("Motif invalide").trim().escape(),
//   ],
//   requestValidator,
//   asyncHandler(cancelController)
// );

// /* -------------------------------------------------------------------------- */
// /* Admin actions                                                              */
// /* -------------------------------------------------------------------------- */

// router.post(
//   "/refund",
//   protect,
//   requireRole(["admin", "superadmin"]),
//   [txIdValidator, body("reason").optional().trim().escape()],
//   requestValidator,
//   asyncHandler(refundController)
// );

// router.post(
//   "/validate",
//   protect,
//   requireRole(["admin", "superadmin"]),
//   [
//     txIdValidator,
//     body("status").notEmpty().isString().withMessage("Nouveau statut requis"),
//     body("adminNote").optional().trim().escape(),
//   ],
//   requestValidator,
//   asyncHandler(validateController)
// );

// router.post(
//   "/reassign",
//   protect,
//   requireRole(["admin", "superadmin"]),
//   [
//     txIdValidator,
//     body("newReceiverEmail")
//       .isEmail()
//       .withMessage("Email du nouveau destinataire invalide")
//       .normalizeEmail(),
//   ],
//   requestValidator,
//   asyncHandler(reassignController)
// );

// router.post(
//   "/archive",
//   protect,
//   requireRole(["admin", "superadmin"]),
//   [txIdValidator],
//   requestValidator,
//   asyncHandler(archiveController)
// );

// router.post(
//   "/relaunch",
//   protect,
//   requireRole(["admin", "superadmin"]),
//   [txIdValidator],
//   requestValidator,
//   asyncHandler(relaunchController)
// );

// module.exports = router;







"use strict";

/**
 * --------------------------------------------------------------------------
 * Routes Transactions (TX Core / PayNoval service)
 * --------------------------------------------------------------------------
 * Ce routeur couvre :
 * - lecture transaction
 * - liste transaction
 * - initiate interne/externe via initiateByFlow
 * - confirm/cancel
 * - actions admin
 * - webhook provider
 *
 * Sécurité :
 * - /initiate : JWT + validation payload + eligibility + AML + initiateByFlow
 * - /confirm  : JWT + validation payload + eligibility + confirmController
 * - /cancel   : JWT uniquement, pas d’eligibility pour permettre la libération
 * - admin     : JWT + rôle admin/superadmin
 * - webhooks  : non JWT ici, doit être sécurisé par la couche webhook/provider
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
const requireTransactionEligibility = require("../middleware/requireTransactionEligibility");
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
  if (
    !body.metadata ||
    typeof body.metadata !== "object" ||
    Array.isArray(body.metadata)
  ) {
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
        b.fromCountry =
          req.user?.selectedCountry || req.user?.country || b.country;
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
      if (
        low(b.funds) === "mobilemoney" ||
        low(b.destination) === "mobilemoney"
      ) {
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
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("limit invalide"),
  ],
  requestValidator,
  asyncHandler(listInternal)
);

/* -------------------------------------------------------------------------- */
/* Initiate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Barrière sécurité :
 * - protect : JWT requis
 * - requestValidator : payload propre
 * - requireTransactionEligibility : email/téléphone/KYC/KYB/statut compte
 * - amlMiddleware : AML, blacklist, limites, sanctions internes
 * - initiateByFlow : interne/externe selon funds/destination/provider
 */
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

        if (!req.body.destinationCountry) {
          req.body.destinationCountry = req.body.country;
        }

        if (!req.body.toCountry) {
          req.body.toCountry =
            req.body.destinationCountry || req.body.country;
        }

        if (!req.body.fromCountry) {
          req.body.fromCountry =
            req.user?.selectedCountry || req.user?.country || req.body.country;
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
  requireTransactionEligibility,
  amlMiddleware,
  asyncHandler(initiateByFlow)
);

/* -------------------------------------------------------------------------- */
/* Webhooks provider                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Route webhook provider.
 * Ne pas ajouter requireTransactionEligibility ici.
 * La sécurité webhook doit être faite via signature/provider/internal middleware.
 */
router.post(
  "/webhooks/:provider",
  asyncHandler(settleExternalTransactionWebhook)
);

/* -------------------------------------------------------------------------- */
/* Confirm                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Barrière sécurité :
 * - protect : JWT requis
 * - requestValidator : transactionId + réponse sécurité
 * - requireTransactionEligibility : l’utilisateur qui confirme doit toujours
 *   être éligible au moment de la confirmation
 * - confirmController : vérifie aussi les profils/corridor avant capture/crédit
 */
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

        if (!String(vv || "").trim()) {
          throw new Error("securityAnswer requis");
        }

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
  requireTransactionEligibility,
  asyncHandler(confirmController)
);

/* -------------------------------------------------------------------------- */
/* Cancel                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Pas de requireTransactionEligibility ici :
 * un utilisateur doit pouvoir annuler/libérer une transaction même si son compte
 * devient bloqué, non vérifié ou incomplet.
 */
router.post(
  "/cancel",
  protect,
  [
    txIdValidator,
    body("reason")
      .optional()
      .isString()
      .withMessage("Motif invalide")
      .trim()
      .escape(),
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