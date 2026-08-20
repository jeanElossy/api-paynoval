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
const nodeCrypto = require("crypto");
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

// Même source de vérité que l'authentification interne : voir `sensitiveLimiter`.
const { isValidInternalToken } = require("../middleware/internalAuth");

/** Garde du chemin webhook hérité — voir le module pour le détail du correctif. */
const requireInternalWebhookCaller = require("../middleware/requireInternalWebhookCaller");

/**
 * Politique des rails — version serveur de règles qui n'existaient que dans le
 * mobile. Report-only tant que `RAIL_POLICY_STRICT` n'est pas activée.
 */
const requireAllowedRail = require("../middleware/requireAllowedRail");

/**
 * Idempotence de l'API (motif Stripe) : un rejeu — double appui, délai
 * d'attente réseau, reprise de la passerelle — rend la réponse d'origine au
 * lieu de produire un second mouvement.
 *
 * L'EXIGENCE EST DÉCLARÉE PAR ROUTE, pas globalement — et cette distinction
 * n'est pas cosmétique : c'est elle qui rend le futur basculement sûr.
 *
 * Modèle de Wise, le plus proche de notre cas : la clé est exigée sur la seule
 * CRÉATION de virement, jamais sur les transitions d'état qui suivent.
 *
 *   `/initiate`  crée un document et réserve des fonds. Rien d'autre ne
 *                dédoublonne un double appui : c'est la seule route qui a
 *                réellement besoin de la clé. Elle suit `IDEMPOTENCY_REQUIRED`,
 *                aujourd'hui souple, à basculer quand le parc mobile l'envoie.
 *
 *   `/confirm`   `/cancel`  `/refund` — transitions d'état, déjà protégées par
 *                la machine à états (`assertTransition`) et ses drapeaux
 *                (`fundsCaptured`, `beneficiaryCredited`, `reserveReleased`),
 *                le tout sous transaction Mongo. Elles sont donc marquées
 *                `required: false` EN DUR.
 *
 * Pourquoi en dur : le mobile n'envoie de clé que sur `/initiate`. Un
 * `IDEMPOTENCY_REQUIRED=true` posé un jour sur l'environnement couperait ces
 * trois routes pour tout le monde — y compris la version la plus récente. C'est
 * exactement ce qui se produisait, la variable n'étant déclarée nulle part et
 * le défaut du code valant alors « exigée ». Marquer l'exigence à l'endroit où
 * l'on sait ce que le client envoie supprime le piège au lieu de le documenter.
 *
 * La clé reste HONORÉE sur ces trois routes si le client en envoie une.
 */
const idempotency = require("../middleware/idempotency");

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
 *
 * ⚠️ CORRECTIF DE SÉCURITÉ. Le `skip` testait la seule PRÉSENCE de l'en-tête
 * `x-internal-token`, sans jamais comparer sa valeur : `x-internal-token: x`
 * suffisait à lever la limite de 10 requêtes/minute sur `/initiate`,
 * `/confirm` et `/cancel`. C'est-à-dire, en pratique, à autoriser le
 * martèlement des codes de sécurité de confirmation par n'importe qui.
 *
 * La valeur est désormais comparée en timing-safe, avec la MÊME fonction que
 * l'authentification interne (`isValidInternalToken`) : un seul endroit décide
 * si un token interne est valide.
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
  skip: (req) => isValidInternalToken(req),
});

/**
 * ⚠️ SECONDE LIMITE, PAR SESSION — §14 : « le rate limiting ne doit pas être
 * uniquement basé sur l'IP ».
 *
 * `sensitiveLimiter` ci-dessus est keyé par IP, ce qui laisse deux angles morts
 * symétriques : derrière un NAT d'opérateur — la norme en Afrique de l'Ouest,
 * premier marché de PayNoval — des milliers d'utilisateurs légitimes partagent
 * une adresse et se coupent mutuellement ; à l'inverse, un attaquant disposant
 * de plusieurs sorties dilue sa charge.
 *
 * On AJOUTE donc une limite keyée par session, sans remplacer la première : les
 * deux s'appliquent, la plus stricte tranche. Remplacer l'une par l'autre
 * aurait affaibli la protection au lieu de la compléter.
 *
 * La clé est l'empreinte du jeton porteur, pas `req.user` : ce middleware
 * s'exécute AVANT `protect` (`router.use` passe avant les handlers de route),
 * `req.user` n'existe donc pas encore. On ne valide pas le jeton — son
 * empreinte suffit à distinguer deux sessions, et une valeur non vérifiée est
 * sans danger comme clé de compartiment.
 *
 * Le jeton n'est jamais journalisé : seul son SHA-256 tronqué sert de clé.
 */
function sessionRateKey(req) {
  const auth = String(req.headers?.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (!token) {
    // Sans jeton, on retombe sur l'IP : la requête sera rejetée par `protect`,
    // mais elle ne doit pas échapper au comptage pour autant.
    return `ip:${req.ip || "unknown"}`;
  }

  return `sess:${nodeCrypto
    .createHash("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 32)}`;
}

const sessionSensitiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: sessionRateKey,
  message: {
    success: false,
    status: 429,
    message: "Trop de requêtes, veuillez réessayer plus tard.",
  },
  skip: (req) => isValidInternalToken(req),
});

router.use(
  ["/initiate", "/confirm", "/cancel"],
  sensitiveLimiter,
  sessionSensitiveLimiter
);

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
  idempotency(),
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
  requireAllowedRail,
  amlMiddleware,
  asyncHandler(initiateByFlow)
);

/* -------------------------------------------------------------------------- */
/* Webhooks provider                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Route webhook provider — CHEMIN HÉRITÉ.
 *
 * ⚠️ CORRECTIF DE SÉCURITÉ (audit transactionnel).
 *
 * Le commentaire qui tenait lieu de garde ici disait que « la sécurité webhook
 * doit être faite via signature/provider/internal middleware ». Aucun de ces
 * middlewares n'était monté. La route était donc ouverte, et `/api/v1/transactions`
 * est monté sans `protect` dans `server.js` : n'importe qui sur Internet
 * atteignait `externalSettlementController`, c'est-à-dire le moteur de règlement
 * complet.
 *
 * Le seul contrôle du contrôleur est `verified: payload.verified !== false` —
 * autrement dit la charge utile de l'appelant se déclare elle-même vérifiée. Un
 * `{ transactionId, status: "success" }` suffisait à faire créditer un
 * bénéficiaire ou à marquer un payout SUCCESS alors qu'aucun prestataire n'avait
 * payé.
 *
 * La route de production des prestataires est `/webhooks/providers/:rail/:provider`
 * (voir `routes/providerWebhookRoutes.js`), qui vérifie le HMAC sur `rawBody`,
 * refuse en l'absence de secret et applique un rate limit dédié. Rien dans le
 * dépôt n'appelle le chemin ci-dessous — vérifié par recherche sur les cinq
 * applications.
 *
 * On ne le supprime pas (règle : corriger, pas retirer une fonctionnalité), mais
 * il échoue désormais en FERMETURE : seul un appelant interne porteur d'un token
 * valide — comparé en timing-safe par la même implémentation que le reste du
 * service — peut l'emprunter. Un prestataire externe doit passer par la route
 * signée.
 */
router.post(
  "/webhooks/:provider",
  requireInternalWebhookCaller,
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
  idempotency({ required: false }),
  normalizeProviderRails,
  normalizeConfirmBody,
  [
    txIdValidator,

    /**
     * ⚠️ CORRECTIF. Ce validateur portait `.escape()`, et `/initiate` ne
     * l'applique pas. L'empreinte était donc calculée sur deux chaînes
     * différentes selon le bout de la chaîne où l'on se trouvait :
     *
     *   initiate : sha256(sanitize("l'ecole"))       = sha256("l'ecole")
     *   confirm  : sha256(sanitize(escape("l'ecole"))) = sha256("l&#x27ecole")
     *
     * Toute réponse contenant ' & " < > était donc DÉFINITIVEMENT
     * inconfirmable : chaque essai consommait une tentative, la transaction se
     * verrouillait au seuil, puis partait en auto-cancel. En français
     * l'apostrophe est partout.
     *
     * La réponse n'est jamais rendue dans une page — elle est hachée puis
     * comparée. L'échappement HTML n'y avait aucun rôle défensif, et
     * `sanitize()` côté handler retire déjà `<>\/{};` des deux côtés, de façon
     * symétrique. On retire donc `.escape()` plutôt que de l'ajouter à
     * `/initiate` : l'ajouter aurait cassé les transactions déjà en attente,
     * dont l'empreinte est stockée non échappée.
     */
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
      .trim(),

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
  idempotency({ required: false }),
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
  idempotency({ required: false }),
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