// File: api-gateway/src/utils/referralUtils.js
"use strict";

const axios = require("axios");
const crypto = require("crypto");

let logger = console;
try {
  logger = require("../logger");
} catch {}

const config = require("../config");
const Transaction = require("../models/Transaction");

const PRINCIPAL_URL = (config.principalUrl || process.env.PRINCIPAL_URL || "").replace(/\/+$/, "");

// ✅ IMPORTANT: token interne du principal séparé
const PRINCIPAL_INTERNAL_TOKEN =
  process.env.PRINCIPAL_INTERNAL_TOKEN ||
  config.principalInternalToken ||
  process.env.INTERNAL_TOKEN || // fallback legacy
  config.internalToken || // fallback legacy (à éviter si différent)
  "";

if (!PRINCIPAL_URL) {
  logger.warn("[Referral] PRINCIPAL_URL manquant (config.principalUrl / ENV PRINCIPAL_URL).");
}
if (!PRINCIPAL_INTERNAL_TOKEN) {
  logger.warn(
    "[Referral] PRINCIPAL_INTERNAL_TOKEN manquant (ENV PRINCIPAL_INTERNAL_TOKEN). Les endpoints /internal/referral/* seront ignorés."
  );
} else {
  if (!process.env.PRINCIPAL_INTERNAL_TOKEN && !config.principalInternalToken) {
    logger.warn(
      "[Referral] PRINCIPAL_INTERNAL_TOKEN non défini explicitement. Fallback utilisé (INTERNAL_TOKEN/config.internalToken). Recommandé: définir ENV PRINCIPAL_INTERNAL_TOKEN."
    );
  }
}

const safeNumber = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

const isConfirmedStatus = (s) => {
  const st = String(s || "").toLowerCase();
  return st === "confirmed" || st === "success" || st === "validated" || st === "completed";
};

function safeErrMessage(err) {
  const status = err?.response?.status;
  const data = err?.response?.data;

  let msg =
    (typeof data === "string" && data) ||
    (data && typeof data === "object" && (data.error || data.message || JSON.stringify(data))) ||
    err?.message ||
    String(err);

  if (typeof msg === "string" && msg.length > 450) msg = msg.slice(0, 450) + "…";
  return { status, msg };
}

const buildHeaders = (authToken) => ({
  ...(PRINCIPAL_INTERNAL_TOKEN ? { "x-internal-token": PRINCIPAL_INTERNAL_TOKEN } : {}),
  ...(authToken ? { Authorization: authToken } : {}),
});

async function postInternal(paths, payload, authToken) {
  if (!PRINCIPAL_URL) throw new Error("PRINCIPAL_URL manquant");
  if (!PRINCIPAL_INTERNAL_TOKEN) return { ok: false, skipped: true, reason: "PRINCIPAL_INTERNAL_TOKEN_MISSING" };

  let lastErr = null;

  for (const p of paths) {
    const url = `${PRINCIPAL_URL}${p}`;
    try {
      const res = await axios.post(url, payload, {
        headers: buildHeaders(authToken),
        timeout: 8000,
      });
      return { ok: true, data: res.data, path: p };
    } catch (e) {
      lastErr = e;
      const { status, msg } = safeErrMessage(e);
      logger.warn("[Referral] postInternal failed", { url, status, message: msg });
      // 404/401/403 => on tente le prochain path
      continue;
    }
  }

  return { ok: false, error: lastErr };
}

function cleanCountry(raw) {
  if (typeof raw !== "string") return "";
  const step1 = raw.replace(/&#x27;/g, "'");
  return step1.replace(/^[^\p{L}]*/u, "");
}

function normalizeCountry(str) {
  if (typeof str !== "string") return "";
  const noAccents = str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return noAccents.replace(/’/g, "'").trim().toLowerCase();
}

const AMERICA_COUNTRIES = ["canada", "usa", "united states", "united states of america"];
const EUROPE_COUNTRIES = ["france", "belgique", "belgium", "allemagne", "germany"];
const AFRICA_COUNTRIES = [
  "cote d'ivoire", "cote d ivoire", "cote divoire", "cote-d-ivoire",
  "mali", "burkina faso", "senegal", "cameroun", "cameroon",
  "benin", "togo", "ghana",
];

function getRegionFromCountry(countryRaw) {
  const normalized = normalizeCountry(cleanCountry(countryRaw));
  if (!normalized) return null;
  if (AMERICA_COUNTRIES.includes(normalized)) return "AMERICA";
  if (EUROPE_COUNTRIES.includes(normalized)) return "EUROPE";
  if (AFRICA_COUNTRIES.includes(normalized)) return "AFRICA";
  return null;
}

const THRESHOLDS_BY_REGION = {
  AMERICA: { currency: "CAD", minTotal: 200 },
  EUROPE: { currency: "EUR", minTotal: 200 },
  AFRICA: { currency: "XOF", minTotal: 60000 },
};

const BONUSES_BY_REGION = {
  AMERICA: { currency: "CAD", parrain: 5, filleul: 3 },
  EUROPE: { currency: "EUR", parrain: 4, filleul: 2 },
  AFRICA: { currency: "XOF", parrain: 2000, filleul: 1000 },
};

function TransactionModel() {
  return Transaction;
}

async function fetchUserFromMain(userId, authToken) {
  if (!PRINCIPAL_URL) return null;
  const url = `${PRINCIPAL_URL}/users/${userId}`;

  // ⚠️ Endpoints publics -> nécessitent souvent un Bearer token user
  if (!authToken) {
    logger.warn("[Referral] fetchUserFromMain skipped (authToken manquant) pour /users/:id", { userId });
    return null;
  }

  try {
    const res = await axios.get(url, { headers: buildHeaders(authToken), timeout: 8000 });
    return res.data?.data || null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function patchUserInMain(userId, updates, authToken) {
  if (!PRINCIPAL_URL) return;

  // ⚠️ Endpoints publics -> nécessitent souvent un Bearer token user/admin
  if (!authToken) {
    logger.warn("[Referral] patchUserInMain skipped (authToken manquant) pour /users/:id", { userId });
    return;
  }

  const url = `${PRINCIPAL_URL}/users/${userId}`;
  await axios.patch(url, updates, { headers: buildHeaders(authToken), timeout: 8000 });
}

async function creditBalanceInMain(userId, amount, currency, description, authToken) {
  if (!PRINCIPAL_URL) return;
  if (!PRINCIPAL_INTERNAL_TOKEN) throw new Error("PRINCIPAL_INTERNAL_TOKEN manquant");

  const url = `${PRINCIPAL_URL}/users/${userId}/credit-internal`;
  await axios.post(url, { amount, currency, description }, { headers: buildHeaders(authToken), timeout: 8000 });
}

async function sendNotificationToMain(userId, title, message, data = {}, authToken) {
  if (!PRINCIPAL_URL) return;

  // Selon ton backend, /notifications peut exiger auth user.
  // Si c'est interne-only, tu peux le migrer vers une route /internal/notifications.
  if (!authToken) {
    logger.warn("[Referral] sendNotificationToMain skipped (authToken manquant) pour /notifications", { userId, title });
    return;
  }

  const url = `${PRINCIPAL_URL}/notifications`;
  try {
    await axios.post(url, { recipient: userId, title, message, data }, { headers: buildHeaders(authToken), timeout: 8000 });
  } catch (err) {
    logger.warn("[Referral] Notification failed:", err?.response?.data || err.message);
  }
}

function generatePNVReferralCode() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  const all = letters + digits;

  const buf = crypto.randomBytes(4);
  let raw = "";
  for (let i = 0; i < 4; i++) raw += all[buf[i] % all.length];

  let arr = raw.split("");
  if (!/[0-9]/.test(raw)) arr[crypto.randomBytes(1)[0] % 4] = digits[crypto.randomBytes(1)[0] % digits.length];
  if (!/[A-Z]/.test(raw)) arr[crypto.randomBytes(1)[0] % 4] = letters[crypto.randomBytes(1)[0] % letters.length];

  return `PNV-${arr.join("")}`;
}

async function generateAndAssignReferralInMain(senderId, authToken) {
  // ⚠️ Patch /users/:id => nécessite authToken
  if (!authToken) {
    logger.warn("[Referral][legacy] generateAndAssignReferralInMain skipped (authToken manquant)", { senderId });
    return { ok: false, skipped: true };
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    const newCode = generatePNVReferralCode();
    try {
      await patchUserInMain(
        senderId,
        {
          referralCode: newCode,
          hasGeneratedReferral: true,
          referralCodeGeneratedAt: new Date().toISOString(),
        },
        authToken
      );
      logger.info(`[Referral][legacy] Code "${newCode}" assigné pour ${senderId}`);
      return { ok: true, code: newCode };
    } catch (err) {
      const msg = String(err.response?.data?.error || err.response?.data?.message || err.message || "");
      if (err.response?.status === 409 || /duplicate|E11000|already exists|conflict/i.test(msg)) continue;
      throw err;
    }
  }
  throw new Error(`Impossible de générer un referralCode unique pour ${senderId}`);
}

async function getFirstTwoConfirmedTotal(userId) {
  const txs = await TransactionModel()
    .find({
      status: "confirmed",
      $or: [{ ownerUserId: userId }, { initiatorUserId: userId }, { userId: userId }],
    })
    .sort({ confirmedAt: 1, createdAt: 1 })
    .limit(2)
    .lean();

  const count = Array.isArray(txs) ? txs.length : 0;
  if (count < 2) return { count, total: 0 };

  const total = txs.reduce((sum, tx) => sum + safeNumber(tx?.amount), 0);
  return { count, total };
}

async function checkAndGenerateReferralCodeInMain(senderId, authToken, tx) {
  if (!senderId && !tx) return;
  if (tx && !isConfirmedStatus(tx.status)) return;

  const targetUserId = String(tx?.ownerUserId || tx?.initiatorUserId || senderId || "").trim();
  if (!targetUserId) return;

  const internal = await postInternal(
    ["/internal/referral/on-transaction-confirm", "/api/v1/internal/referral/on-transaction-confirm"],
    {
      userId: targetUserId,
      transaction: {
        id: String(tx?.id || tx?._id || tx?.reference || Date.now()),
        reference: tx?.reference ? String(tx.reference) : "",
        status: "confirmed",
        amount: safeNumber(tx?.amount),
        currency: tx?.currency,
        createdAt: tx?.createdAt || new Date().toISOString(),
      },
    },
    authToken
  );

  if (internal.ok) {
    logger.info(`[Referral] referralCode ensured for ${targetUserId}`);
    return;
  }

  // fallback legacy: seulement si authToken (sinon ça va 401)
  try {
    if (!authToken) {
      logger.warn("[Referral][legacy] fallback skipped (authToken manquant)", { targetUserId });
      return;
    }

    const count = await TransactionModel().countDocuments({
      status: "confirmed",
      $or: [{ ownerUserId: targetUserId }, { initiatorUserId: targetUserId }, { userId: targetUserId }],
    });
    if (count < 1) return;

    const userMain = await fetchUserFromMain(targetUserId, authToken);
    if (!userMain) return;

    if (userMain.hasGeneratedReferral || userMain.referralCode) return;

    await generateAndAssignReferralInMain(targetUserId, authToken);
  } catch (e) {
    logger.error("[Referral] checkAndGenerateReferralCodeInMain error:", e?.response?.data || e.message);
  }
}

async function processReferralBonusIfEligible(userId, authToken) {
  if (!userId) return;

  const { count, total } = await getFirstTwoConfirmedTotal(userId);
  if (count < 2) return;

  let minTotalRequired = 0;
  let currency = "XOF";

  try {
    const filleul = await fetchUserFromMain(userId, authToken);
    const regionF = getRegionFromCountry(filleul?.country);
    const seuilCfg = regionF ? THRESHOLDS_BY_REGION[regionF] : null;

    if (seuilCfg) {
      minTotalRequired = safeNumber(seuilCfg.minTotal);
      currency = String(seuilCfg.currency || currency);
    } else if (filleul?.country) {
      currency = String(filleul.currency || currency);
    }
  } catch {}

  const internal = await postInternal(
    ["/internal/referral/award-bonus", "/api/v1/internal/referral/award-bonus"],
    {
      refereeId: userId,
      triggerTxId: `first2_${userId}_${Date.now()}`,
      stats: {
        confirmedCount: count,
        confirmedTotal: total,
        currency,
        minConfirmedRequired: 2,
        minTotalRequired,
      },
    },
    authToken
  );

  if (internal.ok) {
    logger.info(`[Referral] award-bonus requested for referee=${userId}`);
    return;
  }

  // fallback legacy: nécessite authToken pour lire user/referredBy + notifications
  try {
    if (!authToken) {
      logger.warn("[Referral][legacy] bonus fallback skipped (authToken manquant)", { userId });
      return;
    }

    const filleul = await fetchUserFromMain(userId, authToken);
    if (!filleul) return;
    if (!filleul.referredBy) return;
    if (filleul.referralBonusCredited) return;

    const parrainId = filleul.referredBy;
    const parrain = await fetchUserFromMain(parrainId, authToken);
    if (!parrain) return;

    const regionF = getRegionFromCountry(filleul.country);
    const regionP = getRegionFromCountry(parrain.country);
    if (!regionF || !regionP) return;

    const seuilCfg = THRESHOLDS_BY_REGION[regionF];
    const bonusCfg = BONUSES_BY_REGION[regionP];
    if (!seuilCfg || !bonusCfg) return;

    if (total < seuilCfg.minTotal) return;

    const { currency: bonusCurrency, parrain: bonusParrain, filleul: bonusFilleul } = bonusCfg;

    if (bonusFilleul > 0) {
      await creditBalanceInMain(
        userId,
        bonusFilleul,
        bonusCurrency,
        "Bonus de bienvenue (filleul - programme de parrainage PayNoval)",
        authToken
      );
    }
    if (bonusParrain > 0) {
      await creditBalanceInMain(
        parrainId,
        bonusParrain,
        bonusCurrency,
        `Bonus de parrainage pour ${filleul.fullName || filleul.email || userId}`,
        authToken
      );
    }

    await patchUserInMain(
      userId,
      {
        referralBonusCredited: true,
        referralBonusCurrency: bonusCurrency,
        referralBonusParrainAmount: bonusParrain,
        referralBonusFilleulAmount: bonusFilleul,
        referralBonusCreditedAt: new Date().toISOString(),
      },
      authToken
    );

    await sendNotificationToMain(
      parrainId,
      "Bonus parrain PayNoval crédité",
      `Vous avez reçu ${bonusParrain} ${bonusCurrency} grâce à l’activité de votre filleul.`,
      { type: "referral_bonus", role: "parrain", amount: bonusParrain, currency: bonusCurrency, childUserId: userId },
      authToken
    );

    await sendNotificationToMain(
      userId,
      "Bonus de bienvenue PayNoval crédité",
      `Vous avez reçu ${bonusFilleul} ${bonusCurrency} grâce à vos premiers transferts sur PayNoval.`,
      { type: "referral_bonus", role: "filleul", amount: bonusFilleul, currency: bonusCurrency, parentUserId: parrainId },
      authToken
    );

    logger.info(
      `[Referral][legacy] Bonus crédité (parrain=${parrainId}, filleul=${userId}, ${bonusParrain}/${bonusFilleul} ${bonusCurrency})`
    );
  } catch (err) {
    logger.error("[Referral] Erreur bonus legacy:", err?.response?.data || err.message);
  }
}

module.exports = {
  checkAndGenerateReferralCodeInMain,
  processReferralBonusIfEligible,
};
