// "use strict";

// let logger = console;
// try {
//   logger = require("../utils/logger");
// } catch {}

// const mongoose = require("mongoose");

// const { getTxConn } = require("../config/db");

// const TxWalletBalanceModel = require("../models/TxWalletBalance");
// const TxSystemBalanceModel = require("../models/TxSystemBalance");

// function safeNumber(v) {
//   const n =
//     typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
//   return Number.isFinite(n) ? n : 0;
// }

// function normalizeCurrency(v, fallback = "XOF") {
//   const code = String(v || fallback).trim().toUpperCase();
//   return code || fallback;
// }

// function getCurrencyDecimals(currency) {
//   const c = normalizeCurrency(currency);
//   return ["XOF", "XAF", "JPY"].includes(c) ? 0 : 2;
// }

// function roundForCurrency(amount, currency) {
//   const n = safeNumber(amount);
//   const p = 10 ** getCurrencyDecimals(currency);
//   return Math.round(n * p) / p;
// }

// function toDecimal128(amount, currency) {
//   return mongoose.Types.Decimal128.fromString(
//     roundForCurrency(amount, currency).toFixed(getCurrencyDecimals(currency))
//   );
// }

// function decimalToNumber(value) {
//   if (value == null) return 0;
//   try {
//     return Number(value.toString());
//   } catch {
//     return 0;
//   }
// }

// function normalizeBaseUrl(value) {
//   return String(value || "").trim().replace(/\/+$/, "");
// }

// function normalizePath(value, fallback) {
//   const raw = String(value || fallback || "").trim();
//   if (!raw) return "";
//   return raw.startsWith("/") ? raw : `/${raw}`;
// }

// function pickFirstEnv(...keys) {
//   for (const key of keys) {
//     const value = process.env[key];
//     if (String(value || "").trim()) return String(value).trim();
//   }
//   return "";
// }

// function getFxBaseUrl() {
//   return normalizeBaseUrl(
//     pickFirstEnv(
//       "FX_INTERNAL_BASE_URL",
//       "BACKEND_PRINCIPAL_URL",
//       "PRINCIPAL_BACKEND_URL",
//       "PRINCIPAL_URL",
//       "PRINCIPAL_BASE_URL",
//       "BACKEND_URL"
//     )
//   );
// }

// function getFxConvertPath() {
//   return normalizePath(
//     pickFirstEnv("FX_CONVERT_INTERNAL_PATH", "FX_INTERNAL_CONVERT_PATH"),
//     "/internal/fx/convert"
//   );
// }

// function getFxInternalToken() {
//   return pickFirstEnv(
//     "PRINCIPAL_INTERNAL_TOKEN",
//     "INTERNAL_REFERRAL_TOKEN",
//     "INTERNAL_TOKEN"
//   );
// }

// function getInternalHttpTimeoutMs() {
//   const raw = Number(
//     pickFirstEnv("FX_INTERNAL_TIMEOUT_MS", "INTERNAL_HTTP_TIMEOUT_MS") || 10000
//   );
//   return Number.isFinite(raw) && raw > 0 ? raw : 10000;
// }

// async function readJsonSafe(response) {
//   const text = await response.text();
//   if (!text) return null;

//   try {
//     return JSON.parse(text);
//   } catch {
//     return { raw: text };
//   }
// }

// async function postJsonWithTimeout(url, body, headers = {}, timeoutMs = 10000) {
//   const controller = new AbortController();
//   const timer = setTimeout(() => controller.abort(), timeoutMs);

//   try {
//     const response = await fetch(url, {
//       method: "POST",
//       headers: {
//         "content-type": "application/json",
//         ...headers,
//       },
//       body: JSON.stringify(body || {}),
//       signal: controller.signal,
//     });

//     const data = await readJsonSafe(response);

//     return {
//       ok: response.ok,
//       status: response.status,
//       data,
//     };
//   } finally {
//     clearTimeout(timer);
//   }
// }

// function getTxWalletBalance() {
//   return TxWalletBalanceModel(getTxConn());
// }

// function getTxSystemBalance() {
//   return TxSystemBalanceModel(getTxConn());
// }

// function logReferral(label, payload) {
//   try {
//     console.log(
//       `[REFERRAL][TX-CORE][TRANSFER] ${label} =`,
//       JSON.stringify(payload, null, 2)
//     );
//   } catch {
//     console.log(`[REFERRAL][TX-CORE][TRANSFER] ${label} =`, payload);
//   }
// }

// async function ensureWallet(userId, currency, session) {
//   const TxWalletBalance = getTxWalletBalance();
//   const cur = normalizeCurrency(currency);

//   if (!userId) {
//     throw Object.assign(new Error("WALLET_USER_ID_MISSING"), {
//       code: "WALLET_USER_ID_MISSING",
//     });
//   }

//   const query = { user: userId, currency: cur };
//   const update = {
//     $setOnInsert: {
//       user: userId,
//       currency: cur,
//       amount: toDecimal128(0, cur),
//       availableAmount: toDecimal128(0, cur),
//       status: "active",
//       createdAt: new Date(),
//     },
//     $set: {
//       status: "active",
//       updatedAt: new Date(),
//     },
//   };

//   const options = {
//     upsert: true,
//     new: true,
//     setDefaultsOnInsert: true,
//     session,
//   };

//   const wallet = await TxWalletBalance.findOneAndUpdate(query, update, options);
//   if (!wallet) {
//     throw Object.assign(new Error("WALLET_ENSURE_FAILED"), {
//       code: "WALLET_ENSURE_FAILED",
//       details: { userId: String(userId), currency: cur },
//     });
//   }

//   return wallet;
// }

// async function getWalletOrThrow({ userId, currency, session, errorCode }) {
//   const TxWalletBalance = getTxWalletBalance();
//   const cur = normalizeCurrency(currency);

//   const wallet = await TxWalletBalance.findOne({
//     user: userId,
//     currency: cur,
//   }).session(session);

//   if (!wallet) {
//     throw Object.assign(new Error(errorCode || "WALLET_NOT_FOUND"), {
//       code: errorCode || "WALLET_NOT_FOUND",
//       details: { userId: String(userId), currency: cur },
//     });
//   }

//   return wallet;
// }

// async function creditWallet({ userId, currency, amount, session, errorCode }) {
//   const TxWalletBalance = getTxWalletBalance();
//   const cur = normalizeCurrency(currency);
//   const amt = roundForCurrency(amount, cur);

//   if (!(amt > 0)) {
//     return {
//       skipped: true,
//       userId: String(userId),
//       currency: cur,
//       amount: 0,
//     };
//   }

//   await ensureWallet(userId, cur, session);
//   await getWalletOrThrow({ userId, currency: cur, session, errorCode });

//   const updated = await TxWalletBalance.findOneAndUpdate(
//     { user: userId, currency: cur },
//     {
//       $inc: {
//         amount: toDecimal128(amt, cur),
//         availableAmount: toDecimal128(amt, cur),
//       },
//       $set: { updatedAt: new Date() },
//     },
//     { new: true, session }
//   );

//   if (!updated) {
//     throw Object.assign(new Error(errorCode || "WALLET_CREDIT_FAILED"), {
//       code: errorCode || "WALLET_CREDIT_FAILED",
//       details: { userId: String(userId), currency: cur, amount: amt },
//     });
//   }

//   return {
//     skipped: false,
//     userId: String(userId),
//     currency: cur,
//     amount: amt,
//     balance: decimalToNumber(updated.amount),
//     availableBalance: decimalToNumber(updated.availableAmount),
//   };
// }

// async function convertAmountViaInternalFx({
//   amount,
//   fromCurrency,
//   toCurrency,
//   metadata = {},
// }) {
//   const sourceAmount = safeNumber(amount);
//   const from = normalizeCurrency(fromCurrency);
//   const to = normalizeCurrency(toCurrency);

//   if (!(sourceAmount > 0)) {
//     return {
//       success: true,
//       convertedAmount: 0,
//       rate: 1,
//       fromCurrency: from,
//       toCurrency: to,
//     };
//   }

//   if (from === to) {
//     return {
//       success: true,
//       convertedAmount: roundForCurrency(sourceAmount, to),
//       rate: 1,
//       fromCurrency: from,
//       toCurrency: to,
//     };
//   }

//   const baseUrl = getFxBaseUrl();
//   const path = getFxConvertPath();
//   const token = getFxInternalToken();
//   const timeoutMs = getInternalHttpTimeoutMs();

//   if (!baseUrl) {
//     throw Object.assign(new Error("FX_INTERNAL_BASE_URL_MISSING"), {
//       code: "FX_INTERNAL_BASE_URL_MISSING",
//       details: { amount: sourceAmount, fromCurrency: from, toCurrency: to },
//     });
//   }

//   if (!token) {
//     throw Object.assign(new Error("FX_INTERNAL_TOKEN_MISSING"), {
//       code: "FX_INTERNAL_TOKEN_MISSING",
//     });
//   }

//   const url = `${baseUrl}${path}`;

//   const response = await postJsonWithTimeout(
//     url,
//     {
//       amount: sourceAmount,
//       fromCurrency: from,
//       toCurrency: to,
//       metadata,
//     },
//     {
//       "x-internal-token": token,
//     },
//     timeoutMs
//   );

//   const converted =
//     safeNumber(
//       response?.data?.convertedAmount ??
//         response?.data?.converted ??
//         response?.data?.amount ??
//         response?.data?.targetAmount ??
//         response?.data?.result?.convertedAmount ??
//         response?.data?.result?.converted
//     ) || 0;

//   const rate =
//     safeNumber(
//       response?.data?.rate ??
//         response?.data?.fxRate ??
//         response?.data?.meta?.rate ??
//         response?.data?.result?.rate
//     ) || null;

//   if (!response.ok || response?.data?.success === false) {
//     throw Object.assign(new Error("FX_INTERNAL_CONVERSION_FAILED"), {
//       code: "FX_INTERNAL_CONVERSION_FAILED",
//       details: {
//         httpStatus: response?.status,
//         url,
//         response: response?.data || null,
//         amount: sourceAmount,
//         fromCurrency: from,
//         toCurrency: to,
//       },
//     });
//   }

//   return {
//     success: true,
//     convertedAmount: roundForCurrency(converted, to),
//     rate,
//     fromCurrency: from,
//     toCurrency: to,
//     raw: response?.data || null,
//   };
// }

// async function convertMoney({ amount, fromCurrency, toCurrency }) {
//   const from = normalizeCurrency(fromCurrency);
//   const to = normalizeCurrency(toCurrency);
//   const amt = roundForCurrency(amount, from);

//   if (!(amt > 0)) {
//     return {
//       fromCurrency: from,
//       toCurrency: to,
//       rate: 1,
//       sourceAmount: 0,
//       convertedAmount: 0,
//     };
//   }

//   if (from === to) {
//     return {
//       fromCurrency: from,
//       toCurrency: to,
//       rate: 1,
//       sourceAmount: amt,
//       convertedAmount: roundForCurrency(amt, to),
//     };
//   }

//   const res = await convertAmountViaInternalFx({
//     amount: amt,
//     fromCurrency: from,
//     toCurrency: to,
//     metadata: {
//       source: "tx_core_referral_transfer",
//     },
//   });

//   const converted = safeNumber(res?.convertedAmount);

//   if (!(converted >= 0)) {
//     throw Object.assign(new Error("FX_CONVERSION_FAILED"), {
//       code: "FX_CONVERSION_FAILED",
//       details: { amount: amt, fromCurrency: from, toCurrency: to, fxResponse: res },
//     });
//   }

//   return {
//     fromCurrency: from,
//     toCurrency: to,
//     rate: safeNumber(res?.rate || 0) || null,
//     sourceAmount: amt,
//     convertedAmount: roundForCurrency(converted, to),
//     raw: res || null,
//   };
// }

// async function buildMovement({
//   nominalBonusAmount,
//   nominalBonusCurrency,
//   creditedCurrency,
//   treasuryCurrency,
// }) {
//   const nominalAmount = roundForCurrency(nominalBonusAmount, nominalBonusCurrency);
//   const nominalCur = normalizeCurrency(nominalBonusCurrency);
//   const creditedCur = normalizeCurrency(creditedCurrency || nominalCur);
//   const treasuryCur = normalizeCurrency(treasuryCurrency || "CAD");

//   if (!(nominalAmount > 0)) {
//     return {
//       skipped: true,
//       nominalBonusAmount: 0,
//       nominalBonusCurrency: nominalCur,
//       creditedAmount: 0,
//       creditedCurrency: creditedCur,
//       treasuryDebitedAmount: 0,
//       treasuryCurrency: treasuryCur,
//       conversions: {
//         nominalToCredited: null,
//         creditedToTreasury: null,
//       },
//     };
//   }

//   const nominalToCredited = await convertMoney({
//     amount: nominalAmount,
//     fromCurrency: nominalCur,
//     toCurrency: creditedCur,
//   });

//   const creditedAmount = roundForCurrency(
//     nominalToCredited.convertedAmount,
//     creditedCur
//   );

//   const creditedToTreasury = await convertMoney({
//     amount: creditedAmount,
//     fromCurrency: creditedCur,
//     toCurrency: treasuryCur,
//   });

//   const treasuryDebitedAmount = roundForCurrency(
//     creditedToTreasury.convertedAmount,
//     treasuryCur
//   );

//   return {
//     skipped: false,
//     nominalBonusAmount: nominalAmount,
//     nominalBonusCurrency: nominalCur,
//     creditedAmount,
//     creditedCurrency: creditedCur,
//     treasuryDebitedAmount,
//     treasuryCurrency: treasuryCur,
//     conversions: {
//       nominalToCredited,
//       creditedToTreasury,
//     },
//   };
// }

// async function ensureSystemWalletStrict({
//   TxSystemBalance,
//   treasuryUserId,
//   systemType,
//   currency,
//   session,
//   metadata = {},
// }) {
//   return TxSystemBalance.ensureSystemWallet(
//     treasuryUserId,
//     systemType,
//     currency,
//     {
//       session,
//       metadata,
//     }
//   );
// }

// async function debitSystemWalletStrict({
//   TxSystemBalance,
//   treasuryUserId,
//   systemType,
//   currency,
//   amount,
//   session,
//   reason,
//   reference,
//   metadata = {},
// }) {
//   return TxSystemBalance.debit(
//     treasuryUserId,
//     systemType,
//     currency,
//     amount,
//     {
//       session,
//       reason,
//       reference,
//       metadata,
//     }
//   );
// }

// async function debitReferralTreasury({
//   treasuryUserId,
//   treasurySystemType = "REFERRAL_TREASURY",
//   treasuryCurrency = "CAD",
//   amount,
//   session,
//   metadata = {},
// }) {
//   const TxSystemBalance = getTxSystemBalance();
//   const treasuryUser = String(treasuryUserId || "").trim();
//   const systemType = String(treasurySystemType || "REFERRAL_TREASURY").trim();
//   const cur = normalizeCurrency(treasuryCurrency || "CAD");
//   const amt = roundForCurrency(amount, cur);

//   if (!treasuryUser) {
//     throw Object.assign(new Error("TREASURY_USER_ID_REQUIRED"), {
//       code: "TREASURY_USER_ID_REQUIRED",
//     });
//   }

//   if (!systemType) {
//     throw Object.assign(new Error("SYSTEM_TYPE_REQUIRED"), {
//       code: "SYSTEM_TYPE_REQUIRED",
//     });
//   }

//   if (systemType !== "REFERRAL_TREASURY") {
//     throw Object.assign(new Error("INVALID_REFERRAL_TREASURY_TYPE"), {
//       code: "INVALID_REFERRAL_TREASURY_TYPE",
//       details: { treasurySystemType: systemType },
//     });
//   }

//   if (cur !== "CAD") {
//     throw Object.assign(new Error("REFERRAL_TREASURY_MUST_BE_CAD"), {
//       code: "REFERRAL_TREASURY_MUST_BE_CAD",
//       details: { treasuryCurrency: cur },
//     });
//   }

//   if (!(amt > 0)) {
//     return {
//       skipped: true,
//       treasuryUserId: treasuryUser,
//       systemType,
//       currency: cur,
//       amount: 0,
//     };
//   }

//   const wallet = await ensureSystemWalletStrict({
//     TxSystemBalance,
//     treasuryUserId: treasuryUser,
//     systemType,
//     currency: cur,
//     session,
//     metadata: {
//       source: "internal_referral_transfer",
//       ...metadata,
//     },
//   });

//   if (!wallet) {
//     throw Object.assign(new Error("SYSTEM_TREASURY_NOT_FOUND"), {
//       code: "SYSTEM_TREASURY_NOT_FOUND",
//       details: {
//         treasuryUserId: treasuryUser,
//         treasurySystemType: systemType,
//         treasuryCurrency: cur,
//       },
//     });
//   }

//   const availableBefore =
//     decimalToNumber(wallet.availableAmount) || decimalToNumber(wallet.amount);

//   if (availableBefore < amt) {
//     throw Object.assign(new Error("REFERRAL_TREASURY_INSUFFICIENT_FUNDS"), {
//       code: "REFERRAL_TREASURY_INSUFFICIENT_FUNDS",
//       details: {
//         treasuryUserId: treasuryUser,
//         treasurySystemType: systemType,
//         treasuryCurrency: cur,
//         availableBefore,
//         amount: amt,
//       },
//     });
//   }

//   const updated = await debitSystemWalletStrict({
//     TxSystemBalance,
//     treasuryUserId: treasuryUser,
//     systemType,
//     currency: cur,
//     amount: amt,
//     session,
//     reason: metadata?.reason || "Referral bonus payout",
//     reference:
//       metadata?.reference ||
//       metadata?.triggerTxId ||
//       metadata?.idempotencyKey ||
//       null,
//     metadata: {
//       source: "internal_referral_transfer",
//       ...metadata,
//     },
//   });

//   return {
//     skipped: false,
//     treasuryUserId: treasuryUser,
//     systemType,
//     currency: cur,
//     amount: amt,
//     balance: decimalToNumber(updated?.amount),
//     availableBalance: decimalToNumber(updated?.availableAmount),
//   };
// }

// async function transferReferralBonus({
//   treasuryUserId,
//   treasurySystemType = "REFERRAL_TREASURY",
//   treasuryCurrency = "CAD",
//   sponsorId,
//   refereeId,
//   sponsorBonus,
//   refereeBonus,
//   bonusInputCurrency = "CAD",
//   sponsorCurrency,
//   refereeCurrency,
//   metadata = {},
// }) {
//   const treasuryUser = String(treasuryUserId || "").trim();
//   const systemType = String(treasurySystemType || "REFERRAL_TREASURY").trim();
//   const treasuryCur = normalizeCurrency(treasuryCurrency || "CAD");
//   const inputBonusCurrency = normalizeCurrency(bonusInputCurrency || "CAD");
//   const sponsorCur = normalizeCurrency(sponsorCurrency || inputBonusCurrency);
//   const refereeCur = normalizeCurrency(refereeCurrency || inputBonusCurrency);

//   const normalizedSponsorBonus = roundForCurrency(sponsorBonus, inputBonusCurrency);
//   const normalizedRefereeBonus = roundForCurrency(refereeBonus, inputBonusCurrency);

//   if (!treasuryUser) {
//     throw Object.assign(new Error("TREASURY_USER_ID_REQUIRED"), {
//       code: "TREASURY_USER_ID_REQUIRED",
//     });
//   }

//   if (!sponsorId) {
//     throw Object.assign(new Error("SPONSOR_ID_REQUIRED"), {
//       code: "SPONSOR_ID_REQUIRED",
//     });
//   }

//   if (!refereeId) {
//     throw Object.assign(new Error("REFEREE_ID_REQUIRED"), {
//       code: "REFEREE_ID_REQUIRED",
//     });
//   }

//   const sponsorMovement = await buildMovement({
//     nominalBonusAmount: normalizedSponsorBonus,
//     nominalBonusCurrency: inputBonusCurrency,
//     creditedCurrency: sponsorCur,
//     treasuryCurrency: treasuryCur,
//   });

//   const refereeMovement = await buildMovement({
//     nominalBonusAmount: normalizedRefereeBonus,
//     nominalBonusCurrency: inputBonusCurrency,
//     creditedCurrency: refereeCur,
//     treasuryCurrency: treasuryCur,
//   });

//   const treasuryDebitTotal = roundForCurrency(
//     sponsorMovement.treasuryDebitedAmount + refereeMovement.treasuryDebitedAmount,
//     treasuryCur
//   );

//   logReferral("transferReferralBonus.start", {
//     treasuryUserId: treasuryUser,
//     treasurySystemType: systemType,
//     treasuryCurrency: treasuryCur,
//     sponsorId: String(sponsorId),
//     refereeId: String(refereeId),
//     sponsorBonus: normalizedSponsorBonus,
//     refereeBonus: normalizedRefereeBonus,
//     bonusInputCurrency: inputBonusCurrency,
//     sponsorCurrency: sponsorCur,
//     refereeCurrency: refereeCur,
//     treasuryDebitTotal,
//     metadata,
//   });

//   if (!(treasuryDebitTotal > 0)) {
//     return {
//       ok: true,
//       skipped: true,
//       code: "NO_POSITIVE_BONUS",
//       treasuryUserId: treasuryUser,
//       treasurySystemType: systemType,
//       treasuryCurrency: treasuryCur,
//       treasuryDebitTotal: 0,
//       sponsor: {
//         userId: String(sponsorId),
//         nominalBonusAmount: 0,
//         nominalBonusCurrency: inputBonusCurrency,
//         creditedAmount: 0,
//         creditedCurrency: sponsorCur,
//         treasuryDebitedAmount: 0,
//         treasuryCurrency: treasuryCur,
//       },
//       referee: {
//         userId: String(refereeId),
//         nominalBonusAmount: 0,
//         nominalBonusCurrency: inputBonusCurrency,
//         creditedAmount: 0,
//         creditedCurrency: refereeCur,
//         treasuryDebitedAmount: 0,
//         treasuryCurrency: treasuryCur,
//       },
//       conversions: {
//         sponsor: sponsorMovement.conversions,
//         referee: refereeMovement.conversions,
//       },
//     };
//   }

//   const session = await mongoose.startSession();
//   let result = null;

//   try {
//     await session.withTransaction(async () => {
//       await debitReferralTreasury({
//         treasuryUserId: treasuryUser,
//         treasurySystemType: systemType,
//         treasuryCurrency: treasuryCur,
//         amount: treasuryDebitTotal,
//         session,
//         metadata: {
//           ...metadata,
//           sponsorId: String(sponsorId),
//           refereeId: String(refereeId),
//           sponsorCurrency: sponsorCur,
//           refereeCurrency: refereeCur,
//           sponsorNominalBonus: normalizedSponsorBonus,
//           refereeNominalBonus: normalizedRefereeBonus,
//         },
//       });

//       if (!sponsorMovement.skipped && sponsorMovement.creditedAmount > 0) {
//         await creditWallet({
//           userId: sponsorId,
//           currency: sponsorCur,
//           amount: sponsorMovement.creditedAmount,
//           session,
//           errorCode: "SPONSOR_WALLET_CREDIT_FAILED",
//         });
//       }

//       if (!refereeMovement.skipped && refereeMovement.creditedAmount > 0) {
//         await creditWallet({
//           userId: refereeId,
//           currency: refereeCur,
//           amount: refereeMovement.creditedAmount,
//           session,
//           errorCode: "REFEREE_WALLET_CREDIT_FAILED",
//         });
//       }

//       result = {
//         ok: true,
//         treasuryUserId: treasuryUser,
//         treasurySystemType: systemType,
//         treasuryCurrency: treasuryCur,
//         bonusInputCurrency: inputBonusCurrency,
//         treasuryDebitTotal,
//         sponsor: {
//           userId: String(sponsorId),
//           nominalBonusAmount: sponsorMovement.nominalBonusAmount,
//           nominalBonusCurrency: sponsorMovement.nominalBonusCurrency,
//           creditedAmount: sponsorMovement.creditedAmount,
//           creditedCurrency: sponsorMovement.creditedCurrency,
//           treasuryDebitedAmount: sponsorMovement.treasuryDebitedAmount,
//           treasuryCurrency: treasuryCur,
//         },
//         referee: {
//           userId: String(refereeId),
//           nominalBonusAmount: refereeMovement.nominalBonusAmount,
//           nominalBonusCurrency: refereeMovement.nominalBonusCurrency,
//           creditedAmount: refereeMovement.creditedAmount,
//           creditedCurrency: refereeMovement.creditedCurrency,
//           treasuryDebitedAmount: refereeMovement.treasuryDebitedAmount,
//           treasuryCurrency: treasuryCur,
//         },
//         conversions: {
//           sponsor: sponsorMovement.conversions,
//           referee: refereeMovement.conversions,
//         },
//       };
//     });

//     logReferral("transferReferralBonus.success", result);
//     return result;
//   } catch (e) {
//     const errorResult = {
//       ok: false,
//       code: e?.code || "TXCORE_REFERRAL_TRANSFER_FAILED",
//       message: e?.message || "Referral transfer failed",
//       details: e?.details || null,
//     };

//     logReferral("transferReferralBonus.error", {
//       ...errorResult,
//       stack: e?.stack || "",
//     });

//     return errorResult;
//   } finally {
//     await session.endSession();
//   }
// }

// module.exports = {
//   transferReferralBonus,
// };













"use strict";

let logger = console;
try {
  logger = require("../utils/logger");
} catch {}

const mongoose = require("mongoose");

const { getTxConn } = require("../config/db");

const TxWalletBalanceModel = require("../models/TxWalletBalance");
const TxSystemBalanceModel = require("../models/TxSystemBalance");

function safeNumber(v) {
  const n =
    typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function normalizeCurrency(v, fallback = "XOF") {
  const code = String(v || fallback).trim().toUpperCase();
  return code || fallback;
}

function getCurrencyDecimals(currency) {
  const c = normalizeCurrency(currency);
  return ["XOF", "XAF", "JPY"].includes(c) ? 0 : 2;
}

function roundForCurrency(amount, currency) {
  const n = safeNumber(amount);
  const p = 10 ** getCurrencyDecimals(currency);
  return Math.round(n * p) / p;
}

function toDecimal128(amount, currency) {
  return mongoose.Types.Decimal128.fromString(
    roundForCurrency(amount, currency).toFixed(getCurrencyDecimals(currency))
  );
}

function decimalToNumber(value) {
  if (value == null) return 0;
  try {
    return Number(value.toString());
  } catch {
    return 0;
  }
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizePath(value, fallback) {
  const raw = String(value || fallback || "").trim();
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function pickFirstEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (String(value || "").trim()) return String(value).trim();
  }
  return "";
}

function getFxBaseUrl() {
  return normalizeBaseUrl(
    pickFirstEnv(
      "FX_INTERNAL_BASE_URL",
      "BACKEND_PRINCIPAL_URL",
      "PRINCIPAL_BACKEND_URL",
      "PRINCIPAL_URL",
      "PRINCIPAL_BASE_URL",
      "BACKEND_URL"
    )
  );
}

function getFxConvertPath() {
  return normalizePath(
    pickFirstEnv("FX_CONVERT_INTERNAL_PATH", "FX_INTERNAL_CONVERT_PATH"),
    "/internal/fx/convert"
  );
}

function getFxInternalToken() {
  return pickFirstEnv(
    "PRINCIPAL_INTERNAL_TOKEN",
    "INTERNAL_REFERRAL_TOKEN",
    "INTERNAL_TOKEN"
  );
}

function getInternalHttpTimeoutMs() {
  const raw = Number(
    pickFirstEnv("FX_INTERNAL_TIMEOUT_MS", "INTERNAL_HTTP_TIMEOUT_MS") || 10000
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function postJsonWithTimeout(url, body, headers = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });

    const data = await readJsonSafe(response);

    return {
      ok: response.ok,
      status: response.status,
      data,
    };
  } finally {
    clearTimeout(timer);
  }
}

function getTxWalletBalance() {
  return TxWalletBalanceModel(getTxConn());
}

function getTxSystemBalance() {
  return TxSystemBalanceModel(getTxConn());
}

function logReferral(label, payload) {
  try {
    console.log(
      `[REFERRAL][TX-CORE][TRANSFER] ${label} =`,
      JSON.stringify(payload, null, 2)
    );
  } catch {
    console.log(`[REFERRAL][TX-CORE][TRANSFER] ${label} =`, payload);
  }
}

async function ensureWallet(userId, currency, session) {
  const TxWalletBalance = getTxWalletBalance();
  const cur = normalizeCurrency(currency);

  if (!userId) {
    throw Object.assign(new Error("WALLET_USER_ID_MISSING"), {
      code: "WALLET_USER_ID_MISSING",
    });
  }

  const query = { user: userId, currency: cur };
  const update = {
    $setOnInsert: {
      user: userId,
      currency: cur,
      amount: toDecimal128(0, cur),
      availableAmount: toDecimal128(0, cur),
      status: "active",
      createdAt: new Date(),
    },
    $set: {
      status: "active",
      updatedAt: new Date(),
    },
  };

  const options = {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
    session,
  };

  const wallet = await TxWalletBalance.findOneAndUpdate(query, update, options);
  if (!wallet) {
    throw Object.assign(new Error("WALLET_ENSURE_FAILED"), {
      code: "WALLET_ENSURE_FAILED",
      details: { userId: String(userId), currency: cur },
    });
  }

  return wallet;
}

async function getWalletOrThrow({ userId, currency, session, errorCode }) {
  const TxWalletBalance = getTxWalletBalance();
  const cur = normalizeCurrency(currency);

  const wallet = await TxWalletBalance.findOne({
    user: userId,
    currency: cur,
  }).session(session);

  if (!wallet) {
    throw Object.assign(new Error(errorCode || "WALLET_NOT_FOUND"), {
      code: errorCode || "WALLET_NOT_FOUND",
      details: { userId: String(userId), currency: cur },
    });
  }

  return wallet;
}

async function creditWallet({ userId, currency, amount, session, errorCode }) {
  const TxWalletBalance = getTxWalletBalance();
  const cur = normalizeCurrency(currency);
  const amt = roundForCurrency(amount, cur);

  if (!(amt > 0)) {
    return {
      skipped: true,
      userId: String(userId),
      currency: cur,
      amount: 0,
    };
  }

  await ensureWallet(userId, cur, session);
  await getWalletOrThrow({ userId, currency: cur, session, errorCode });

  const updated = await TxWalletBalance.findOneAndUpdate(
    { user: userId, currency: cur },
    {
      $inc: {
        amount: toDecimal128(amt, cur),
        availableAmount: toDecimal128(amt, cur),
      },
      $set: { updatedAt: new Date() },
    },
    { new: true, session }
  );

  if (!updated) {
    throw Object.assign(new Error(errorCode || "WALLET_CREDIT_FAILED"), {
      code: errorCode || "WALLET_CREDIT_FAILED",
      details: { userId: String(userId), currency: cur, amount: amt },
    });
  }

  return {
    skipped: false,
    userId: String(userId),
    currency: cur,
    amount: amt,
    balance: decimalToNumber(updated.amount),
    availableBalance: decimalToNumber(updated.availableAmount),
  };
}

async function convertAmountViaInternalFx({
  amount,
  fromCurrency,
  toCurrency,
  metadata = {},
}) {
  const sourceAmount = safeNumber(amount);
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);

  if (!(sourceAmount > 0)) {
    return {
      success: true,
      convertedAmount: 0,
      rate: 1,
      fromCurrency: from,
      toCurrency: to,
    };
  }

  if (from === to) {
    return {
      success: true,
      convertedAmount: roundForCurrency(sourceAmount, to),
      rate: 1,
      fromCurrency: from,
      toCurrency: to,
    };
  }

  const baseUrl = getFxBaseUrl();
  const path = getFxConvertPath();
  const token = getFxInternalToken();
  const timeoutMs = getInternalHttpTimeoutMs();

  if (!baseUrl) {
    throw Object.assign(new Error("FX_INTERNAL_BASE_URL_MISSING"), {
      code: "FX_INTERNAL_BASE_URL_MISSING",
      details: { amount: sourceAmount, fromCurrency: from, toCurrency: to },
    });
  }

  if (!token) {
    throw Object.assign(new Error("FX_INTERNAL_TOKEN_MISSING"), {
      code: "FX_INTERNAL_TOKEN_MISSING",
    });
  }

  const url = `${baseUrl}${path}`;

  const response = await postJsonWithTimeout(
    url,
    {
      amount: sourceAmount,
      fromCurrency: from,
      toCurrency: to,
      metadata,
    },
    {
      "x-internal-token": token,
    },
    timeoutMs
  );

  const converted =
    safeNumber(
      response?.data?.convertedAmount ??
        response?.data?.converted ??
        response?.data?.amount ??
        response?.data?.targetAmount ??
        response?.data?.result?.convertedAmount ??
        response?.data?.result?.converted
    ) || 0;

  const rate =
    safeNumber(
      response?.data?.rate ??
        response?.data?.fxRate ??
        response?.data?.meta?.rate ??
        response?.data?.result?.rate
    ) || null;

  if (!response.ok || response?.data?.success === false) {
    throw Object.assign(new Error("FX_INTERNAL_CONVERSION_FAILED"), {
      code: "FX_INTERNAL_CONVERSION_FAILED",
      details: {
        httpStatus: response?.status,
        url,
        response: response?.data || null,
        amount: sourceAmount,
        fromCurrency: from,
        toCurrency: to,
      },
    });
  }

  return {
    success: true,
    convertedAmount: roundForCurrency(converted, to),
    rate,
    fromCurrency: from,
    toCurrency: to,
    raw: response?.data || null,
  };
}

async function convertMoney({ amount, fromCurrency, toCurrency }) {
  const from = normalizeCurrency(fromCurrency);
  const to = normalizeCurrency(toCurrency);
  const amt = roundForCurrency(amount, from);

  if (!(amt > 0)) {
    return {
      fromCurrency: from,
      toCurrency: to,
      rate: 1,
      sourceAmount: 0,
      convertedAmount: 0,
    };
  }

  if (from === to) {
    return {
      fromCurrency: from,
      toCurrency: to,
      rate: 1,
      sourceAmount: amt,
      convertedAmount: roundForCurrency(amt, to),
    };
  }

  const res = await convertAmountViaInternalFx({
    amount: amt,
    fromCurrency: from,
    toCurrency: to,
    metadata: {
      source: "tx_core_referral_transfer",
    },
  });

  const converted = safeNumber(res?.convertedAmount);

  if (!(converted >= 0)) {
    throw Object.assign(new Error("FX_CONVERSION_FAILED"), {
      code: "FX_CONVERSION_FAILED",
      details: {
        amount: amt,
        fromCurrency: from,
        toCurrency: to,
        fxResponse: res,
      },
    });
  }

  return {
    fromCurrency: from,
    toCurrency: to,
    rate: safeNumber(res?.rate || 0) || null,
    sourceAmount: amt,
    convertedAmount: roundForCurrency(converted, to),
    raw: res || null,
  };
}

async function buildMovement({
  nominalBonusAmount,
  nominalBonusCurrency,
  creditedCurrency,
  treasuryCurrency,
}) {
  const nominalAmount = roundForCurrency(
    nominalBonusAmount,
    nominalBonusCurrency
  );
  const nominalCur = normalizeCurrency(nominalBonusCurrency);
  const creditedCur = normalizeCurrency(creditedCurrency || nominalCur);
  const treasuryCur = normalizeCurrency(treasuryCurrency || "CAD");

  if (!(nominalAmount > 0)) {
    return {
      skipped: true,
      nominalBonusAmount: 0,
      nominalBonusCurrency: nominalCur,
      creditedAmount: 0,
      creditedCurrency: creditedCur,
      treasuryDebitedAmount: 0,
      treasuryCurrency: treasuryCur,
      conversions: {
        nominalToCredited: null,
        creditedToTreasury: null,
      },
    };
  }

  const nominalToCredited = await convertMoney({
    amount: nominalAmount,
    fromCurrency: nominalCur,
    toCurrency: creditedCur,
  });

  const creditedAmount = roundForCurrency(
    nominalToCredited.convertedAmount,
    creditedCur
  );

  const creditedToTreasury = await convertMoney({
    amount: creditedAmount,
    fromCurrency: creditedCur,
    toCurrency: treasuryCur,
  });

  const treasuryDebitedAmount = roundForCurrency(
    creditedToTreasury.convertedAmount,
    treasuryCur
  );

  return {
    skipped: false,
    nominalBonusAmount: nominalAmount,
    nominalBonusCurrency: nominalCur,
    creditedAmount,
    creditedCurrency: creditedCur,
    treasuryDebitedAmount,
    treasuryCurrency: treasuryCur,
    conversions: {
      nominalToCredited,
      creditedToTreasury,
    },
  };
}

async function ensureSystemWalletStrict({
  TxSystemBalance,
  treasuryUserId,
  systemType,
  currency,
  session,
  metadata = {},
}) {
  return TxSystemBalance.ensureSystemWallet(
    treasuryUserId,
    systemType,
    currency,
    {
      session,
      metadata,
    }
  );
}

async function debitSystemWalletStrict({
  TxSystemBalance,
  treasuryUserId,
  systemType,
  currency,
  amount,
  session,
  reason,
  reference,
  metadata = {},
}) {
  return TxSystemBalance.debit(
    treasuryUserId,
    systemType,
    currency,
    amount,
    {
      session,
      reason,
      reference,
      metadata,
      historyMetadata: metadata,
    }
  );
}

async function debitReferralTreasury({
  treasuryUserId,
  treasurySystemType = "REFERRAL_TREASURY",
  treasuryCurrency = "CAD",
  amount,
  session,
  metadata = {},
}) {
  const TxSystemBalance = getTxSystemBalance();
  const treasuryUser = String(treasuryUserId || "").trim();
  const systemType = String(treasurySystemType || "REFERRAL_TREASURY").trim();
  const cur = normalizeCurrency(treasuryCurrency || "CAD");
  const amt = roundForCurrency(amount, cur);

  if (!treasuryUser) {
    throw Object.assign(new Error("TREASURY_USER_ID_REQUIRED"), {
      code: "TREASURY_USER_ID_REQUIRED",
    });
  }

  if (!systemType) {
    throw Object.assign(new Error("SYSTEM_TYPE_REQUIRED"), {
      code: "SYSTEM_TYPE_REQUIRED",
    });
  }

  if (systemType !== "REFERRAL_TREASURY") {
    throw Object.assign(new Error("INVALID_REFERRAL_TREASURY_TYPE"), {
      code: "INVALID_REFERRAL_TREASURY_TYPE",
      details: { treasurySystemType: systemType },
    });
  }

  if (cur !== "CAD") {
    throw Object.assign(new Error("REFERRAL_TREASURY_MUST_BE_CAD"), {
      code: "REFERRAL_TREASURY_MUST_BE_CAD",
      details: { treasuryCurrency: cur },
    });
  }

  if (!(amt > 0)) {
    return {
      skipped: true,
      treasuryUserId: treasuryUser,
      systemType,
      currency: cur,
      amount: 0,
    };
  }

  const wallet = await ensureSystemWalletStrict({
    TxSystemBalance,
    treasuryUserId: treasuryUser,
    systemType,
    currency: cur,
    session,
    metadata: {
      source: "internal_referral_transfer",
      ...metadata,
    },
  });

  if (!wallet) {
    throw Object.assign(new Error("SYSTEM_TREASURY_NOT_FOUND"), {
      code: "SYSTEM_TREASURY_NOT_FOUND",
      details: {
        treasuryUserId: treasuryUser,
        treasurySystemType: systemType,
        treasuryCurrency: cur,
      },
    });
  }

  const availableBefore = Number(wallet?.balances?.[cur] || 0);

  if (availableBefore < amt) {
    throw Object.assign(new Error("REFERRAL_TREASURY_INSUFFICIENT_FUNDS"), {
      code: "REFERRAL_TREASURY_INSUFFICIENT_FUNDS",
      details: {
        treasuryUserId: treasuryUser,
        treasurySystemType: systemType,
        treasuryCurrency: cur,
        availableBefore,
        amount: amt,
      },
    });
  }

  const updated = await debitSystemWalletStrict({
    TxSystemBalance,
    treasuryUserId: treasuryUser,
    systemType,
    currency: cur,
    amount: amt,
    session,
    reason: metadata?.reason || "Referral bonus payout",
    reference:
      metadata?.reference ||
      metadata?.triggerTxId ||
      metadata?.idempotencyKey ||
      null,
    metadata: {
      source: "internal_referral_transfer",
      ...metadata,
    },
  });

  return {
    skipped: false,
    treasuryUserId: treasuryUser,
    systemType,
    currency: cur,
    amount: amt,
    balance: Number(updated?.balances?.[cur] || 0),
    availableBalance: Number(updated?.balances?.[cur] || 0),
  };
}

async function transferReferralBonus({
  treasuryUserId,
  treasurySystemType = "REFERRAL_TREASURY",
  treasuryCurrency = "CAD",
  sponsorId,
  refereeId,
  sponsorBonus,
  refereeBonus,
  bonusInputCurrency = "CAD",
  sponsorCurrency,
  refereeCurrency,
  metadata = {},
}) {
  const treasuryUser = String(treasuryUserId || "").trim();
  const systemType = String(treasurySystemType || "REFERRAL_TREASURY").trim();
  const treasuryCur = normalizeCurrency(treasuryCurrency || "CAD");
  const inputBonusCurrency = normalizeCurrency(bonusInputCurrency || "CAD");
  const sponsorCur = normalizeCurrency(sponsorCurrency || inputBonusCurrency);
  const refereeCur = normalizeCurrency(refereeCurrency || inputBonusCurrency);

  const normalizedSponsorBonus = roundForCurrency(
    sponsorBonus,
    inputBonusCurrency
  );
  const normalizedRefereeBonus = roundForCurrency(
    refereeBonus,
    inputBonusCurrency
  );

  if (!treasuryUser) {
    throw Object.assign(new Error("TREASURY_USER_ID_REQUIRED"), {
      code: "TREASURY_USER_ID_REQUIRED",
    });
  }

  if (!sponsorId) {
    throw Object.assign(new Error("SPONSOR_ID_REQUIRED"), {
      code: "SPONSOR_ID_REQUIRED",
    });
  }

  if (!refereeId) {
    throw Object.assign(new Error("REFEREE_ID_REQUIRED"), {
      code: "REFEREE_ID_REQUIRED",
    });
  }

  const sponsorMovement = await buildMovement({
    nominalBonusAmount: normalizedSponsorBonus,
    nominalBonusCurrency: inputBonusCurrency,
    creditedCurrency: sponsorCur,
    treasuryCurrency: treasuryCur,
  });

  const refereeMovement = await buildMovement({
    nominalBonusAmount: normalizedRefereeBonus,
    nominalBonusCurrency: inputBonusCurrency,
    creditedCurrency: refereeCur,
    treasuryCurrency: treasuryCur,
  });

  const treasuryDebitTotal = roundForCurrency(
    sponsorMovement.treasuryDebitedAmount +
      refereeMovement.treasuryDebitedAmount,
    treasuryCur
  );

  logReferral("transferReferralBonus.start", {
    treasuryUserId: treasuryUser,
    treasurySystemType: systemType,
    treasuryCurrency: treasuryCur,
    sponsorId: String(sponsorId),
    refereeId: String(refereeId),
    sponsorBonus: normalizedSponsorBonus,
    refereeBonus: normalizedRefereeBonus,
    bonusInputCurrency: inputBonusCurrency,
    sponsorCurrency: sponsorCur,
    refereeCurrency: refereeCur,
    treasuryDebitTotal,
    metadata,
  });

  if (!(treasuryDebitTotal > 0)) {
    return {
      ok: true,
      skipped: true,
      code: "NO_POSITIVE_BONUS",
      treasuryUserId: treasuryUser,
      treasurySystemType: systemType,
      treasuryCurrency: treasuryCur,
      treasuryDebitTotal: 0,
      sponsor: {
        userId: String(sponsorId),
        nominalBonusAmount: 0,
        nominalBonusCurrency: inputBonusCurrency,
        creditedAmount: 0,
        creditedCurrency: sponsorCur,
        treasuryDebitedAmount: 0,
        treasuryCurrency: treasuryCur,
      },
      referee: {
        userId: String(refereeId),
        nominalBonusAmount: 0,
        nominalBonusCurrency: inputBonusCurrency,
        creditedAmount: 0,
        creditedCurrency: refereeCur,
        treasuryDebitedAmount: 0,
        treasuryCurrency: treasuryCur,
      },
      conversions: {
        sponsor: sponsorMovement.conversions,
        referee: refereeMovement.conversions,
      },
    };
  }

  const session = await mongoose.startSession();
  let result = null;

  try {
    await session.withTransaction(async () => {
      await debitReferralTreasury({
        treasuryUserId: treasuryUser,
        treasurySystemType: systemType,
        treasuryCurrency: treasuryCur,
        amount: treasuryDebitTotal,
        session,
        metadata: {
          ...metadata,
          sponsorId: String(sponsorId),
          refereeId: String(refereeId),
          sponsorCurrency: sponsorCur,
          refereeCurrency: refereeCur,
          sponsorNominalBonus: normalizedSponsorBonus,
          refereeNominalBonus: normalizedRefereeBonus,
        },
      });

      if (!sponsorMovement.skipped && sponsorMovement.creditedAmount > 0) {
        await creditWallet({
          userId: sponsorId,
          currency: sponsorCur,
          amount: sponsorMovement.creditedAmount,
          session,
          errorCode: "SPONSOR_WALLET_CREDIT_FAILED",
        });
      }

      if (!refereeMovement.skipped && refereeMovement.creditedAmount > 0) {
        await creditWallet({
          userId: refereeId,
          currency: refereeCur,
          amount: refereeMovement.creditedAmount,
          session,
          errorCode: "REFEREE_WALLET_CREDIT_FAILED",
        });
      }

      result = {
        ok: true,
        treasuryUserId: treasuryUser,
        treasurySystemType: systemType,
        treasuryCurrency: treasuryCur,
        bonusInputCurrency: inputBonusCurrency,
        treasuryDebitTotal,
        sponsor: {
          userId: String(sponsorId),
          nominalBonusAmount: sponsorMovement.nominalBonusAmount,
          nominalBonusCurrency: sponsorMovement.nominalBonusCurrency,
          creditedAmount: sponsorMovement.creditedAmount,
          creditedCurrency: sponsorMovement.creditedCurrency,
          treasuryDebitedAmount: sponsorMovement.treasuryDebitedAmount,
          treasuryCurrency: treasuryCur,
        },
        referee: {
          userId: String(refereeId),
          nominalBonusAmount: refereeMovement.nominalBonusAmount,
          nominalBonusCurrency: refereeMovement.nominalBonusCurrency,
          creditedAmount: refereeMovement.creditedAmount,
          creditedCurrency: refereeMovement.creditedCurrency,
          treasuryDebitedAmount: refereeMovement.treasuryDebitedAmount,
          treasuryCurrency: treasuryCur,
        },
        conversions: {
          sponsor: sponsorMovement.conversions,
          referee: refereeMovement.conversions,
        },
      };
    });

    logReferral("transferReferralBonus.success", result);
    return result;
  } catch (e) {
    const errorResult = {
      ok: false,
      code: e?.code || "TXCORE_REFERRAL_TRANSFER_FAILED",
      message: e?.message || "Referral transfer failed",
      details: e?.details || null,
    };

    logReferral("transferReferralBonus.error", {
      ...errorResult,
      stack: e?.stack || "",
    });

    return errorResult;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  transferReferralBonus,
};