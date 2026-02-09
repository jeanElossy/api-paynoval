// File: src/middleware/amlMiddleware.js
"use strict";

const logger = require("../utils/logger");
const {
  logTransaction,
  getUserTransactionsStats,
  getPEPOrSanctionedStatus,
  getMLScore,
  getBusinessKYBStatus,
} = require("../services/aml");

const blacklist = require("../aml/blacklist.json");
const { sendFraudAlert } = require("../utils/alert");
const { getCurrencySymbolByCode, getCurrencyCodeByCountry } = require("../tools/currency");
const { getDailyLimit, getSingleTxLimit } = require("../tools/amlLimits");

const RISKY_COUNTRIES_ISO = new Set(["IR", "KP", "SD", "SY", "CU", "RU", "AF", "SO", "YE", "VE", "LY"]);
const ALLOWED_STRIPE_CURRENCY_CODES = ["EUR", "USD", "CAD"];

// --------------------------
// utils
// --------------------------
function maskSensitive(obj) {
  const SENSITIVE_FIELDS = ["password", "cardNumber", "iban", "cvc", "securityCode", "otp", "code", "pin"];
  if (!obj || typeof obj !== "object") return obj;

  const out = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    if (SENSITIVE_FIELDS.includes(k)) out[k] = "***";
    else if (obj[k] && typeof obj[k] === "object") out[k] = maskSensitive(obj[k]);
    else out[k] = obj[k];
  }
  return out;
}

function parseAmount(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/\s/g, "").replace(",", ".").trim();
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function normalizeCountryToISO(country) {
  if (!country) return "";
  const raw = String(country).trim();
  if (!raw) return "";

  if (/^[A-Z]{2}$/.test(raw.toUpperCase())) return raw.toUpperCase();

  const n = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  const map = {
    france: "FR",
    "cote d'ivoire": "CI",
    "cote divoire": "CI",
    "ivory coast": "CI",
    "burkina faso": "BF",
    mali: "ML",
    senegal: "SN",
    cameroun: "CM",
    cameroon: "CM",
    belgique: "BE",
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

  if (s === "FCFA" || s === "CFA" || s === "F CFA" || s.includes("CFA")) return "XOF";
  if (s === "€") return "EUR";
  if (s === "$") return "USD";
  if (s === "£") return "GBP";

  const letters = s.replace(/[^A-Z]/g, "");
  if (["CAD", "USD", "EUR", "GBP", "XOF", "XAF"].includes(letters)) return letters;

  if (/^[A-Z]{3}$/.test(letters)) return letters;
  if (/^[A-Z]{3}$/.test(s)) return s;

  return "";
}

/**
 * ✅ currency resolver (PRO)
 * On tente dans l'ordre:
 * - money.source.currency
 * - senderCurrencySymbol (normalisé dans routes)
 * - currencySource / currencyCode / currency etc.
 * - fallback via country user/payload
 */
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
    const senderCountry = user?.selectedCountry || user?.country || user?.countryCode || "";
    iso = normalizeCurrencyISO(getCurrencyCodeByCountry(senderCountry));
  }

  if (!iso) {
    const lastResortCountry = b.senderCountry || b.originCountry || b.fromCountry || b.country || "";
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
    b.country ||
    user?.country ||
    user?.selectedCountry ||
    "";

  return normalizeCountryToISO(raw);
}

module.exports = async function amlMiddleware(req, res, next) {
  const provider = resolveProvider(req);
  const user = req.user;

  const body = req.body || {};
  const toEmail = body.toEmail || body.email || body.recipientEmail || "";
  const iban = body.iban || body.toIBAN || "";
  const phoneNumber = body.phoneNumber || body.toPhone || body.phone || "";

  const destinationCountryISO = resolveDestinationCountryISO(req);

  // amount: support amountSource, amount, money.source.amount
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

    // KYC/KYB checks
    if (user.type === "business" || user.isBusiness) {
      let kybStatus = user.kybStatus;
      if (typeof getBusinessKYBStatus === "function") {
        kybStatus = await getBusinessKYBStatus(user.businessId || user._id);
      }
      if (!kybStatus || kybStatus !== "validé") {
        logger.warn("[AML] KYB insuffisant", { provider, user: user.email });
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
        await sendFraudAlert({ user, type: "kyb_insuffisant", provider });
        return res.status(403).json({
          success: false,
          error:
            "L’accès aux transactions est temporairement restreint. Merci de compléter la vérification d’entreprise.",
          code: "KYB_REQUIRED",
        });
      }
    } else {
      if (!user.kycLevel || user.kycLevel < 2) {
        logger.warn("[AML] KYC insuffisant", { provider, user: user.email });
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
        await sendFraudAlert({ user, type: "kyc_insuffisant", provider });
        return res.status(403).json({
          success: false,
          error: "Votre vérification d’identité (KYC) n’est pas finalisée.",
          code: "KYC_REQUIRED",
        });
      }
    }

    // PEP/Sanction
    const pepStatus = await getPEPOrSanctionedStatus(user, { toEmail, iban, phoneNumber });
    if (pepStatus && pepStatus.sanctioned) {
      logger.error("[AML] PEP/Sanction detected", { user: user.email, reason: pepStatus.reason });
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
      await sendFraudAlert({ user, type: "pep_sanction", provider, reason: pepStatus.reason });
      return res.status(403).json({
        success: false,
        error: "Impossible d’effectuer la transaction : bénéficiaire sur liste de surveillance.",
        code: "PEP_SANCTIONED",
      });
    }

    // Blacklist
    if (
      (toEmail && Array.isArray(blacklist.emails) && blacklist.emails.includes(toEmail)) ||
      (iban && Array.isArray(blacklist.ibans) && blacklist.ibans.includes(iban)) ||
      (phoneNumber && Array.isArray(blacklist.phones) && blacklist.phones.includes(phoneNumber))
    ) {
      logger.warn("[AML] Cible blacklistée", { provider, toEmail, iban, phoneNumber });
      await logTransaction({
        userId: user._id,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive(body),
        flagged: true,
        flagReason: "Blacklist",
        ip: req.ip,
      });
      await sendFraudAlert({ user, type: "blacklist", provider, toEmail, iban, phoneNumber });
      return res.status(403).json({
        success: false,
        error: "Transaction interdite : restriction conformité (AML).",
        code: "BLACKLISTED",
      });
    }

    // Pays à risque (destination ISO2)
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

      await sendFraudAlert({ user, type: "pays_risque", provider, country: destinationCountryISO });

      return res.status(403).json({
        success: false,
        error: "Transaction bloquée : pays de destination non autorisé.",
        code: "RISKY_COUNTRY",
        details: { country: destinationCountryISO },
      });
    }

    // Limites
    const singleTxLimit = getSingleTxLimit(provider, currencyCode);
    if (amount > singleTxLimit) {
      logger.warn("[AML] Plafond single dépassé", { provider, user: user.email, amount, max: singleTxLimit });

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
        details: { max: singleTxLimit, currencyCode, currencySymbol, provider },
      });
    }

    const dailyLimit = getDailyLimit(provider, currencyCode);

    let stats = null;
    try {
      stats = await getUserTransactionsStats(user._id, provider, currencyCode);
    } catch {}

    const dailyTotal = stats && Number.isFinite(stats.dailyTotal) ? stats.dailyTotal : 0;
    const futureTotal = dailyTotal + (amount || 0);

    if (futureTotal > dailyLimit) {
      logger.warn("[AML] Plafond journalier dépassé", { provider, user: user.email, dailyTotal, amount, dailyLimit });

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
        details: { max: dailyLimit, currencyCode, currencySymbol, provider, dailyTotal },
      });
    }

    // Challenge AML (optionnel)
    const userQuestions = Array.isArray(user.securityQuestions) ? user.securityQuestions : [];
    const needAmlChallenge =
      typeof amount === "number" && amount >= dailyLimit * 0.9 && userQuestions.length > 0;

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
        logger.warn("[AML] Réponse AML incorrecte", { user: user.email });

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

        await sendFraudAlert({ user, type: "aml_security_failed", provider });

        return res.status(403).json({
          success: false,
          error: "Réponse AML incorrecte.",
          code: "AML_SECURITY_FAILED",
        });
      }
    }

    // Patterns
    if (stats && stats.lastHour > 10) {
      logger.warn("[AML] Volume suspect sur 1h", { provider, user: user.email, lastHour: stats.lastHour });

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

      await sendFraudAlert({ user, type: "volume_1h", provider, count: stats.lastHour });

      return res.status(403).json({
        success: false,
        error: "Trop de transactions sur 1h, vérification requise.",
        code: "AML_RATE_LIMIT_1H",
        details: { count: stats.lastHour },
      });
    }

    if (stats && stats.sameDestShortTime > 3) {
      logger.warn("[AML] Structuring suspect", { provider, user: user.email, count: stats.sameDestShortTime });

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

      await sendFraudAlert({ user, type: "structuring", provider, count: stats.sameDestShortTime });

      return res.status(403).json({
        success: false,
        error: "Activité inhabituelle détectée. Vérification requise.",
        code: "AML_STRUCTURING",
        details: { count: stats.sameDestShortTime },
      });
    }

    // Stripe currency allowed
    if (provider === "stripe" && currencyCode && !ALLOWED_STRIPE_CURRENCY_CODES.includes(currencyCode)) {
      logger.warn("[AML] Devise Stripe non autorisée", { user: user.email, currencyCode });

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

      await sendFraudAlert({ user, type: "devise_interdite", provider, currencyCode });

      return res.status(403).json({
        success: false,
        error: "Devise non autorisée.",
        code: "STRIPE_CURRENCY_NOT_ALLOWED",
        details: { currencyCode, currencySymbol },
      });
    }

    // ML scoring (optionnel)
    if (typeof getMLScore === "function") {
      const score = await getMLScore(body, user);
      if (score && score >= 0.9) {
        logger.warn("[AML] ML scoring élevé", { user: user.email, score });

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

        await sendFraudAlert({ user, type: "ml_suspect", provider, score });

        return res.status(403).json({
          success: false,
          error: "Transaction bloquée pour vérification supplémentaire (sécurité renforcée).",
          code: "AML_ML_BLOCK",
          details: { score },
        });
      }
    }

    // Log OK
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

    // ✅ expose snapshot AML
    req.aml = {
      status: "passed",
      provider,
      amount,
      currency: currencyCode,
      destinationCountryISO,
      checkedAt: new Date().toISOString(),
      stats: stats || null,
    };

    logger.info("[AML] AML OK", {
      provider,
      user: user.email,
      amount,
      currencyCode,
      destinationCountryISO,
      toEmail,
      iban,
      phoneNumber,
    });

    next();
  } catch (e) {
    logger.error("[AML] Exception", { err: e?.message || e, user: user?.email });

    try {
      await logTransaction({
        userId: user?._id || null,
        type: "initiate",
        provider,
        amount,
        currency: currencyCode,
        toEmail,
        details: maskSensitive({ ...body, error: e?.message }),
        flagged: true,
        flagReason: "Erreur système AML",
        ip: req.ip,
      });
    } catch {}

    return res.status(500).json({ success: false, error: "Erreur système AML", code: "AML_SYSTEM_ERROR" });
  }
};
