"use strict";

const asyncHandler = require("express-async-handler");

const TransactionRaw = require("../models/Transaction");
const Transaction = typeof TransactionRaw === "function" ? TransactionRaw() : TransactionRaw;

function toStr(v) {
  return v == null ? "" : String(v);
}

function normCurrency(raw) {
  const s0 = toStr(raw).trim().toUpperCase();
  if (!s0) return undefined;

  // enlève tout sauf lettres
  const cleaned = s0.replace(/[^A-Z]/g, "");
  if (!cleaned) return undefined;

  // mappings utiles (évite que "CFA" casse)
  if (cleaned === "CFA" || cleaned === "FCFA" || cleaned === "XCFA") return "XOF";

  // prend 3 lettres (standard ISO)
  if (cleaned.length >= 3) return cleaned.slice(0, 3);

  return undefined;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function toValidDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

const ALLOWED_STATUS = new Set(["pending", "confirmed", "failed", "canceled", "refunded"]);

exports.importTransaction = asyncHandler(async (req, res) => {
  const body = req.body || {};

  const reference = toStr(body.reference).trim();
  const userId = toStr(body.userId).trim();

  if (!reference || !userId) {
    return res.status(400).json({
      success: false,
      error: "reference et userId requis.",
    });
  }

  const numAmount = Number(body.amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return res.status(400).json({ success: false, error: "amount invalide." });
  }

  const amount = round2(numAmount);

  const provider = toStr(body.provider || "paynoval").trim().toLowerCase() || "paynoval";

  const statusRaw = toStr(body.status || "confirmed").trim().toLowerCase();
  const status = ALLOWED_STATUS.has(statusRaw) ? statusRaw : "confirmed";

  const currency = normCurrency(body.currency);

  const country = toStr(body.country).trim() || undefined;

  // pour faciliter l’affichage (cagnotte/fees/etc.)
  const operator = toStr(body.operator).trim() || "cagnotte";

  const meta = isPlainObject(body.meta) ? body.meta : {};

  const now = new Date();
  const createdAt = toValidDate(body.createdAt) || now;

  // ✅ Idempotent: userId + reference
  const doc = await Transaction.findOneAndUpdate(
    { userId, reference },
    {
      $setOnInsert: {
        userId,
        provider,
        amount,
        status,
        currency,
        country,
        operator,
        reference,
        meta,
        createdAt,
      },
      $set: { updatedAt: now },
    },
    { upsert: true, new: true }
  );

  return res.status(201).json({ success: true, data: doc });
});
