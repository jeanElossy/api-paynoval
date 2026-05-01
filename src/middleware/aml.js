// // File: src/middleware/aml.js
// "use strict";

// const logger = require("../utils/logger");
// const {
//   logTransaction,
//   getUserTransactionsStats,
//   getPEPOrSanctionedStatus,
//   getMLScore,
//   getBusinessKYBStatus,
// } = require("../services/aml");

// const blacklist = require("../aml/blacklist.json");
// const { sendFraudAlert } = require("../utils/alert");
// const { getCurrencySymbolByCode, getCurrencyCodeByCountry } = require("../tools/currency");
// const { getDailyLimit, getSingleTxLimit } = require("../tools/amlLimits");

// const RISKY_COUNTRIES_ISO = new Set(["IR", "KP", "SD", "SY", "CU", "RU", "AF", "SO", "YE", "VE", "LY"]);
// const ALLOWED_STRIPE_CURRENCY_CODES = ["EUR", "USD", "CAD"];

// // --------------------------
// // utils
// // --------------------------
// function maskSensitive(obj) {
//   const SENSITIVE_FIELDS = ["password", "cardNumber", "iban", "cvc", "securityCode", "otp", "code", "pin"];
//   if (!obj || typeof obj !== "object") return obj;

//   const out = Array.isArray(obj) ? [] : {};
//   for (const k of Object.keys(obj)) {
//     if (SENSITIVE_FIELDS.includes(k)) out[k] = "***";
//     else if (obj[k] && typeof obj[k] === "object") out[k] = maskSensitive(obj[k]);
//     else out[k] = obj[k];
//   }
//   return out;
// }

// function parseAmount(v) {
//   if (v == null) return 0;
//   if (typeof v === "number") return Number.isFinite(v) ? v : 0;
//   const s = String(v).replace(/\s/g, "").replace(",", ".").trim();
//   const n = parseFloat(s);
//   return Number.isFinite(n) ? n : 0;
// }

// function normalizeCountryToISO(country) {
//   if (!country) return "";
//   const raw = String(country).trim();
//   if (!raw) return "";

//   if (/^[A-Z]{2}$/.test(raw.toUpperCase())) return raw.toUpperCase();

//   const n = raw
//     .normalize("NFD")
//     .replace(/[\u0300-\u036f]/g, "")
//     .toLowerCase()
//     .trim();

//   const map = {
//     france: "FR",
//     "cote d'ivoire": "CI",
//     "cote divoire": "CI",
//     "ivory coast": "CI",
//     "burkina faso": "BF",
//     mali: "ML",
//     senegal: "SN",
//     cameroun: "CM",
//     cameroon: "CM",
//     belgique: "BE",
//     allemagne: "DE",
//     germany: "DE",
//     usa: "US",
//     "etats-unis": "US",
//     "etats unis": "US",
//     "united states": "US",
//     canada: "CA",
//     uk: "GB",
//     "royaume-uni": "GB",
//     "royaume uni": "GB",
//     "united kingdom": "GB",
//     russie: "RU",
//     russia: "RU",
//   };

//   return map[n] || "";
// }

// function resolveProvider(req) {
//   const rp = String(req.routedProvider || "").trim().toLowerCase();
//   if (rp) return rp;

//   const b = req.body || {};
//   const p =
//     String(b.provider || "").trim().toLowerCase() ||
//     String(b.metadata?.provider || "").trim().toLowerCase() ||
//     String(b.destination || "").trim().toLowerCase() ||
//     String(b.funds || "").trim().toLowerCase();

//   return p || "paynoval";
// }

// function normalizeCurrencyISO(v) {
//   const s0 = String(v || "").trim().toUpperCase();
//   if (!s0) return "";

//   const s = s0.replace(/\u00A0/g, " ");

//   if (s === "FCFA" || s === "CFA" || s === "F CFA" || s.includes("CFA")) return "XOF";
//   if (s === "€") return "EUR";
//   if (s === "$") return "USD";
//   if (s === "£") return "GBP";

//   const letters = s.replace(/[^A-Z]/g, "");
//   if (["CAD", "USD", "EUR", "GBP", "XOF", "XAF"].includes(letters)) return letters;

//   if (/^[A-Z]{3}$/.test(letters)) return letters;
//   if (/^[A-Z]{3}$/.test(s)) return s;

//   return "";
// }

// /**
//  * ✅ currency resolver (PRO)
//  * On tente dans l'ordre:
//  * - money.source.currency
//  * - senderCurrencySymbol (normalisé dans routes)
//  * - currencySource / currencyCode / currency etc.
//  * - fallback via country user/payload
//  */
// function resolveCurrencyCode(req) {
//   const b = req.body || {};
//   const user = req.user || {};

//   const candidate =
//     b.money?.source?.currency ||
//     b.senderCurrencySymbol ||
//     b.currencySource ||
//     b.senderCurrencyCode ||
//     b.currencyCode ||
//     b.currencySender ||
//     b.currency ||
//     b.selectedCurrency ||
//     b.fromCurrency ||
//     "";

//   let iso = normalizeCurrencyISO(candidate);

//   if (!iso) {
//     const senderCountry = user?.selectedCountry || user?.country || user?.countryCode || "";
//     iso = normalizeCurrencyISO(getCurrencyCodeByCountry(senderCountry));
//   }

//   if (!iso) {
//     const lastResortCountry = b.senderCountry || b.originCountry || b.fromCountry || b.country || "";
//     iso = normalizeCurrencyISO(getCurrencyCodeByCountry(lastResortCountry));
//   }

//   if (!/^[A-Z]{3}$/.test(iso)) iso = "USD";
//   return iso;
// }

// function resolveDestinationCountryISO(req) {
//   const b = req.body || {};
//   const user = req.user || {};

//   const raw =
//     b.destinationCountry ||
//     b.country ||
//     user?.country ||
//     user?.selectedCountry ||
//     "";

//   return normalizeCountryToISO(raw);
// }

// module.exports = async function amlMiddleware(req, res, next) {
//   const provider = resolveProvider(req);
//   const user = req.user;

//   const body = req.body || {};
//   const toEmail = body.toEmail || body.email || body.recipientEmail || "";
//   const iban = body.iban || body.toIBAN || "";
//   const phoneNumber = body.phoneNumber || body.toPhone || body.phone || "";

//   const destinationCountryISO = resolveDestinationCountryISO(req);

//   // amount: support amountSource, amount, money.source.amount
//   const amount = parseAmount(
//     body.amountSource ?? body.amount ?? body.money?.source?.amount
//   );

//   const currencyCode = resolveCurrencyCode(req);
//   const currencySymbol = getCurrencySymbolByCode(currencyCode);

//   try {
//     if (!user || !user._id) {
//       logger.warn("[AML] User manquant", { provider });
//       await logTransaction({
//         userId: null,
//         type: "initiate",
//         provider,
//         amount,
//         currency: currencyCode,
//         toEmail,
//         details: maskSensitive(body),
//         flagged: true,
//         flagReason: "User manquant",
//         ip: req.ip,
//       });
//       return res.status(401).json({
//         success: false,
//         error: "Merci de vous connecter pour poursuivre.",
//         code: "AUTH_REQUIRED",
//       });
//     }

//     // KYC/KYB checks
//     if (user.type === "business" || user.isBusiness) {
//       let kybStatus = user.kybStatus;
//       if (typeof getBusinessKYBStatus === "function") {
//         kybStatus = await getBusinessKYBStatus(user.businessId || user._id);
//       }
//       if (!kybStatus || kybStatus !== "validé") {
//         logger.warn("[AML] KYB insuffisant", { provider, user: user.email });
//         await logTransaction({
//           userId: user._id,
//           type: "initiate",
//           provider,
//           amount,
//           currency: currencyCode,
//           toEmail,
//           details: maskSensitive(body),
//           flagged: true,
//           flagReason: "KYB insuffisant",
//           ip: req.ip,
//         });
//         await sendFraudAlert({ user, type: "kyb_insuffisant", provider });
//         return res.status(403).json({
//           success: false,
//           error:
//             "L’accès aux transactions est temporairement restreint. Merci de compléter la vérification d’entreprise.",
//           code: "KYB_REQUIRED",
//         });
//       }
//     } else {
//       if (!user.kycLevel || user.kycLevel < 2) {
//         logger.warn("[AML] KYC insuffisant", { provider, user: user.email });
//         await logTransaction({
//           userId: user._id,
//           type: "initiate",
//           provider,
//           amount,
//           currency: currencyCode,
//           toEmail,
//           details: maskSensitive(body),
//           flagged: true,
//           flagReason: "KYC insuffisant",
//           ip: req.ip,
//         });
//         await sendFraudAlert({ user, type: "kyc_insuffisant", provider });
//         return res.status(403).json({
//           success: false,
//           error: "Votre vérification d’identité (KYC) n’est pas finalisée.",
//           code: "KYC_REQUIRED",
//         });
//       }
//     }

//     // PEP/Sanction
//     const pepStatus = await getPEPOrSanctionedStatus(user, { toEmail, iban, phoneNumber });
//     if (pepStatus && pepStatus.sanctioned) {
//       logger.error("[AML] PEP/Sanction detected", { user: user.email, reason: pepStatus.reason });
//       await logTransaction({
//         userId: user._id,
//         type: "initiate",
//         provider,
//         amount,
//         currency: currencyCode,
//         toEmail,
//         details: maskSensitive(body),
//         flagged: true,
//         flagReason: pepStatus.reason,
//         ip: req.ip,
//       });
//       await sendFraudAlert({ user, type: "pep_sanction", provider, reason: pepStatus.reason });
//       return res.status(403).json({
//         success: false,
//         error: "Impossible d’effectuer la transaction : bénéficiaire sur liste de surveillance.",
//         code: "PEP_SANCTIONED",
//       });
//     }

//     // Blacklist
//     if (
//       (toEmail && Array.isArray(blacklist.emails) && blacklist.emails.includes(toEmail)) ||
//       (iban && Array.isArray(blacklist.ibans) && blacklist.ibans.includes(iban)) ||
//       (phoneNumber && Array.isArray(blacklist.phones) && blacklist.phones.includes(phoneNumber))
//     ) {
//       logger.warn("[AML] Cible blacklistée", { provider, toEmail, iban, phoneNumber });
//       await logTransaction({
//         userId: user._id,
//         type: "initiate",
//         provider,
//         amount,
//         currency: currencyCode,
//         toEmail,
//         details: maskSensitive(body),
//         flagged: true,
//         flagReason: "Blacklist",
//         ip: req.ip,
//       });
//       await sendFraudAlert({ user, type: "blacklist", provider, toEmail, iban, phoneNumber });
//       return res.status(403).json({
//         success: false,
//         error: "Transaction interdite : restriction conformité (AML).",
//         code: "BLACKLISTED",
//       });
//     }

//     // Pays à risque (destination ISO2)
//     if (destinationCountryISO && RISKY_COUNTRIES_ISO.has(destinationCountryISO)) {
//       logger.warn("[AML] Pays à risque détecté", {
//         provider,
//         user: user.email,
//         destinationCountryISO,
//         destinationCountryRaw: body.destinationCountry || body.country || null,
//       });

//       await logTransaction({
//         userId: user._id,
//         type: "initiate",
//         provider,
//         amount,
//         currency: currencyCode,
//         toEmail,
//         details: maskSensitive(body),
//         flagged: true,
//         flagReason: "Pays à risque",
//         ip: req.ip,
//       });

//       await sendFraudAlert({ user, type: "pays_risque", provider, country: destinationCountryISO });

//       return res.status(403).json({
//         success: false,
//         error: "Transaction bloquée : pays de destination non autorisé.",
//         code: "RISKY_COUNTRY",
//         details: { country: destinationCountryISO },
//       });
//     }

//     // Limites
//     const singleTxLimit = getSingleTxLimit(provider, currencyCode);
//     if (amount > singleTxLimit) {
//       logger.warn("[AML] Plafond single dépassé", { provider, user: user.email, amount, max: singleTxLimit });

//       await logTransaction({
//         userId: user._id,
//         type: "initiate",
//         provider,
//         amount,
//         currency: currencyCode,
//         toEmail,
//         details: maskSensitive(body),
//         flagged: true,
//         flagReason: `Plafond single dépassé (${amount} > ${singleTxLimit} ${currencyCode})`,
//         ip: req.ip,
//       });

//       return res.status(403).json({
//         success: false,
//         error: `Plafond par transaction: ${singleTxLimit} ${currencySymbol}.`,
//         code: "AML_SINGLE_LIMIT",
//         details: { max: singleTxLimit, currencyCode, currencySymbol, provider },
//       });
//     }

//     const dailyLimit = getDailyLimit(provider, currencyCode);

//     let stats = null;
//     try {
//       stats = await getUserTransactionsStats(user._id, provider, currencyCode);
//     } catch {}

//     const dailyTotal = stats && Number.isFinite(stats.dailyTotal) ? stats.dailyTotal : 0;
//     const futureTotal = dailyTotal + (amount || 0);

//     if (futureTotal > dailyLimit) {
//       logger.warn("[AML] Plafond journalier dépassé", { provider, user: user.email, dailyTotal, amount, dailyLimit });

//       await logTransaction({
//         userId: user._id,
//         type: "initiate",
//         provider,
//         amount,
//         currency: currencyCode,
//         toEmail,
//         details: maskSensitive(body),
//         flagged: true,
//         flagReason: `Plafond journalier dépassé (${dailyTotal} + ${amount} > ${dailyLimit} ${currencyCode})`,
//         ip: req.ip,
//       });

//       return res.status(403).json({
//         success: false,
//         error: `Plafond journalier atteint (${dailyLimit} ${currencySymbol}). Réessayez demain.`,
//         code: "AML_DAILY_LIMIT",
//         details: { max: dailyLimit, currencyCode, currencySymbol, provider, dailyTotal },
//       });
//     }

//     // Challenge AML (optionnel)
//     const userQuestions = Array.isArray(user.securityQuestions) ? user.securityQuestions : [];
//     const needAmlChallenge =
//       typeof amount === "number" && amount >= dailyLimit * 0.9 && userQuestions.length > 0;

//     if (needAmlChallenge) {
//       const amlQ = body.amlSecurityQuestion;
//       const amlA = body.amlSecurityAnswer;

//       if (!amlQ || !amlA) {
//         const qIdx = Math.floor(Math.random() * userQuestions.length);
//         return res.status(428).json({
//           success: false,
//           error: "AML_SECURITY_CHALLENGE",
//           code: "AML_SECURITY_CHALLENGE",
//           need_security_answer: true,
//           amlSecurityQuestion: userQuestions[qIdx].question,
//         });
//       }

//       const idx = userQuestions.findIndex((q) => q.question === amlQ);
//       if (idx === -1) {
//         return res.status(403).json({
//           success: false,
//           error: "Question AML inconnue.",
//           code: "AML_QUESTION_UNKNOWN",
//         });
//       }

//       const ok =
//         String(userQuestions[idx].answer || "").trim().toLowerCase() ===
//         String(amlA || "").trim().toLowerCase();

//       if (!ok) {
//         logger.warn("[AML] Réponse AML incorrecte", { user: user.email });

//         await logTransaction({
//           userId: user._id,
//           type: "initiate",
//           provider,
//           amount,
//           currency: currencyCode,
//           toEmail,
//           details: maskSensitive(body),
//           flagged: true,
//           flagReason: "AML Sécurité question échouée",
//           ip: req.ip,
//         });

//         await sendFraudAlert({ user, type: "aml_security_failed", provider });

//         return res.status(403).json({
//           success: false,
//           error: "Réponse AML incorrecte.",
//           code: "AML_SECURITY_FAILED",
//         });
//       }
//     }

//     // Patterns
//     if (stats && stats.lastHour > 10) {
//       logger.warn("[AML] Volume suspect sur 1h", { provider, user: user.email, lastHour: stats.lastHour });

//       await logTransaction({
//         userId: user._id,
//         type: "initiate",
//         provider,
//         amount,
//         currency: currencyCode,
//         toEmail,
//         details: maskSensitive(body),
//         flagged: true,
//         flagReason: "Volume élevé 1h",
//         ip: req.ip,
//       });

//       await sendFraudAlert({ user, type: "volume_1h", provider, count: stats.lastHour });

//       return res.status(403).json({
//         success: false,
//         error: "Trop de transactions sur 1h, vérification requise.",
//         code: "AML_RATE_LIMIT_1H",
//         details: { count: stats.lastHour },
//       });
//     }

//     if (stats && stats.sameDestShortTime > 3) {
//       logger.warn("[AML] Structuring suspect", { provider, user: user.email, count: stats.sameDestShortTime });

//       await logTransaction({
//         userId: user._id,
//         type: "initiate",
//         provider,
//         amount,
//         currency: currencyCode,
//         toEmail,
//         details: maskSensitive(body),
//         flagged: true,
//         flagReason: "Pattern structuring",
//         ip: req.ip,
//       });

//       await sendFraudAlert({ user, type: "structuring", provider, count: stats.sameDestShortTime });

//       return res.status(403).json({
//         success: false,
//         error: "Activité inhabituelle détectée. Vérification requise.",
//         code: "AML_STRUCTURING",
//         details: { count: stats.sameDestShortTime },
//       });
//     }

//     // Stripe currency allowed
//     if (provider === "stripe" && currencyCode && !ALLOWED_STRIPE_CURRENCY_CODES.includes(currencyCode)) {
//       logger.warn("[AML] Devise Stripe non autorisée", { user: user.email, currencyCode });

//       await logTransaction({
//         userId: user._id,
//         type: "initiate",
//         provider,
//         amount,
//         currency: currencyCode,
//         toEmail,
//         details: maskSensitive(body),
//         flagged: true,
//         flagReason: "Devise interdite Stripe",
//         ip: req.ip,
//       });

//       await sendFraudAlert({ user, type: "devise_interdite", provider, currencyCode });

//       return res.status(403).json({
//         success: false,
//         error: "Devise non autorisée.",
//         code: "STRIPE_CURRENCY_NOT_ALLOWED",
//         details: { currencyCode, currencySymbol },
//       });
//     }

//     // ML scoring (optionnel)
//     if (typeof getMLScore === "function") {
//       const score = await getMLScore(body, user);
//       if (score && score >= 0.9) {
//         logger.warn("[AML] ML scoring élevé", { user: user.email, score });

//         await logTransaction({
//           userId: user._id,
//           type: "initiate",
//           provider,
//           amount,
//           currency: currencyCode,
//           toEmail,
//           details: maskSensitive(body),
//           flagged: true,
//           flagReason: "Scoring ML élevé",
//           ip: req.ip,
//         });

//         await sendFraudAlert({ user, type: "ml_suspect", provider, score });

//         return res.status(403).json({
//           success: false,
//           error: "Transaction bloquée pour vérification supplémentaire (sécurité renforcée).",
//           code: "AML_ML_BLOCK",
//           details: { score },
//         });
//       }
//     }

//     // Log OK
//     await logTransaction({
//       userId: user._id,
//       type: "initiate",
//       provider,
//       amount,
//       currency: currencyCode,
//       toEmail,
//       details: maskSensitive(body),
//       flagged: false,
//       flagReason: "",
//       ip: req.ip,
//     });

//     // ✅ expose snapshot AML
//     req.aml = {
//       status: "passed",
//       provider,
//       amount,
//       currency: currencyCode,
//       destinationCountryISO,
//       checkedAt: new Date().toISOString(),
//       stats: stats || null,
//     };

//     logger.info("[AML] AML OK", {
//       provider,
//       user: user.email,
//       amount,
//       currencyCode,
//       destinationCountryISO,
//       toEmail,
//       iban,
//       phoneNumber,
//     });

//     next();
//   } catch (e) {
//     logger.error("[AML] Exception", { err: e?.message || e, user: user?.email });

//     try {
//       await logTransaction({
//         userId: user?._id || null,
//         type: "initiate",
//         provider,
//         amount,
//         currency: currencyCode,
//         toEmail,
//         details: maskSensitive({ ...body, error: e?.message }),
//         flagged: true,
//         flagReason: "Erreur système AML",
//         ip: req.ip,
//       });
//     } catch {}

//     return res.status(500).json({ success: false, error: "Erreur système AML", code: "AML_SYSTEM_ERROR" });
//   }
// };










// File: src/middleware/aml.js
"use strict";

const logger = require("../utils/logger");

const {
  logTransaction,
  getUserTransactionsStats,
  getPEPOrSanctionedStatus,
  getMLScore,
  getBusinessKYBStatus,
} = require("../services/aml");

const { sendFraudAlert } = require("../utils/alert");

const {
  getCurrencySymbolByCode,
  getCurrencyCodeByCountry,
} = require("../tools/currency");

const {
  getDailyLimit,
  getSingleTxLimit,
} = require("../tools/amlLimits");

const RISKY_COUNTRIES_ISO = new Set([
  "IR",
  "KP",
  "SD",
  "SY",
  "CU",
  "RU",
  "AF",
  "SO",
  "YE",
  "VE",
  "LY",
]);

const ALLOWED_STRIPE_CURRENCY_CODES = ["EUR", "USD", "CAD"];

const EMPTY_BLACKLIST = Object.freeze({
  emails: [],
  ibans: [],
  phones: [],
  userIds: [],
  countries: [],
  names: [],
});

/* -------------------------------------------------------------------------- */
/* Blacklist                                                                  */
/* -------------------------------------------------------------------------- */

function toArrayOfStrings(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function loadBlacklist() {
  try {
    // eslint-disable-next-line global-require
    const loaded = require("../aml/blacklist.json");

    return {
      emails: toArrayOfStrings(loaded?.emails),
      ibans: toArrayOfStrings(loaded?.ibans),
      phones: toArrayOfStrings(loaded?.phones),
      userIds: toArrayOfStrings(loaded?.userIds),
      countries: toArrayOfStrings(loaded?.countries),
      names: toArrayOfStrings(loaded?.names),
    };
  } catch (err) {
    logger.warn("[AML] blacklist.json absent ou invalide, fallback vide", {
      error: err?.message || String(err),
    });

    return { ...EMPTY_BLACKLIST };
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeIban(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function normalizePhone(value) {
  return String(value || "")
    .trim()
    .replace(/[^\d+]/g, "");
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function makeSet(list, normalizer) {
  return new Set(toArrayOfStrings(list).map(normalizer).filter(Boolean));
}

const blacklistRaw = loadBlacklist();

const BLACKLIST = {
  emails: makeSet(blacklistRaw.emails, normalizeEmail),
  ibans: makeSet(blacklistRaw.ibans, normalizeIban),
  phones: makeSet(blacklistRaw.phones, normalizePhone),
  userIds: makeSet(blacklistRaw.userIds, (v) => String(v || "").trim()),
  countries: makeSet(blacklistRaw.countries, (v) =>
    String(v || "").trim().toUpperCase()
  ),
  names: makeSet(blacklistRaw.names, normalizeName),
};

/* -------------------------------------------------------------------------- */
/* Utils                                                                      */
/* -------------------------------------------------------------------------- */

function maskSensitive(obj) {
  const SENSITIVE_FIELDS = [
    "password",
    "cardNumber",
    "iban",
    "cvc",
    "securityCode",
    "securityAnswer",
    "otp",
    "code",
    "pin",
    "amlSecurityAnswer",
  ];

  if (!obj || typeof obj !== "object") return obj;

  const out = Array.isArray(obj) ? [] : {};

  for (const k of Object.keys(obj)) {
    if (SENSITIVE_FIELDS.includes(k)) {
      out[k] = "***";
    } else if (obj[k] && typeof obj[k] === "object") {
      out[k] = maskSensitive(obj[k]);
    } else {
      out[k] = obj[k];
    }
  }

  return out;
}

function parseAmount(v) {
  if (v == null) return 0;

  if (typeof v === "number") {
    return Number.isFinite(v) ? v : 0;
  }

  const s = String(v).replace(/\s/g, "").replace(",", ".").trim();
  const n = parseFloat(s);

  return Number.isFinite(n) ? n : 0;
}

function normalizeText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeStatus(value = "") {
  return normalizeText(value).replace(/\s+/g, "_");
}

function isApprovedStatus(value) {
  const status = normalizeStatus(value);

  return [
    "validé",
    "valide",
    "verified",
    "verifie",
    "validated",
    "approved",
    "complete",
    "completed",
    "success",
    "accepted",
    "active",
  ].includes(status);
}

function isPositiveFlag(value) {
  if (value === true) return true;

  if (value instanceof Date) {
    return Number.isFinite(value.getTime());
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0;
  }

  return isApprovedStatus(value);
}

function isEmailVerified(user = {}) {
  return (
    isPositiveFlag(user.emailVerified) ||
    isPositiveFlag(user.isEmailVerified) ||
    isPositiveFlag(user.emailVerifiedAt) ||
    isPositiveFlag(user.emailVerification?.verified) ||
    isPositiveFlag(user.emailVerification?.status) ||
    isPositiveFlag(user.verifications?.email?.verified) ||
    isPositiveFlag(user.verifications?.email?.status)
  );
}

function isPhoneVerified(user = {}) {
  return (
    isPositiveFlag(user.phoneVerified) ||
    isPositiveFlag(user.isPhoneVerified) ||
    isPositiveFlag(user.phoneVerifiedAt) ||
    isPositiveFlag(user.phoneVerification?.verified) ||
    isPositiveFlag(user.phoneVerification?.status) ||
    isPositiveFlag(user.verifications?.phone?.verified) ||
    isPositiveFlag(user.verifications?.phone?.status)
  );
}

function isBusinessUser(user = {}) {
  const userType = normalizeStatus(user.userType || user.type || user.accountType);
  const role = normalizeStatus(user.role);

  return (
    user.isBusiness === true ||
    userType === "business" ||
    userType === "entreprise" ||
    userType === "company" ||
    role === "business"
  );
}

function isKycValid(user = {}) {
  const level = Number(user.kycLevel || user.profile?.kycLevel || 0);

  return (
    level >= 2 ||
    isApprovedStatus(user.kycStatus) ||
    isApprovedStatus(user.kyc?.status) ||
    isApprovedStatus(user.kyc?.verificationStatus) ||
    isApprovedStatus(user.verifications?.kyc?.status) ||
    isPositiveFlag(user.kycVerified) ||
    isPositiveFlag(user.isKycVerified)
  );
}

async function isKybValid(user = {}) {
  const level = Number(
    user.businessKYBLevel ||
      user.business?.businessKYBLevel ||
      user.kybLevel ||
      0
  );

  if (
    level >= 2 ||
    isApprovedStatus(user.kybStatus) ||
    isApprovedStatus(user.businessStatus) ||
    isApprovedStatus(user.kyb?.status) ||
    isApprovedStatus(user.kyb?.verificationStatus) ||
    isApprovedStatus(user.business?.kybStatus) ||
    isApprovedStatus(user.business?.businessStatus) ||
    isPositiveFlag(user.kybVerified) ||
    isPositiveFlag(user.isKybVerified)
  ) {
    return true;
  }

  if (typeof getBusinessKYBStatus === "function") {
    try {
      const kybStatus = await getBusinessKYBStatus(
        user.businessId || user._id || user.id
      );

      return isApprovedStatus(kybStatus);
    } catch {
      return false;
    }
  }

  return false;
}

function normalizeCountryToISO(country) {
  if (!country) return "";

  const raw = String(country).trim();
  if (!raw) return "";

  if (/^[A-Z]{2}$/i.test(raw)) {
    return raw.toUpperCase();
  }

  const n = normalizeText(raw);

  const map = {
    france: "FR",
    "cote d'ivoire": "CI",
    "cote d ivoire": "CI",
    "cote divoire": "CI",
    "ivory coast": "CI",
    "burkina faso": "BF",
    mali: "ML",
    senegal: "SN",
    cameroun: "CM",
    cameroon: "CM",
    belgique: "BE",
    belgium: "BE",
    allemagne: "DE",
    germany: "DE",
    usa: "US",
    "etats-unis": "US",
    "etats unis": "US",
    "united states": "US",
    canada: "CA",
    uk: "GB",
    "royaume-uni": "GB",
    "royaume uni": "GB",
    "united kingdom": "GB",
    russie: "RU",
    russia: "RU",
  };

  return map[n] || "";
}

function resolveProvider(req) {
  const rp = String(req.routedProvider || "").trim().toLowerCase();
  if (rp) return rp;

  const b = req.body || {};

  const p =
    String(b.provider || "").trim().toLowerCase() ||
    String(b.metadata?.provider || "").trim().toLowerCase() ||
    String(b.destination || "").trim().toLowerCase() ||
    String(b.funds || "").trim().toLowerCase();

  return p || "paynoval";
}

function normalizeCurrencyISO(v) {
  const s0 = String(v || "").trim().toUpperCase();
  if (!s0) return "";

  const s = s0.replace(/\u00A0/g, " ");

  if (s === "FCFA" || s === "CFA" || s === "F CFA" || s.includes("CFA")) {
    return "XOF";
  }

  if (s === "€") return "EUR";
  if (s === "$") return "USD";
  if (s === "£") return "GBP";

  const letters = s.replace(/[^A-Z]/g, "");

  if (["CAD", "USD", "EUR", "GBP", "XOF", "XAF"].includes(letters)) {
    return letters;
  }

  if (/^[A-Z]{3}$/.test(letters)) return letters;
  if (/^[A-Z]{3}$/.test(s)) return s;

  return "";
}

function resolveCurrencyCode(req) {
  const b = req.body || {};
  const user = req.user || {};

  const candidate =
    b.money?.source?.currency ||
    b.senderCurrencySymbol ||
    b.currencySource ||
    b.senderCurrencyCode ||
    b.currencyCode ||
    b.currencySender ||
    b.currency ||
    b.selectedCurrency ||
    b.fromCurrency ||
    "";

  let iso = normalizeCurrencyISO(candidate);

  if (!iso) {
    const senderCountry =
      user?.selectedCountry || user?.country || user?.countryCode || "";
    iso = normalizeCurrencyISO(getCurrencyCodeByCountry(senderCountry));
  }

  if (!iso) {
    const lastResortCountry =
      b.senderCountry || b.originCountry || b.fromCountry || b.country || "";
    iso = normalizeCurrencyISO(getCurrencyCodeByCountry(lastResortCountry));
  }

  if (!/^[A-Z]{3}$/.test(iso)) iso = "USD";

  return iso;
}

function resolveDestinationCountryISO(req) {
  const b = req.body || {};
  const user = req.user || {};

  const raw =
    b.destinationCountry ||
    b.countryTarget ||
    b.toCountry ||
    b.country ||
    user?.country ||
    user?.selectedCountry ||
    "";

  return normalizeCountryToISO(raw);
}

function resolveTargetIdentifiers(body = {}) {
  const recipientInfo =
    body.recipientInfo && typeof body.recipientInfo === "object"
      ? body.recipientInfo
      : {};

  const toEmail =
    body.toEmail ||
    body.email ||
    body.recipientEmail ||
    recipientInfo.email ||
    recipientInfo.mail ||
    "";

  const iban =
    body.iban ||
    body.toIBAN ||
    body.recipientIban ||
    recipientInfo.iban ||
    "";

  const phoneNumber =
    body.phoneNumber ||
    body.toPhone ||
    body.phone ||
    body.recipientPhone ||
    recipientInfo.phone ||
    recipientInfo.numero ||
    "";

  const names = [
    body.toName,
    body.recipientName,
    body.accountHolder,
    body.cardHolder,
    recipientInfo.name,
    recipientInfo.accountHolderName,
    recipientInfo.holder,
  ].filter(Boolean);

  return {
    toEmail: String(toEmail || "").trim(),
    iban: String(iban || "").trim(),
    phoneNumber: String(phoneNumber || "").trim(),
    names,
  };
}

function getUserId(user = {}) {
  return String(user._id || user.id || "").trim();
}

function findBlacklistHit({
  user,
  toEmail,
  iban,
  phoneNumber,
  destinationCountryISO,
  names,
}) {
  const userId = getUserId(user);
  const email = normalizeEmail(toEmail);
  const normIban = normalizeIban(iban);
  const phone = normalizePhone(phoneNumber);
  const country = String(destinationCountryISO || "").trim().toUpperCase();

  if (userId && BLACKLIST.userIds.has(userId)) {
    return { blocked: true, code: "BLACKLISTED_USER", field: "userId" };
  }

  if (email && BLACKLIST.emails.has(email)) {
    return { blocked: true, code: "BLACKLISTED_EMAIL", field: "email" };
  }

  if (normIban && BLACKLIST.ibans.has(normIban)) {
    return { blocked: true, code: "BLACKLISTED_IBAN", field: "iban" };
  }

  if (phone && BLACKLIST.phones.has(phone)) {
    return { blocked: true, code: "BLACKLISTED_PHONE", field: "phone" };
  }

  if (country && BLACKLIST.countries.has(country)) {
    return { blocked: true, code: "BLACKLISTED_COUNTRY", field: "country" };
  }

  for (const name of names || []) {
    const normalizedName = normalizeName(name);

    if (normalizedName && BLACKLIST.names.has(normalizedName)) {
      return { blocked: true, code: "BLACKLISTED_NAME", field: "name" };
    }
  }

  const senderEmail = normalizeEmail(user?.email);
  const senderPhone = normalizePhone(user?.phone || user?.phoneNumber);

  if (senderEmail && BLACKLIST.emails.has(senderEmail)) {
    return {
      blocked: true,
      code: "BLACKLISTED_SENDER_EMAIL",
      field: "senderEmail",
    };
  }

  if (senderPhone && BLACKLIST.phones.has(senderPhone)) {
    return {
      blocked: true,
      code: "BLACKLISTED_SENDER_PHONE",
      field: "senderPhone",
    };
  }

  return { blocked: false, code: "", field: "" };
}

async function safeSendFraudAlert(payload) {
  try {
    await sendFraudAlert(payload);
  } catch (err) {
    logger.warn("[AML] sendFraudAlert ignoré", {
      error: err?.message || String(err),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Middleware AML                                                             */
/* -------------------------------------------------------------------------- */

module.exports = async function amlMiddleware(req, res, next) {
  const provider = resolveProvider(req);
  const user = req.user;
  const body = req.body || {};

  const { toEmail, iban, phoneNumber, names } = resolveTargetIdentifiers(body);
  const destinationCountryISO = resolveDestinationCountryISO(req);

  const amount = parseAmount(
    body.amountSource ?? body.amount ?? body.money?.source?.amount
  );

  const currencyCode = resolveCurrencyCode(req);
  const currencySymbol = getCurrencySymbolByCode(currencyCode);

  try {
    if (!user || !user._id) {
      logger.warn("[AML] User manquant", { provider });

      await logTransaction({
        userId: null,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "User manquant",
        ip: req.ip,
      });

      return res.status(401).json({
        success: false,
        error: "Merci de vous connecter pour poursuivre.",
        code: "AUTH_REQUIRED",
      });
    }

    if (!isEmailVerified(user)) {
      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Email non vérifié",
        ip: req.ip,
      });

      return res.status(428).json({
        success: false,
        error:
          "Veuillez vérifier votre adresse email avant d’effectuer une transaction.",
        code: "EMAIL_NOT_VERIFIED",
      });
    }

    if (!isPhoneVerified(user)) {
      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Téléphone non vérifié",
        ip: req.ip,
      });

      return res.status(428).json({
        success: false,
        error:
          "Veuillez vérifier votre numéro de téléphone avant d’effectuer une transaction.",
        code: "PHONE_NOT_VERIFIED",
      });
    }

    if (isBusinessUser(user)) {
      const kybValid = await isKybValid(user);

      if (!kybValid) {
        logger.warn("[AML] KYB insuffisant", {
          provider,
          user: user.email,
          kybStatus: user.kybStatus,
          businessStatus: user.businessStatus,
        });

        await logTransaction({
          userId: user._id,
          type: "initiate",
          provider,
          amount,
          currency: currencyCode,
          toEmail,
          details: maskSensitive(body),
          flagged: true,
          flagReason: "KYB insuffisant",
          ip: req.ip,
        });

        await safeSendFraudAlert({
          user,
          type: "kyb_insuffisant",
          provider,
        });

        return res.status(403).json({
          success: false,
          error:
            "L’accès aux transactions est temporairement restreint. Merci de compléter la vérification d’entreprise.",
          code: "KYB_REQUIRED",
        });
      }
    } else if (!isKycValid(user)) {
      logger.warn("[AML] KYC insuffisant", {
        provider,
        user: user.email,
        kycStatus: user.kycStatus,
        kycLevel: user.kycLevel,
      });

      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "KYC insuffisant",
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "kyc_insuffisant",
        provider,
      });

      return res.status(403).json({
        success: false,
        error: "Votre vérification d’identité (KYC) n’est pas finalisée.",
        code: "KYC_REQUIRED",
      });
    }

    const pepStatus = await getPEPOrSanctionedStatus(user, {
      toEmail,
      iban,
      phoneNumber,
    });

    if (pepStatus && pepStatus.sanctioned) {
      logger.error("[AML] PEP/Sanction detected", {
        user: user.email,
        reason: pepStatus.reason,
      });

      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: pepStatus.reason,
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "pep_sanction",
        provider,
        reason: pepStatus.reason,
      });

      return res.status(403).json({
        success: false,
        error:
          "Impossible d’effectuer la transaction : bénéficiaire sur liste de surveillance.",
        code: "PEP_SANCTIONED",
      });
    }

    const blacklistHit = findBlacklistHit({
      user,
      toEmail,
      iban,
      phoneNumber,
      destinationCountryISO,
      names,
    });

    if (blacklistHit.blocked) {
      logger.warn("[AML] Cible blacklistée", {
        provider,
        field: blacklistHit.field,
        code: blacklistHit.code,
      });

      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive({
          ...body,
          blacklistHit: {
            field: blacklistHit.field,
            code: blacklistHit.code,
          },
        }),
        flagged: true,
        flagReason: `Blacklist: ${blacklistHit.code}`,
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "blacklist",
        provider,
        field: blacklistHit.field,
        code: blacklistHit.code,
      });

      return res.status(403).json({
        success: false,
        error: "Transaction interdite : restriction conformité (AML).",
        code: blacklistHit.code || "BLACKLISTED",
      });
    }

    if (destinationCountryISO && RISKY_COUNTRIES_ISO.has(destinationCountryISO)) {
      logger.warn("[AML] Pays à risque détecté", {
        provider,
        user: user.email,
        destinationCountryISO,
        destinationCountryRaw: body.destinationCountry || body.country || null,
      });

      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Pays à risque",
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "pays_risque",
        provider,
        country: destinationCountryISO,
      });

      return res.status(403).json({
        success: false,
        error: "Transaction bloquée : pays de destination non autorisé.",
        code: "RISKY_COUNTRY",
        details: {
          country: destinationCountryISO,
        },
      });
    }

    const singleTxLimit = getSingleTxLimit(provider, currencyCode);

    if (amount > singleTxLimit) {
      logger.warn("[AML] Plafond single dépassé", {
        provider,
        user: user.email,
        amount,
        max: singleTxLimit,
      });

      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: `Plafond single dépassé (${amount} > ${singleTxLimit} ${currencyCode})`,
        ip: req.ip,
      });

      return res.status(403).json({
        success: false,
        error: `Plafond par transaction: ${singleTxLimit} ${currencySymbol}.`,
        code: "AML_SINGLE_LIMIT",
        details: {
          max: singleTxLimit,
          currencyCode,
          currencySymbol,
          provider,
        },
      });
    }

    const dailyLimit = getDailyLimit(provider, currencyCode);

    let stats = null;

    try {
      stats = await getUserTransactionsStats(user._id, provider, currencyCode);
    } catch (err) {
      logger.warn("[AML] stats indisponibles", {
        error: err?.message || String(err),
        provider,
        userId: String(user._id),
      });
    }

    const dailyTotal = Number.isFinite(Number(stats?.dailyTotal))
      ? Number(stats.dailyTotal)
      : 0;

    const futureTotal = dailyTotal + (amount || 0);

    if (futureTotal > dailyLimit) {
      logger.warn("[AML] Plafond journalier dépassé", {
        provider,
        user: user.email,
        dailyTotal,
        amount,
        dailyLimit,
      });

      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: `Plafond journalier dépassé (${dailyTotal} + ${amount} > ${dailyLimit} ${currencyCode})`,
        ip: req.ip,
      });

      return res.status(403).json({
        success: false,
        error: `Plafond journalier atteint (${dailyLimit} ${currencySymbol}). Réessayez demain.`,
        code: "AML_DAILY_LIMIT",
        details: {
          max: dailyLimit,
          currencyCode,
          currencySymbol,
          provider,
          dailyTotal,
        },
      });
    }

    const userQuestions = Array.isArray(user.securityQuestions)
      ? user.securityQuestions
      : [];

    const needAmlChallenge =
      typeof amount === "number" &&
      amount >= dailyLimit * 0.9 &&
      userQuestions.length > 0;

    if (needAmlChallenge) {
      const amlQ = body.amlSecurityQuestion;
      const amlA = body.amlSecurityAnswer;

      if (!amlQ || !amlA) {
        const qIdx = Math.floor(Math.random() * userQuestions.length);

        return res.status(428).json({
          success: false,
          error: "AML_SECURITY_CHALLENGE",
          code: "AML_SECURITY_CHALLENGE",
          need_security_answer: true,
          amlSecurityQuestion: userQuestions[qIdx].question,
        });
      }

      const idx = userQuestions.findIndex((q) => q.question === amlQ);

      if (idx === -1) {
        return res.status(403).json({
          success: false,
          error: "Question AML inconnue.",
          code: "AML_QUESTION_UNKNOWN",
        });
      }

      const ok =
        String(userQuestions[idx].answer || "").trim().toLowerCase() ===
        String(amlA || "").trim().toLowerCase();

      if (!ok) {
        logger.warn("[AML] Réponse AML incorrecte", {
          user: user.email,
        });

        await logTransaction({
          userId: user._id,
          type: "initiate",
          provider,
          amount,
          currency: currencyCode,
          toEmail,
          details: maskSensitive(body),
          flagged: true,
          flagReason: "AML Sécurité question échouée",
          ip: req.ip,
        });

        await safeSendFraudAlert({
          user,
          type: "aml_security_failed",
          provider,
        });

        return res.status(403).json({
          success: false,
          error: "Réponse AML incorrecte.",
          code: "AML_SECURITY_FAILED",
        });
      }
    }

    if (stats && Number(stats.lastHour || 0) > 10) {
      logger.warn("[AML] Volume suspect sur 1h", {
        provider,
        user: user.email,
        lastHour: stats.lastHour,
      });

      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Volume élevé 1h",
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "volume_1h",
        provider,
        count: stats.lastHour,
      });

      return res.status(403).json({
        success: false,
        error: "Trop de transactions sur 1h, vérification requise.",
        code: "AML_RATE_LIMIT_1H",
        details: {
          count: stats.lastHour,
        },
      });
    }

    if (stats && Number(stats.sameDestShortTime || 0) > 3) {
      logger.warn("[AML] Structuring suspect", {
        provider,
        user: user.email,
        count: stats.sameDestShortTime,
      });

      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Pattern structuring",
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "structuring",
        provider,
        count: stats.sameDestShortTime,
      });

      return res.status(403).json({
        success: false,
        error: "Activité inhabituelle détectée. Vérification requise.",
        code: "AML_STRUCTURING",
        details: {
          count: stats.sameDestShortTime,
        },
      });
    }

    if (
      provider === "stripe" &&
      currencyCode &&
      !ALLOWED_STRIPE_CURRENCY_CODES.includes(currencyCode)
    ) {
      logger.warn("[AML] Devise Stripe non autorisée", {
        user: user.email,
        currencyCode,
      });

      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Devise interdite Stripe",
        ip: req.ip,
      });

      await safeSendFraudAlert({
        user,
        type: "devise_interdite",
        provider,
        currencyCode,
      });

      return res.status(403).json({
        success: false,
        error: "Devise non autorisée.",
        code: "STRIPE_CURRENCY_NOT_ALLOWED",
        details: {
          currencyCode,
          currencySymbol,
        },
      });
    }

    if (typeof getMLScore === "function") {
      const score = await getMLScore(body, user);

      if (score && score >= 0.9) {
        logger.warn("[AML] ML scoring élevé", {
          user: user.email,
          score,
        });

        await logTransaction({
          userId: user._id,
          type: "initiate",
          provider,
          amount,
          currency: currencyCode,
          toEmail,
          details: maskSensitive(body),
          flagged: true,
          flagReason: "Scoring ML élevé",
          ip: req.ip,
        });

        await safeSendFraudAlert({
          user,
          type: "ml_suspect",
          provider,
          score,
        });

        return res.status(403).json({
          success: false,
          error:
            "Transaction bloquée pour vérification supplémentaire (sécurité renforcée).",
          code: "AML_ML_BLOCK",
          details: {
            score,
          },
        });
      }
    }

    await logTransaction({
      userId: user._id,
      type: "initiate",
      provider,
      amount,
      currency: currencyCode,
      toEmail,
      details: maskSensitive(body),
      flagged: false,
      flagReason: "",
      ip: req.ip,
    });

    req.aml = {
      status: "passed",
      provider,
      amount,
      currency: currencyCode,
      destinationCountryISO,
      checkedAt: new Date().toISOString(),
      stats: stats || null,
      blacklistChecked: true,
    };

    logger.info("[AML] AML OK", {
      provider,
      user: user.email,
      amount,
      currencyCode,
      destinationCountryISO,
      toEmail,
      iban: iban ? "***" : "",
      phoneNumber: phoneNumber ? "***" : "",
    });

    return next();
  } catch (e) {
    logger.error("[AML] Exception", {
      err: e?.message || e,
      user: user?.email,
    });

    try {
      await logTransaction({
        userId: user?._id || null,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive({
          ...body,
          error: e?.message,
        }),
        flagged: true,
        flagReason: "Erreur système AML",
        ip: req.ip,
      });
    } catch {}

    return res.status(500).json({
      success: false,
      error: "Erreur système AML",
      code: "AML_SYSTEM_ERROR",
    });
  }
};