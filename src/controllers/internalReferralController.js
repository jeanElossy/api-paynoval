"use strict";

let logger = console;
try {
  logger = require("../utils/logger");
} catch {}

const {
  transferReferralBonus,
} = require("../services/internalReferralTransferService");

function safeNumber(v) {
  const n =
    typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function normalizeCurrency(v, fallback = "CAD") {
  const code = String(v || fallback).trim().toUpperCase();
  return code || fallback;
}

function getInternalToken() {
  return (
    process.env.TX_CORE_INTERNAL_TOKEN ||
    process.env.INTERNAL_TX_TOKEN ||
    process.env.PRINCIPAL_INTERNAL_TOKEN ||
    process.env.INTERNAL_TOKEN ||
    ""
  );
}

function isValidInternalToken(req) {
  const received =
    req.headers["x-internal-token"] ||
    req.headers["x-tx-internal-token"] ||
    "";
  const expected = getInternalToken();
  return !!expected && String(received) === String(expected);
}

exports.transferBonus = async (req, res) => {
  try {
    if (!isValidInternalToken(req)) {
      return res.status(401).json({
        success: false,
        ok: false,
        code: "INVALID_INTERNAL_TOKEN",
        error: "Accès interne refusé",
      });
    }

    const {
      treasuryUserId,
      treasurySystemType = "REFERRAL_TREASURY",
      treasuryCurrency = "CAD",
      sponsorId,
      refereeId,
      sponsorBonus = 0,
      refereeBonus = 0,
      bonusInputCurrency = "CAD",
      sponsorCurrency,
      refereeCurrency,
      metadata = {},
    } = req.body || {};

    if (!treasuryUserId) {
      return res.status(400).json({
        success: false,
        ok: false,
        code: "TREASURY_USER_ID_REQUIRED",
        error: "treasuryUserId requis",
      });
    }

    if (!sponsorId) {
      return res.status(400).json({
        success: false,
        ok: false,
        code: "SPONSOR_ID_REQUIRED",
        error: "sponsorId requis",
      });
    }

    if (!refereeId) {
      return res.status(400).json({
        success: false,
        ok: false,
        code: "REFEREE_ID_REQUIRED",
        error: "refereeId requis",
      });
    }

    const normalizedBonusInputCurrency = normalizeCurrency(
      bonusInputCurrency,
      "CAD"
    );

    const result = await transferReferralBonus({
      treasuryUserId: String(treasuryUserId || "").trim(),
      treasurySystemType: String(
        treasurySystemType || "REFERRAL_TREASURY"
      ).trim(),
      treasuryCurrency: normalizeCurrency(treasuryCurrency, "CAD"),
      sponsorId: String(sponsorId),
      refereeId: String(refereeId),
      sponsorBonus: safeNumber(sponsorBonus),
      refereeBonus: safeNumber(refereeBonus),
      bonusInputCurrency: normalizedBonusInputCurrency,
      sponsorCurrency: normalizeCurrency(
        sponsorCurrency || normalizedBonusInputCurrency,
        normalizedBonusInputCurrency
      ),
      refereeCurrency: normalizeCurrency(
        refereeCurrency || normalizedBonusInputCurrency,
        normalizedBonusInputCurrency
      ),
      metadata:
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? metadata
          : {},
    });

    if (!result?.ok) {
      return res.status(400).json({
        success: false,
        ok: false,
        ...result,
      });
    }

    return res.json({
      success: true,
      ok: true,
      ...result,
    });
  } catch (e) {
    logger.error?.("[InternalReferralController.transferBonus] error", {
      message: e?.message,
      stack: e?.stack,
    });

    return res.status(500).json({
      success: false,
      ok: false,
      code: e?.code || "INTERNAL_REFERRAL_TRANSFER_ERROR",
      error: e?.message || "Erreur transfert bonus referral",
    });
  }
};