"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const MAX_CONFIRM_ATTEMPTS = 5;
const LOCK_MINUTES = 10;
const MAX_DESC_LENGTH = 500;

const ZERO_DECIMAL_CURRENCIES = new Set([
  "XOF",
  "XAF",
  "JPY",
  "KRW",
  "GNF",
  "RWF",
  "UGX",
  "BIF",
  "KMF",
  "CLP",
]);

function sanitize(text, maxLen = MAX_DESC_LENGTH) {
  return String(text || "")
    .replace(/[<>\\/{};]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function isEmailLike(v) {
  const s = String(v || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function toFloat(v, fallback = 0) {
  try {
    if (v === null || v === undefined || v === "") return fallback;
    const n = parseFloat(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function normalizeCurrencyCode(v, fallback = "CAD") {
  const code = String(v || "").trim().toUpperCase();
  return code || fallback;
}

function currencyHasDecimals(currency) {
  return !ZERO_DECIMAL_CURRENCIES.has(normalizeCurrencyCode(currency));
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return parseFloat(x.toFixed(2));
}

function roundMoney(n, currency = "CAD") {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (!currencyHasDecimals(currency)) return Math.round(x);
  return parseFloat(x.toFixed(2));
}

function dec2(n) {
  return mongoose.Types.Decimal128.fromString(round2(n).toFixed(2));
}

function decMoney(n, currency = "CAD") {
  const value = roundMoney(n, currency);
  if (currencyHasDecimals(currency)) {
    return mongoose.Types.Decimal128.fromString(value.toFixed(2));
  }
  return mongoose.Types.Decimal128.fromString(String(Math.round(value)));
}

function clampMoneyMin0(n, currency = "CAD") {
  return Math.max(0, roundMoney(n, currency));
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value || "").trim()).digest("hex");
}

function looksLikeSha256Hex(v) {
  return typeof v === "string" && /^[a-f0-9]{64}$/i.test(v);
}

function safeEqualHex(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function pickAuthedUserId(req) {
  return (req.user?.id || req.user?._id || req.user?.userId || null)?.toString?.() || null;
}

function getGatewayBase(GATEWAY_URL) {
  let gatewayBase = String(GATEWAY_URL || process.env.GATEWAY_URL || "").replace(/\/+$/, "");
  if (!gatewayBase) gatewayBase = "https://api-gateway-8cgy.onrender.com";
  if (!gatewayBase.endsWith("/api/v1")) gatewayBase = `${gatewayBase}/api/v1`;
  return gatewayBase;
}

function normalizeMethodValue(v) {
  const raw = String(v || "").trim().toUpperCase();
  if (!raw) return "INTERNAL";
  if (["INTERNAL", "PAYNOVAL", "WALLET"].includes(raw)) return "INTERNAL";
  if (["MOBILEMONEY", "MOBILE_MONEY", "MM"].includes(raw)) return "MOBILEMONEY";
  if (["BANK", "WIRE", "VIREMENT"].includes(raw)) return "BANK";
  if (["CARD", "STRIPE", "VISA"].includes(raw)) return "CARD";
  return raw;
}

function normalizeTxTypeValue(v) {
  const raw = String(v || "").trim().toUpperCase();
  if (["TRANSFER", "DEPOSIT", "WITHDRAW"].includes(raw)) return raw;
  return "TRANSFER";
}

function inferMethodValue(reqBody = {}) {
  const directMethod = String(reqBody.method || "").trim().toUpperCase();
  if (directMethod) return normalizeMethodValue(directMethod);

  const funds = String(reqBody.funds || "").trim().toLowerCase();
  const destination = String(reqBody.destination || "").trim().toLowerCase();
  const provider = String(reqBody.provider || "").trim().toLowerCase();

  if (funds === "mobilemoney" || destination === "mobilemoney") return "MOBILEMONEY";
  if (funds === "bank" || destination === "bank") return "BANK";
  if (funds === "card" || destination === "card" || provider === "stripe") return "CARD";
  if (destination === "paynoval" || provider === "paynoval" || funds === "wallet") return "INTERNAL";

  return "INTERNAL";
}

function pickCurrency(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim().toUpperCase();
    if (normalized) return normalized;
  }
  return "";
}

module.exports = {
  MAX_CONFIRM_ATTEMPTS,
  LOCK_MINUTES,
  MAX_DESC_LENGTH,
  ZERO_DECIMAL_CURRENCIES,
  sanitize,
  isEmailLike,
  toFloat,
  round2,
  roundMoney,
  dec2,
  decMoney,
  clampMoneyMin0,
  normalizeCurrencyCode,
  currencyHasDecimals,
  sha256Hex,
  looksLikeSha256Hex,
  safeEqualHex,
  pickAuthedUserId,
  getGatewayBase,
  normalizeMethodValue,
  normalizeTxTypeValue,
  inferMethodValue,
  pickCurrency,
};