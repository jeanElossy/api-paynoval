


// "use strict";






// /**
//  * ✅ transactionsController (TX Core – PayNoval -> PayNoval)
//  *
//  * Objectif :
//  * - Initiation : AML + validations + pricing gateway + débit expéditeur + crédit admin immédiat + création tx
//  * - Confirmation : vérifie réponse sécurité + anti brute force + crédit destinataire uniquement
//  * - Annulation / remboursement / admin : gestion avancée
//  *
//  * IMPORTANT :
//  * - Ce contrôleur exécute le flux INTERNE PayNoval -> PayNoval
//  * - Il ne déclenche pas directement un provider externe mobile money / card / bank
//  */

// const axios = require("axios");
// const config = require("../config");
// const mongoose = require("mongoose");
// const createError = require("http-errors");
// const crypto = require("crypto");

// const { getUsersConn, getTxConn } = require("../config/db");
// const validationService = require("../services/validationService");
// const { logTransaction } = require("../services/aml");

// const usersConn = getUsersConn();
// const txConn = getTxConn();

// const User = require("../models/User")(usersConn);
// const Notification = require("../models/Notification")(usersConn);
// const Outbox = require("../models/Outbox")(usersConn);
// const Transaction = require("../models/Transaction")(txConn);
// const Balance = require("../models/Balance")(usersConn);

// const logger = require("../utils/logger");
// const { notifyTransactionViaGateway } = require("../services/notifyGateway");
// const { convertAmount } = require("../tools/currency");
// const { normCur } = require("../utils/currency");
// const generateTransactionRef = require("../utils/generateRef");

// const PRINCIPAL_URL = config.principalUrl;
// const GATEWAY_URL = config.gatewayUrl;
// const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || config.internalToken || "";

// /* ------------------------------------------------------------------ */
// /* Helpers                                                            */
// /* ------------------------------------------------------------------ */

// const sanitize = (text) => String(text || "").replace(/[<>\\/{};]/g, "").trim();
// const MAX_DESC_LENGTH = 500;

// const MAX_CONFIRM_ATTEMPTS = 5;
// const LOCK_MINUTES = 10;

// function isEmailLike(v) {
//   const s = String(v || "").trim().toLowerCase();
//   return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
// }

// function toFloat(v, fallback = 0) {
//   try {
//     if (v === null || v === undefined) return fallback;
//     const n = parseFloat(String(v).replace(",", "."));
//     return Number.isFinite(n) ? n : fallback;
//   } catch {
//     return fallback;
//   }
// }

// function round2(n) {
//   const x = Number(n);
//   if (!Number.isFinite(x)) return 0;
//   return parseFloat(x.toFixed(2));
// }

// function dec2(n) {
//   return mongoose.Types.Decimal128.fromString(round2(n).toFixed(2));
// }

// function sha256Hex(value) {
//   return crypto.createHash("sha256").update(String(value || "").trim()).digest("hex");
// }

// function looksLikeSha256Hex(v) {
//   return typeof v === "string" && /^[a-f0-9]{64}$/i.test(v);
// }

// function safeEqualHex(a, b) {
//   const aa = Buffer.from(String(a || ""), "utf8");
//   const bb = Buffer.from(String(b || ""), "utf8");
//   if (aa.length !== bb.length) return false;
//   return crypto.timingSafeEqual(aa, bb);
// }

// function sameMongoClient(connA, connB) {
//   try {
//     const a = connA?.getClient?.();
//     const b = connB?.getClient?.();
//     return !!a && !!b && a === b;
//   } catch {
//     return false;
//   }
// }

// const CAN_USE_SHARED_SESSION = sameMongoClient(usersConn, txConn);

// async function startTxSession() {
//   if (typeof txConn?.startSession === "function") return txConn.startSession();
//   return mongoose.startSession();
// }

// function maybeSessionOpts(session) {
//   return CAN_USE_SHARED_SESSION && session ? { session } : {};
// }

// function getGatewayBase() {
//   let gatewayBase = (GATEWAY_URL || process.env.GATEWAY_URL || "").replace(/\/+$/, "");
//   if (!gatewayBase) gatewayBase = "https://api-gateway-8cgy.onrender.com";
//   if (!gatewayBase.endsWith("/api/v1")) gatewayBase = `${gatewayBase}/api/v1`;
//   return gatewayBase;
// }

// function pickAuthedUserId(req) {
//   return (req.user?.id || req.user?._id || req.user?.userId || null)?.toString?.() || null;
// }

// function normalizeMethodValue(v) {
//   const raw = String(v || "").trim().toUpperCase();
//   if (!raw) return "INTERNAL";
//   if (["INTERNAL", "PAYNOVAL", "WALLET"].includes(raw)) return "INTERNAL";
//   if (["MOBILEMONEY", "MOBILE_MONEY", "MM"].includes(raw)) return "MOBILEMONEY";
//   if (["BANK", "WIRE", "VIREMENT"].includes(raw)) return "BANK";
//   if (["CARD", "STRIPE", "VISA"].includes(raw)) return "CARD";
//   return raw;
// }

// function normalizeTxTypeValue(v) {
//   const raw = String(v || "").trim().toUpperCase();
//   if (["TRANSFER", "DEPOSIT", "WITHDRAW"].includes(raw)) return raw;
//   return "TRANSFER";
// }

// /**
//  * ✅ Construit le payload envoyé au pricing gateway
//  * IMPORTANT :
//  * - priorise toujours les currencyCode / ISO
//  * - n'utilise les symboles qu'en fallback
//  */
// function pickBodyPricingInput(reqBody = {}) {
//   const amount = toFloat(reqBody.amount ?? reqBody.amountSource, 0);

//   const fromCurrency = String(
//     reqBody.senderCurrencyCode ||
//       reqBody.currencySource ||
//       reqBody.currencyCode ||
//       reqBody.fromCurrency ||
//       reqBody.senderCurrencySymbol ||
//       reqBody.currency ||
//       ""
//   )
//     .trim()
//     .toUpperCase();

//   const toCurrency = String(
//     reqBody.localCurrencyCode ||
//       reqBody.currencyTarget ||
//       reqBody.toCurrency ||
//       reqBody.localCurrencySymbol ||
//       ""
//   )
//     .trim()
//     .toUpperCase();

//   const txTypeRaw =
//     reqBody.txType ||
//     (String(reqBody.action || "").toLowerCase() === "deposit"
//       ? "DEPOSIT"
//       : String(reqBody.action || "").toLowerCase() === "withdraw"
//       ? "WITHDRAW"
//       : "TRANSFER");

//   const methodRaw =
//     reqBody.method ||
//     (String(reqBody.funds || "").toLowerCase() === "mobilemoney" ||
//     String(reqBody.destination || "").toLowerCase() === "mobilemoney"
//       ? "MOBILEMONEY"
//       : String(reqBody.destination || "").toLowerCase() === "paynoval"
//       ? "INTERNAL"
//       : "INTERNAL");

//   return {
//     txType: normalizeTxTypeValue(txTypeRaw),
//     method: normalizeMethodValue(methodRaw),
//     amount,
//     fromCurrency,
//     toCurrency,
//     country: reqBody.country || null,
//     fromCountry: reqBody.fromCountry || reqBody.country || null,
//     toCountry: reqBody.toCountry || reqBody.destinationCountry || reqBody.country || null,
//     provider: String(reqBody.provider || "paynoval").toLowerCase(),
//     operator: reqBody.operator || null,
//   };
// }

// async function fetchPricingQuoteFromGateway({ authHeader, pricingInput }) {
//   const gatewayBase = getGatewayBase();
//   const url = `${gatewayBase}/pricing/quote`;

//   const headers = {
//     "Content-Type": "application/json",
//     ...(authHeader ? { Authorization: authHeader } : {}),
//     ...(INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : {}),
//   };

//   logger.info("[TX-CORE][PRICING_CALL]", {
//     url,
//     hasAuthHeader: !!authHeader,
//     hasInternalToken: !!INTERNAL_TOKEN,
//     pricingInput,
//   });

//   const response = await axios.post(url, pricingInput, {
//     headers,
//     timeout: 12000,
//   });

//   logger.info("[TX-CORE][PRICING_RESPONSE]", {
//     status: response?.status,
//     data: response?.data,
//   });

//   const payload = response?.data || {};
//   if (payload.ok === false || payload.success === false) {
//     throw createError(502, payload.error || payload.message || "Erreur pricing gateway");
//   }

//   return payload;
// }

// /**
//  * ✅ Extrait proprement le snapshot pricing verrouillé
//  * On récupère maintenant :
//  * - feeRevenue
//  * - fxRevenue
//  */
// function extractPricingSnapshot(pricingPayload, pricingInput) {
//   const result = pricingPayload?.result || {};
//   const request = pricingPayload?.request || pricingInput || {};
//   const debug = pricingPayload?.debug || null;
//   const ruleApplied = pricingPayload?.ruleApplied || null;
//   const fxRuleApplied = pricingPayload?.fxRuleApplied || null;

//   const fee = round2(toFloat(result.fee, 0));
//   const netFrom = round2(toFloat(result.netFrom, 0));
//   const grossFrom = round2(toFloat(result.grossFrom, pricingInput?.amount || 0));
//   const netTo = round2(toFloat(result.netTo, 0));

//   const marketRate = result.marketRate != null ? Number(result.marketRate) : null;
//   const appliedRate = Number(result.appliedRate || 0);

//   const feeRevenue = {
//     sourceCurrency: String(result?.feeRevenue?.sourceCurrency || request?.fromCurrency || "").toUpperCase() || null,
//     amount: round2(toFloat(result?.feeRevenue?.amount, 0)),
//     adminCurrency: String(result?.feeRevenue?.adminCurrency || "CAD").toUpperCase(),
//     amountCAD: round2(toFloat(result?.feeRevenue?.amountCAD, 0)),
//     conversionRateToCAD: Number(result?.feeRevenue?.conversionRateToCAD || 0),
//     calculatedAt: result?.feeRevenue?.calculatedAt || new Date().toISOString(),
//   };

//   const fxRevenue = {
//     toCurrency: String(result?.fxRevenue?.toCurrency || request?.toCurrency || "").toUpperCase() || null,
//     amount: round2(toFloat(result?.fxRevenue?.amount, 0)),
//     rawAmount: Number(result?.fxRevenue?.rawAmount || 0),
//     idealNetTo: round2(toFloat(result?.fxRevenue?.idealNetTo, 0)),
//     actualNetTo: round2(toFloat(result?.fxRevenue?.actualNetTo, 0)),
//     adminCurrency: String(result?.fxRevenue?.adminCurrency || "CAD").toUpperCase(),
//     amountCAD: round2(toFloat(result?.fxRevenue?.amountCAD, 0)),
//     conversionRateToCAD: Number(result?.fxRevenue?.conversionRateToCAD || 0),
//     calculatedAt: result?.fxRevenue?.calculatedAt || new Date().toISOString(),
//   };

//   return {
//     request,
//     result: {
//       marketRate,
//       appliedRate,
//       fee,
//       feeBreakdown: result?.feeBreakdown || {},
//       grossFrom,
//       netFrom,
//       netTo,
//       feeRevenue,
//       fxRevenue,
//     },
//     ruleApplied,
//     fxRuleApplied,
//     debug,
//   };
// }

// /**
//  * ✅ Construit le breakdown admin final
//  * totalCAD = feeCAD + fxCAD
//  */
// function buildAdminRevenueBreakdownFromPricing(pricingSnapshot = {}) {
//   const feeSource = round2(toFloat(pricingSnapshot?.result?.fee, 0));
//   const feeCAD = round2(toFloat(pricingSnapshot?.result?.feeRevenue?.amountCAD, 0));

//   const fxAmountTo = round2(toFloat(pricingSnapshot?.result?.fxRevenue?.amount, 0));
//   const fxCAD = round2(toFloat(pricingSnapshot?.result?.fxRevenue?.amountCAD, 0));

//   const totalCAD = round2(feeCAD + fxCAD);

//   return {
//     feeSource,
//     feeSourceCurrency: pricingSnapshot?.request?.fromCurrency || null,
//     feeCAD,

//     fxToAmount: fxAmountTo,
//     fxToCurrency:
//       pricingSnapshot?.result?.fxRevenue?.toCurrency || pricingSnapshot?.request?.toCurrency || null,
//     fxCAD,

//     totalCAD,
//     marketRate:
//       pricingSnapshot?.result?.marketRate != null ? Number(pricingSnapshot.result.marketRate) : null,
//     appliedRate:
//       pricingSnapshot?.result?.appliedRate != null ? Number(pricingSnapshot.result.appliedRate) : null,
//     feeConversionRateToCAD:
//       pricingSnapshot?.result?.feeRevenue?.conversionRateToCAD != null
//         ? Number(pricingSnapshot.result.feeRevenue.conversionRateToCAD)
//         : 0,
//     fxConversionRateToCAD:
//       pricingSnapshot?.result?.fxRevenue?.conversionRateToCAD != null
//         ? Number(pricingSnapshot.result.fxRevenue.conversionRateToCAD)
//         : 0,
//     adminCurrency: "CAD",
//     creditedAtInitiate: totalCAD > 0,
//   };
// }

// /* ------------------------------------------------------------------ */
// /* Notifications                                                      */
// /* ------------------------------------------------------------------ */

// async function notifyParties(tx, status, session, senderCurrencySymbol) {
//   try {
//     const sessOpts = maybeSessionOpts(session);

//     const [sender, receiver] = await Promise.all([
//       User.findById(tx.sender)
//         .select("email fullName pushTokens notificationSettings")
//         .lean()
//         .session(sessOpts.session || null)
//         .catch(() => null),
//       User.findById(tx.receiver)
//         .select("email fullName pushTokens notificationSettings")
//         .lean()
//         .session(sessOpts.session || null)
//         .catch(() => null),
//     ]);

//     if (!sender || !receiver) return;

//     const dateStr = new Date().toLocaleString("fr-FR");
//     const token = tx.verificationToken ? String(tx.verificationToken) : "";
//     const webLink = token
//       ? `${PRINCIPAL_URL}/confirm/${tx._id}?token=${encodeURIComponent(token)}`
//       : `${PRINCIPAL_URL}/confirm/${tx._id}`;
//     const mobileLink = token
//       ? `paynoval://confirm/${tx._id}?token=${encodeURIComponent(token)}`
//       : `paynoval://confirm/${tx._id}`;

//     const dataSender = {
//       transactionId: tx._id.toString(),
//       amount: tx.amount?.toString?.() ? tx.amount.toString() : String(tx.amount || ""),
//       currency: senderCurrencySymbol,
//       name: sender.fullName,
//       senderEmail: sender.email,
//       receiverEmail: tx.recipientEmail || receiver.email,
//       date: dateStr,
//       confirmLinkWeb: webLink,
//       country: tx.country,
//       securityQuestion: tx.securityQuestion,
//     };

//     const dataReceiver = {
//       transactionId: tx._id.toString(),
//       amount: tx.localAmount?.toString?.() ? tx.localAmount.toString() : String(tx.localAmount || ""),
//       currency: tx.localCurrencySymbol,
//       name: tx.nameDestinataire,
//       receiverEmail: tx.recipientEmail,
//       senderEmail: sender.email,
//       date: dateStr,
//       confirmLink: mobileLink,
//       country: tx.country,
//       securityQuestion: tx.securityQuestion,
//       senderName: sender.fullName,
//     };

//     const sSettings = sender.notificationSettings || {};
//     const rSettings = receiver.notificationSettings || {};

//     const {
//       channels: { email: sEmailChan = true, push: sPushChan = true, inApp: sInAppChan = true } = {},
//       types: { txSent: sTxSentType = true, txReceived: sTxReceivedType = true, txFailed: sTxFailedType = true } = {},
//     } = sSettings;

//     const {
//       channels: { email: rEmailChan = true, push: rPushChan = true, inApp: rInAppChan = true } = {},
//       types: { txSent: rTxSentType = true, txReceived: rTxReceivedType = true, txFailed: rTxFailedType = true } = {},
//     } = rSettings;

//     let sTypeKey;
//     let rTypeKey;
//     if (status === "initiated" || status === "confirmed") {
//       sTypeKey = "txSent";
//       rTypeKey = "txReceived";
//     } else if (status === "cancelled" || status === "locked") {
//       sTypeKey = "txFailed";
//       rTypeKey = "txFailed";
//     } else {
//       sTypeKey = "txSent";
//       rTypeKey = "txReceived";
//     }

//     const statusTextMap = {
//       initiated: "Transaction en attente",
//       confirmed: "Transaction confirmée",
//       cancelled: "Transaction annulée",
//       locked: "Transaction temporairement bloquée",
//     };
//     const statusText = statusTextMap[status] || `Transaction ${status}`;

//     const messageForSender = `${statusText}\nMontant : ${dataSender.amount} ${dataSender.currency}`;
//     const messageForReceiver = `${statusText}\nMontant : ${dataReceiver.amount} ${dataReceiver.currency}`;

//     async function triggerPush(userId, message) {
//       try {
//         await axios.post(
//           `${PRINCIPAL_URL}/internal/notify`,
//           { userId, message },
//           {
//             headers: {
//               "Content-Type": "application/json",
//               ...(INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : {}),
//             },
//             timeout: 8000,
//           }
//         );
//       } catch (err) {
//         logger?.warn?.(`Échec push pour user ${userId} : ${err?.message || err}`) ||
//           console.warn(`Échec push pour user ${userId} : ${err?.message || err}`);
//       }
//     }

//     if (sPushChan && ((sTypeKey === "txSent" && sTxSentType) || (sTypeKey === "txFailed" && sTxFailedType))) {
//       if (sender.pushTokens && sender.pushTokens.length) await triggerPush(sender._id.toString(), messageForSender);
//     }

//     if (sInAppChan && ((sTypeKey === "txSent" && sTxSentType) || (sTypeKey === "txFailed" && sTxFailedType))) {
//       await Notification.create(
//         [
//           {
//             recipient: sender._id.toString(),
//             type: `transaction_${status}`,
//             data: dataSender,
//             read: false,
//             date: new Date(),
//           },
//         ],
//         sessOpts
//       );
//     }

//     if (rPushChan && ((rTypeKey === "txReceived" && rTxReceivedType) || (rTypeKey === "txFailed" && rTxFailedType))) {
//       if (receiver.pushTokens && receiver.pushTokens.length) await triggerPush(receiver._id.toString(), messageForReceiver);
//     }

//     if (rInAppChan && ((rTypeKey === "txReceived" && rTxReceivedType) || (rTypeKey === "txFailed" && rTxFailedType))) {
//       await Notification.create(
//         [
//           {
//             recipient: receiver._id.toString(),
//             type: `transaction_${status}`,
//             data: dataReceiver,
//             read: false,
//             date: new Date(),
//           },
//         ],
//         sessOpts
//       );
//     }

//     const events = [sender, receiver].map((u) => ({
//       service: "notifications",
//       event: `transaction_${status}`,
//       payload: {
//         userId: u._id.toString(),
//         type: `transaction_${status}`,
//         data: u._id.toString() === sender._id.toString() ? dataSender : dataReceiver,
//       },
//     }));
//     await Outbox.insertMany(events, sessOpts);

//     const shouldEmailSender =
//       sEmailChan && ((sTypeKey === "txSent" && sTxSentType) || (sTypeKey === "txFailed" && sTxFailedType));
//     const shouldEmailReceiver =
//       rEmailChan && ((rTypeKey === "txReceived" && rTxReceivedType) || (rTypeKey === "txFailed" && rTxFailedType));

//     if (shouldEmailSender || shouldEmailReceiver) {
//       const payloadForGateway = {
//         transaction: {
//           id: tx._id.toString(),
//           reference: tx.reference,
//           amount: toFloat(tx.amount),
//           currency: senderCurrencySymbol,
//           dateIso: tx.createdAt?.toISOString?.() || new Date().toISOString(),
//         },
//         sender: { email: sender.email, name: sender.fullName || sender.email, wantsEmail: shouldEmailSender },
//         receiver: {
//           email: tx.recipientEmail || receiver.email,
//           name: tx.nameDestinataire || receiver.fullName || receiver.email,
//           wantsEmail: shouldEmailReceiver,
//         },
//         reason: status === "cancelled" ? tx.cancelReason : undefined,
//         links: { sender: `${PRINCIPAL_URL}/transactions/${tx._id}`, receiverConfirm: webLink },
//       };

//       notifyTransactionViaGateway(status, payloadForGateway).catch((err) => {
//         logger?.error?.("[notifyParties] Erreur notif via Gateway:", err?.message || err) ||
//           console.error("[notifyParties] Erreur notif via Gateway:", err?.message || err);
//       });
//     }
//   } catch (err) {
//     logger?.error?.("notifyParties : erreur lors de l’envoi des notifications", err) ||
//       console.error("notifyParties : erreur lors de l’envoi des notifications", err);
//   }
// }

// /* ------------------------------------------------------------------ */
// /* LIST                                                               */
// /* ------------------------------------------------------------------ */

// exports.listInternal = async (req, res, next) => {
//   try {
//     const userId = pickAuthedUserId(req);
//     if (!userId) {
//       return res.status(401).json({ success: false, message: "Non autorisé" });
//     }

//     const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
//     const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);

//     const query = {
//       $or: [
//         { sender: userId },
//         { receiver: userId },
//         { receiverUserId: userId },
//         { createdBy: userId },
//         { ownerUserId: userId },
//         { userId: userId },
//       ],
//     };

//     const [txDocs, total] = await Promise.all([
//       Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
//       Transaction.countDocuments(query),
//     ]);

//     const txs = txDocs.map((t) => t.toJSON());

//     return res.json({ success: true, count: txs.length, total, data: txs, skip, limit });
//   } catch (err) {
//     return next(err);
//   }
// };

// /* ------------------------------------------------------------------ */
// /* GET BY ID                                                          */
// /* ------------------------------------------------------------------ */

// exports.getTransactionController = async (req, res, next) => {
//   try {
//     const { id } = req.params;
//     const userId = pickAuthedUserId(req);

//     if (!mongoose.Types.ObjectId.isValid(id)) {
//       return res.status(400).json({ success: false, message: "ID invalide" });
//     }
//     if (!userId) {
//       return res.status(401).json({ success: false, message: "Non autorisé" });
//     }

//     const txDoc = await Transaction.findById(id);
//     if (!txDoc) return res.status(404).json({ success: false, message: "Transaction non trouvée" });

//     const tx = txDoc.toJSON();

//     const isSender = String(tx.sender || "") === userId;
//     const isReceiver =
//       String(tx.receiver || "") === userId ||
//       String(tx.receiverUserId || "") === userId ||
//       String(tx.createdBy || "") === userId ||
//       String(tx.ownerUserId || "") === userId ||
//       String(tx.userId || "") === userId;

//     if (!isSender && !isReceiver) {
//       return res.status(404).json({ success: false, message: "Transaction non trouvée" });
//     }

//     return res.status(200).json({ success: true, data: tx });
//   } catch (err) {
//     return next(err);
//   }
// };

// /* ------------------------------------------------------------------ */
// /* INITIATE (PayNoval -> PayNoval)                                    */
// /* ------------------------------------------------------------------ */

// exports.initiateInternal = async (req, res, next) => {
//   const session = await startTxSession();

//   try {
//     if (CAN_USE_SHARED_SESSION) session.startTransaction();

//     const body = req.body || {};

//     const isoSource = String(
//       body.senderCurrencyCode ||
//         body.currencySource ||
//         body.currencyCode ||
//         body.fromCurrency ||
//         body.currency ||
//         ""
//     )
//       .trim()
//       .toUpperCase();

//     const isoTarget = String(
//       body.localCurrencyCode ||
//         body.currencyTarget ||
//         body.toCurrency ||
//         ""
//     )
//       .trim()
//       .toUpperCase();

//     if (!body.senderCurrencyCode && isoSource) body.senderCurrencyCode = isoSource;
//     if (!body.localCurrencyCode && isoTarget) body.localCurrencyCode = isoTarget;

//     if (!body.senderCurrencySymbol && isoSource) body.senderCurrencySymbol = isoSource;
//     if (!body.localCurrencySymbol && isoTarget) body.localCurrencySymbol = isoTarget;

//     if (!body.country) {
//       body.country =
//         body.countryTarget ||
//         body.destinationCountry ||
//         body.originCountry ||
//         req.user?.selectedCountry ||
//         req.user?.country ||
//         req.user?.countryCode ||
//         "";
//     }

//     req.body = body;

//     const {
//       toEmail,
//       amount,

//       senderCurrencyCode,
//       localCurrencyCode,
//       currencySource,
//       currencyTarget,

//       senderCurrencySymbol,
//       localCurrencySymbol,

//       recipientInfo = {},
//       description = "",
//       securityQuestion,
//       securityAnswer,
//       question,
//       securityCode,
//       destination,
//       funds,
//       country,
//     } = req.body;

//     const cleanEmail = String(toEmail || "").trim().toLowerCase();
//     if (!cleanEmail || !isEmailLike(cleanEmail)) throw createError(400, "Email du destinataire requis");

//     const q = sanitize(securityQuestion || question || "");
//     const aRaw = sanitize(securityAnswer || securityCode || "");
//     if (!q || !aRaw) throw createError(400, "securityQuestion + securityAnswer requis");

//     if (!destination || !funds || !country) throw createError(400, "Données de transaction incomplètes");
//     if (description && description.length > MAX_DESC_LENGTH) throw createError(400, "Description trop longue");

//     const authHeader = req.headers.authorization;
//     if (!authHeader || !authHeader.startsWith("Bearer ")) throw createError(401, "Token manquant");

//     const senderId = req.user.id;
//     const amt = toFloat(amount ?? req.body.amountSource);
//     if (!amt || Number.isNaN(amt) || amt <= 0) throw createError(400, "Montant invalide");

//     await validationService.validateTransactionAmount({ amount: amt });

//     await validationService.detectBasicFraud({
//       sender: senderId,
//       receiverEmail: cleanEmail,
//       amount: amt,
//       currency: senderCurrencyCode || currencySource || senderCurrencySymbol,
//     });

//     const sessOpts = maybeSessionOpts(session);

//     const senderUser = await User.findById(senderId)
//       .select("fullName email")
//       .lean()
//       .session(sessOpts.session || null);
//     if (!senderUser) throw createError(403, "Utilisateur invalide");

//     const receiver = await User.findOne({ email: cleanEmail })
//       .select("_id fullName email")
//       .lean()
//       .session(sessOpts.session || null);
//     if (!receiver) throw createError(404, "Destinataire introuvable");

//     if (receiver._id.toString() === senderId) throw createError(400, "Auto-transfert impossible");

//     const rawSourceCurrency =
//       senderCurrencyCode ||
//       currencySource ||
//       req.body.fromCurrency ||
//       senderCurrencySymbol ||
//       req.body.currency ||
//       "";

//     const rawTargetCurrency =
//       localCurrencyCode ||
//       currencyTarget ||
//       req.body.toCurrency ||
//       localCurrencySymbol ||
//       "";

//     const currencySourceISO =
//       normCur(rawSourceCurrency, country) ||
//       sanitize(rawSourceCurrency).toUpperCase();

//     const currencyTargetISO =
//       normCur(rawTargetCurrency, country) ||
//       sanitize(rawTargetCurrency).toUpperCase();

//     req.body.senderCurrencyCode = currencySourceISO;
//     req.body.localCurrencyCode = currencyTargetISO;

//     req.body.senderCurrencySymbol = currencySourceISO;
//     req.body.localCurrencySymbol = currencyTargetISO;

//     /* -------------------- PRICING GATEWAY -------------------- */
//     const pricingInput = pickBodyPricingInput({
//       ...req.body,
//       amount: amt,
//       fromCurrency: currencySourceISO,
//       toCurrency: currencyTargetISO,
//       provider: "paynoval",
//       method: req.body.method || "INTERNAL",
//       txType: req.body.txType || "TRANSFER",
//       fromCountry: req.body.fromCountry || country,
//       toCountry: req.body.toCountry || req.body.destinationCountry || country,
//     });

//     logger.info("[TX-CORE][PRICING_INPUT]", {
//       senderCurrencyCode: req.body.senderCurrencyCode,
//       localCurrencyCode: req.body.localCurrencyCode,
//       senderCurrencySymbol: req.body.senderCurrencySymbol,
//       localCurrencySymbol: req.body.localCurrencySymbol,
//       pricingInput,
//     });

//     let pricingPayload;
//     try {
//       pricingPayload = await fetchPricingQuoteFromGateway({
//         authHeader,
//         pricingInput,
//       });
//     } catch (e) {
//       logger.error("[pricing/quote] échec appel Gateway", {
//         gatewayBase: getGatewayBase(),
//         pricingInput,
//         status: e.response?.status,
//         responseData: e.response?.data,
//         message: e.message,
//         code: e.code,
//       });
//       throw createError(502, "Service pricing indisponible");
//     }

//     const pricingSnapshot = extractPricingSnapshot(pricingPayload, pricingInput);

//     const fee = round2(toFloat(pricingSnapshot?.result?.fee, 0));
//     const grossFrom = round2(toFloat(pricingSnapshot?.result?.grossFrom, amt));
//     const netAmount = round2(toFloat(pricingSnapshot?.result?.netFrom, grossFrom - fee));
//     const convertedLocalNet = round2(toFloat(pricingSnapshot?.result?.netTo, 0));

//     if (!Number.isFinite(grossFrom) || grossFrom <= 0) throw createError(500, "grossFrom pricing invalide");
//     if (!Number.isFinite(netAmount) || netAmount < 0) throw createError(500, "netFrom pricing invalide");
//     if (!Number.isFinite(convertedLocalNet) || convertedLocalNet <= 0) {
//       throw createError(500, "netTo pricing invalide");
//     }

//     const appliedRate = Number(pricingSnapshot?.result?.appliedRate || 0);
//     const rateUsed = Number.isFinite(appliedRate) && appliedRate > 0 ? appliedRate : 1;

//     /**
//      * ✅ Débit expéditeur immédiat sur le brut
//      */
//     const debited = await Balance.findOneAndUpdate(
//       { user: senderId, amount: { $gte: grossFrom } },
//       { $inc: { amount: -grossFrom } },
//       { new: true, ...sessOpts }
//     );
//     if (!debited) throw createError(400, "Solde insuffisant");

//     /**
//      * ✅ Crédit admin immédiat
//      * totalCAD = frais CAD + gain FX CAD
//      */
//     const adminRevenue = buildAdminRevenueBreakdownFromPricing(pricingSnapshot);

//     const adminEmail = "admin@paynoval.com";
//     const adminUser = await User.findOne({ email: adminEmail })
//       .select("_id")
//       .session(sessOpts.session || null);
//     if (!adminUser) throw createError(500, "Compte administrateur introuvable");

//     if (adminRevenue.totalCAD > 0) {
//       await Balance.findOneAndUpdate(
//         { user: adminUser._id },
//         { $inc: { amount: adminRevenue.totalCAD } },
//         { new: true, upsert: true, ...sessOpts }
//       );
//     }

//     const amountSourceStd = round2(grossFrom);
//     const feeSourceStd = round2(fee);
//     const amountTargetStd = round2(convertedLocalNet);

//     const money = {
//       source: { amount: amountSourceStd, currency: currencySourceISO },
//       feeSource: { amount: feeSourceStd, currency: currencySourceISO },
//       target: { amount: amountTargetStd, currency: currencyTargetISO },
//       fxRateSourceToTarget: rateUsed,
//     };

//     const nameDest =
//       recipientInfo.name && sanitize(recipientInfo.name) ? sanitize(recipientInfo.name) : receiver.fullName;

//     const reference = await generateTransactionRef();
//     const securityAnswerHash = sha256Hex(aRaw);
//     const amlSnapshot = req.aml || null;

//     const [tx] = await Transaction.create(
//       [
//         {
//           reference,
//           sender: senderUser._id,
//           receiver: receiver._id,

//           amount: dec2(amountSourceStd),
//           transactionFees: dec2(feeSourceStd),
//           netAmount: dec2(netAmount),
//           senderCurrencySymbol: currencySourceISO,
//           exchangeRate: mongoose.Types.Decimal128.fromString(String(rateUsed)),
//           localAmount: dec2(amountTargetStd),
//           localCurrencySymbol: currencyTargetISO,

//           amountSource: dec2(amountSourceStd),
//           amountTarget: dec2(amountTargetStd),
//           feeSource: dec2(feeSourceStd),
//           fxRateSourceToTarget: mongoose.Types.Decimal128.fromString(String(rateUsed)),
//           currencySource: currencySourceISO,
//           currencyTarget: currencyTargetISO,
//           money,

//           pricingSnapshot,
//           pricingRuleApplied: pricingSnapshot?.ruleApplied || null,
//           pricingFxRuleApplied: pricingSnapshot?.fxRuleApplied || null,

//           adminRevenue,
//           adminRevenueCredited: adminRevenue.totalCAD > 0,
//           adminRevenueCreditedAt: adminRevenue.totalCAD > 0 ? new Date() : null,

//           feeSnapshot: {
//             fee: feeSourceStd,
//             netAfterFees: netAmount,
//             convertedNetAfterFees: amountTargetStd,
//             exchangeRate: rateUsed,
//             pricingDebug: pricingSnapshot?.debug || null,
//           },
//           feeId: null,

//           amlSnapshot,
//           amlStatus: amlSnapshot?.status || "passed",

//           senderName: senderUser.fullName,
//           senderEmail: senderUser.email,
//           nameDestinataire: nameDest,
//           recipientEmail: cleanEmail,

//           country: sanitize(country),
//           description: sanitize(description),

//           securityQuestion: q,
//           securityAnswerHash,
//           securityCode: securityAnswerHash,

//           destination: sanitize(destination),
//           funds: sanitize(funds),

//           status: "pending",
//           attemptCount: 0,
//           lockedUntil: null,
//           lastAttemptAt: null,
//         },
//       ],
//       sessOpts
//     );

//     await notifyParties(tx, "initiated", session, currencySourceISO);

//     if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
//     session.endSession();

//     return res.status(201).json({
//       success: true,
//       transactionId: tx._id.toString(),
//       reference: tx.reference,
//       securityQuestion: q,
//       pricing: {
//         feeSource: feeSourceStd,
//         feeSourceCurrency: currencySourceISO,
//         netFrom: netAmount,
//         netTo: amountTargetStd,
//         targetCurrency: currencyTargetISO,
//         marketRate: pricingSnapshot?.result?.marketRate ?? null,
//         appliedRate: pricingSnapshot?.result?.appliedRate ?? null,
//         feeRevenue: pricingSnapshot?.result?.feeRevenue || null,
//         fxRevenue: pricingSnapshot?.result?.fxRevenue || null,
//       },
//       adminRevenue,
//     });
//   } catch (err) {
//     try {
//       if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
//     } catch {}
//     session.endSession();
//     return next(err);
//   }
// };

// /* ------------------------------------------------------------------ */
// /* CONFIRM (destinataire)                                             */
// /* ------------------------------------------------------------------ */

// exports.confirmController = async (req, res, next) => {
//   const session = await startTxSession();
//   try {
//     if (CAN_USE_SHARED_SESSION) session.startTransaction();

//     const { transactionId, securityAnswer, securityCode } = req.body || {};
//     const provided = sanitize(securityAnswer || securityCode || "");
//     if (!transactionId || !provided) throw createError(400, "transactionId et securityAnswer sont requis");

//     const authHeader = req.headers.authorization;
//     if (!authHeader || !authHeader.startsWith("Bearer ")) throw createError(401, "Token manquant");

//     const sessOpts = maybeSessionOpts(session);

//     const tx = await Transaction.findById(transactionId)
//       .select([
//         "+securityAnswerHash",
//         "+securityCode",
//         "+amount",
//         "+transactionFees",
//         "+netAmount",
//         "+senderCurrencySymbol",
//         "+localCurrencySymbol",
//         "+localAmount",
//         "+receiver",
//         "+sender",
//         "+feeSnapshot",
//         "+attemptCount",
//         "+lastAttemptAt",
//         "+lockedUntil",
//         "+status",
//         "+exchangeRate",
//         "+country",
//         "+funds",
//         "+recipientEmail",
//         "+pricingSnapshot",
//         "+adminRevenue",
//         "+adminRevenueCredited",
//       ])
//       .session(sessOpts.session || null);

//     if (!tx) throw createError(400, "Transaction introuvable");

//     logTransaction({
//       userId: req.user?.id || req.user?._id || null,
//       type: "confirm",
//       provider: tx.funds || "paynoval",
//       amount: toFloat(tx.amount),
//       currency: tx.senderCurrencySymbol,
//       toEmail: tx.recipientEmail || "",
//       details: { transactionId: tx._id.toString() },
//       flagged: false,
//       flagReason: "",
//       transactionId: tx._id,
//       ip: req.ip,
//     }).catch(() => {});

//     validationService.validateTransactionStatusChange(tx.status, "confirmed");
//     if (tx.status !== "pending") throw createError(400, "Transaction déjà traitée ou annulée");

//     const now = new Date();

//     if (tx.lockedUntil && tx.lockedUntil > now) {
//       throw createError(423, `Transaction bloquée, réessayez après ${tx.lockedUntil.toLocaleTimeString("fr-FR")}`);
//     }

//     if (String(tx.receiver) !== String(req.user.id)) {
//       throw createError(403, "Vous n’êtes pas le destinataire de cette transaction");
//     }

//     const storedHash = String(tx.securityAnswerHash || "") || String(tx.securityCode || "");
//     if (!storedHash) throw createError(500, "securityAnswerHash manquant sur la transaction");

//     const inputHash = sha256Hex(provided);

//     const ok = looksLikeSha256Hex(storedHash)
//       ? safeEqualHex(inputHash, storedHash)
//       : safeEqualHex(inputHash, sha256Hex(String(storedHash)));

//     if (!ok) {
//       tx.attemptCount = (tx.attemptCount || 0) + 1;
//       tx.lastAttemptAt = now;

//       if (tx.attemptCount >= MAX_CONFIRM_ATTEMPTS) {
//         tx.lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60 * 1000);
//         await tx.save(sessOpts);

//         await notifyParties(tx, "locked", session, tx.senderCurrencySymbol);

//         logTransaction({
//           userId: req.user?.id || req.user?._id || null,
//           type: "confirm",
//           provider: tx.funds || "paynoval",
//           amount: toFloat(tx.amount),
//           currency: tx.senderCurrencySymbol,
//           toEmail: tx.recipientEmail || "",
//           details: { transactionId: tx._id.toString(), reason: "LOCKED_TOO_MANY_ATTEMPTS" },
//           flagged: true,
//           flagReason: "Too many confirm attempts (locked)",
//           transactionId: tx._id,
//           ip: req.ip,
//         }).catch(() => {});

//         throw createError(423, `Réponse incorrecte. Transaction bloquée ${LOCK_MINUTES} min.`);
//       }

//       await tx.save(sessOpts);
//       throw createError(401, `Réponse incorrecte. Il vous reste ${MAX_CONFIRM_ATTEMPTS - tx.attemptCount} essai(s).`);
//     }

//     tx.attemptCount = 0;
//     tx.lastAttemptAt = null;
//     tx.lockedUntil = null;

//     let creditAmount = null;

//     if (tx.localAmount != null) {
//       const v = toFloat(tx.localAmount, null);
//       if (Number.isFinite(v) && v > 0) creditAmount = v;
//     }

//     if (!creditAmount || creditAmount <= 0) {
//       const snapNetTo = toFloat(tx?.pricingSnapshot?.result?.netTo, null);
//       if (Number.isFinite(snapNetTo) && snapNetTo > 0) creditAmount = snapNetTo;
//     }

//     if (!creditAmount || creditAmount <= 0) {
//       const snap = tx.feeSnapshot || {};
//       const v = toFloat(snap.convertedNetAfterFees ?? null, null);
//       if (Number.isFinite(v) && v > 0) creditAmount = v;
//     }

//     if (!creditAmount || creditAmount <= 0) {
//       const netBrut = toFloat(tx.netAmount);
//       if (String(tx.senderCurrencySymbol || "").trim() === String(tx.localCurrencySymbol || "").trim()) {
//         creditAmount = netBrut;
//       } else {
//         const { converted } = await convertAmount(tx.senderCurrencySymbol, tx.localCurrencySymbol, netBrut);
//         creditAmount = round2(converted);
//       }
//     }

//     creditAmount = round2(creditAmount);
//     if (!Number.isFinite(creditAmount) || creditAmount <= 0) throw createError(500, "Montant à créditer invalide");

//     const credited = await Balance.findOneAndUpdate(
//       { user: tx.receiver },
//       { $inc: { amount: creditAmount } },
//       { new: true, upsert: true, ...sessOpts }
//     );
//     if (!credited) throw createError(500, "Erreur lors du crédit au destinataire");

//     tx.status = "confirmed";
//     tx.confirmedAt = now;

//     if (!tx.localAmount || round2(toFloat(tx.localAmount)) !== creditAmount) {
//       tx.localAmount = dec2(creditAmount);
//     }

//     const currencySourceISO = normCur(tx.senderCurrencySymbol, tx.country) || String(tx.senderCurrencySymbol || "").trim();
//     const currencyTargetISO = normCur(tx.localCurrencySymbol, tx.country) || String(tx.localCurrencySymbol || "").trim();

//     tx.senderCurrencySymbol = currencySourceISO;
//     tx.localCurrencySymbol = currencyTargetISO;

//     const amountSourceStd = round2(toFloat(tx.amount));
//     const feeSourceStd = round2(toFloat(tx.transactionFees));
//     const amountTargetStd = round2(creditAmount);
//     const fxRate = toFloat(tx.exchangeRate, 1);

//     tx.amountSource = dec2(amountSourceStd);
//     tx.feeSource = dec2(feeSourceStd);
//     tx.amountTarget = dec2(amountTargetStd);
//     tx.currencySource = currencySourceISO;
//     tx.currencyTarget = currencyTargetISO;
//     tx.fxRateSourceToTarget = mongoose.Types.Decimal128.fromString(String(fxRate));

//     tx.money = {
//       source: { amount: amountSourceStd, currency: currencySourceISO },
//       feeSource: { amount: feeSourceStd, currency: currencySourceISO },
//       target: { amount: amountTargetStd, currency: currencyTargetISO },
//       fxRateSourceToTarget: fxRate,
//     };

//     await tx.save(sessOpts);

//     await notifyParties(tx, "confirmed", session, currencySourceISO);

//     if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
//     session.endSession();

//     return res.json({
//       success: true,
//       credited: creditAmount,
//       currencyCredited: tx.localCurrencySymbol,
//       pricingSnapshot: tx.pricingSnapshot || null,
//       adminRevenue: tx.adminRevenue || null,
//       adminAlreadyCreditedAtInitiate: !!tx.adminRevenueCredited,
//     });
//   } catch (err) {
//     try {
//       if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
//     } catch {}
//     session.endSession();
//     return next(err);
//   }
// };

// /* ------------------------------------------------------------------ */
// /* CANCEL                                                             */
// /* ------------------------------------------------------------------ */

// exports.cancelController = async (req, res, next) => {
//   const session = await startTxSession();
//   try {
//     if (CAN_USE_SHARED_SESSION) session.startTransaction();

//     const { transactionId, reason = "Annulé" } = req.body;
//     if (!transactionId) throw createError(400, "transactionId requis pour annuler");

//     const sessOpts = maybeSessionOpts(session);

//     const tx = await Transaction.findById(transactionId)
//       .select(["+netAmount", "+amount", "+senderCurrencySymbol", "+sender", "+receiver", "+status", "+funds", "+recipientEmail"])
//       .session(sessOpts.session || null);

//     if (!tx) throw createError(400, "Transaction introuvable");

//     logTransaction({
//       userId: req.user?.id || req.user?._id || null,
//       type: "cancel",
//       provider: tx.funds || "paynoval",
//       amount: toFloat(tx.amount),
//       currency: tx.senderCurrencySymbol,
//       toEmail: tx.recipientEmail || "",
//       details: { transactionId: tx._id.toString(), reason },
//       flagged: false,
//       flagReason: "",
//       transactionId: tx._id,
//       ip: req.ip,
//     }).catch(() => {});

//     validationService.validateTransactionStatusChange(tx.status, "cancelled");
//     if (tx.status !== "pending") throw createError(400, "Transaction déjà traitée ou annulée");

//     const userId = String(req.user.id);
//     const senderId = String(tx.sender);
//     const receiverId = String(tx.receiver);
//     if (userId !== senderId && userId !== receiverId) throw createError(403, "Vous n’êtes pas autorisé à annuler");

//     let cancellationFee = 0;
//     let cancellationFeeType = "fixed";
//     let cancellationFeePercent = 0;
//     let cancellationFeeId = null;

//     try {
//       const gatewayBase = getGatewayBase();

//       const { data } = await axios.get(`${gatewayBase}/fees/simulate`, {
//         params: {
//           provider: tx.funds || "paynoval",
//           amount: String(tx.amount),
//           fromCurrency: tx.senderCurrencySymbol,
//           toCurrency: tx.senderCurrencySymbol,
//           type: "cancellation",
//         },
//         headers: {
//           ...(INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : {}),
//           ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
//         },
//         timeout: 8000,
//       });

//       if (data && data.success) {
//         cancellationFee = toFloat(data.data?.fees, 0);
//         cancellationFeeType = data.data?.type || "fixed";
//         cancellationFeePercent = data.data?.feePercent || 0;
//         cancellationFeeId = data.data?.feeId || null;
//       }
//     } catch (e) {
//       const symbol = String(tx.senderCurrencySymbol || "").trim();
//       if (["USD", "$USD", "CAD", "$CAD", "EUR", "€"].includes(symbol)) cancellationFee = 2.99;
//       else if (["XOF", "XAF", "FCFA", "F CFA"].includes(symbol)) cancellationFee = 300;
//     }

//     cancellationFee = round2(cancellationFee);

//     const netStored = toFloat(tx.netAmount);
//     const refundAmt = round2(netStored - cancellationFee);
//     if (refundAmt < 0) throw createError(400, "Frais d’annulation supérieurs au net à rembourser");

//     const refunded = await Balance.findOneAndUpdate(
//       { user: tx.sender },
//       { $inc: { amount: refundAmt } },
//       { new: true, upsert: true, ...sessOpts }
//     );
//     if (!refunded) throw createError(500, "Erreur lors du remboursement expéditeur");

//     const adminCurrency = "CAD";
//     let adminFeeConverted = 0;

//     if (cancellationFee > 0) {
//       try {
//         const { converted } = await convertAmount(tx.senderCurrencySymbol, adminCurrency, cancellationFee);
//         adminFeeConverted = round2(converted);
//       } catch {
//         adminFeeConverted = 0;
//       }
//     }

//     const adminEmail = "admin@paynoval.com";
//     const adminUser = await User.findOne({ email: adminEmail }).select("_id").session(sessOpts.session || null);
//     if (!adminUser) throw createError(500, "Compte administrateur introuvable");

//     if (adminFeeConverted > 0) {
//       await Balance.findOneAndUpdate(
//         { user: adminUser._id },
//         { $inc: { amount: adminFeeConverted } },
//         { new: true, upsert: true, ...sessOpts }
//       );
//     }

//     tx.status = "cancelled";
//     tx.cancelledAt = new Date();
//     tx.cancelReason = `${userId === receiverId ? "Annulé par le destinataire" : "Annulé par l’expéditeur"} : ${sanitize(reason)}`;
//     tx.cancellationFee = cancellationFee;
//     tx.cancellationFeeType = cancellationFeeType;
//     tx.cancellationFeePercent = cancellationFeePercent;
//     tx.cancellationFeeId = cancellationFeeId;

//     await tx.save(sessOpts);
//     await notifyParties(tx, "cancelled", session, tx.senderCurrencySymbol);

//     if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
//     session.endSession();

//     return res.json({
//       success: true,
//       refunded,
//       cancellationFeeInSenderCurrency: cancellationFee,
//       cancellationFeeType,
//       cancellationFeePercent,
//       cancellationFeeId,
//       adminFeeCredited: adminFeeConverted,
//       adminCurrency,
//     });
//   } catch (err) {
//     try {
//       if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
//     } catch {}
//     session.endSession();
//     return next(err);
//   }
// };

// /* ------------------------------------------------------------------ */
// /* ADMIN                                                              */
// /* ------------------------------------------------------------------ */

// exports.refundController = async (req, res, next) => {
//   const session = await startTxSession();
//   try {
//     if (CAN_USE_SHARED_SESSION) session.startTransaction();

//     const { transactionId, reason = "Remboursement demandé" } = req.body;

//     const sessOpts = maybeSessionOpts(session);

//     const tx = await Transaction.findById(transactionId).session(sessOpts.session || null);
//     if (!tx || tx.status !== "confirmed") throw createError(400, "Transaction non remboursable");
//     if (tx.refundedAt) throw createError(400, "Déjà remboursée");

//     const amt = toFloat(tx.localAmount);
//     if (amt <= 0) throw createError(400, "Montant de remboursement invalide");

//     const debited = await Balance.findOneAndUpdate(
//       { user: tx.receiver, amount: { $gte: amt } },
//       { $inc: { amount: -amt } },
//       { new: true, ...sessOpts }
//     );
//     if (!debited) throw createError(400, "Solde du destinataire insuffisant");

//     await Balance.findOneAndUpdate(
//       { user: tx.sender },
//       { $inc: { amount: amt } },
//       { new: true, upsert: true, ...sessOpts }
//     );

//     tx.status = "refunded";
//     tx.refundedAt = new Date();
//     tx.refundReason = reason;
//     await tx.save(sessOpts);

//     logger.warn(
//       `[ALERTE REFUND] Remboursement manuel ! tx=${transactionId}, by=${req.user?.email || req.user?.id}, amount=${amt}`
//     );

//     if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
//     session.endSession();

//     res.json({ success: true, refunded: amt });
//   } catch (err) {
//     try {
//       if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
//     } catch {}
//     session.endSession();
//     next(err);
//   }
// };

// exports.validateController = async (req, res, next) => {
//   try {
//     const { transactionId, status, adminNote } = req.body;

//     const tx = await Transaction.findById(transactionId);
//     if (!tx || tx.status !== "pending") throw createError(400, "Transaction non validable");

//     if (!["confirmed", "rejected"].includes(status)) throw createError(400, "Statut de validation invalide");

//     tx.status = status;
//     tx.validatedAt = new Date();
//     tx.adminNote = adminNote || null;
//     await tx.save();

//     res.json({ success: true, message: `Transaction ${status}` });
//   } catch (err) {
//     next(err);
//   }
// };

// exports.reassignController = async (req, res, next) => {
//   const session = await startTxSession();
//   try {
//     if (CAN_USE_SHARED_SESSION) session.startTransaction();

//     const { transactionId, newReceiverEmail } = req.body;

//     const sessOpts = maybeSessionOpts(session);

//     const tx = await Transaction.findById(transactionId).session(sessOpts.session || null);
//     if (!tx || !["pending", "confirmed"].includes(tx.status)) throw createError(400, "Transaction non réassignable");

//     const cleanNewEmail = String(newReceiverEmail || "").trim().toLowerCase();
//     if (!isEmailLike(cleanNewEmail)) throw createError(400, "Email destinataire invalide");

//     const newReceiver = await User.findOne({ email: cleanNewEmail })
//       .select("_id fullName email")
//       .session(sessOpts.session || null);

//     if (!newReceiver) throw createError(404, "Nouveau destinataire introuvable");
//     if (String(newReceiver._id) === String(tx.receiver)) throw createError(400, "Déjà affectée à ce destinataire");

//     tx.receiver = newReceiver._id;
//     tx.nameDestinataire = newReceiver.fullName;
//     tx.recipientEmail = newReceiver.email;
//     tx.reassignedAt = new Date();
//     await tx.save(sessOpts);

//     logger.warn(
//       `ALERTE REASSIGN: tx=${transactionId} réassignée par ${req.user?.email || req.user?.id} à ${cleanNewEmail}`
//     );

//     if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
//     session.endSession();

//     res.json({ success: true, newReceiver: { id: newReceiver._id, email: newReceiver.email } });
//   } catch (err) {
//     try {
//       if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
//     } catch {}
//     session.endSession();
//     next(err);
//   }
// };

// exports.archiveController = async (req, res, next) => {
//   try {
//     const { transactionId } = req.body;

//     const tx = await Transaction.findById(transactionId);
//     if (!tx) throw createError(404, "Transaction non trouvée");
//     if (tx.archived) throw createError(400, "Déjà archivée");

//     tx.archived = true;
//     tx.archivedAt = new Date();
//     tx.archivedBy = req.user?.email || req.user?.id || null;
//     await tx.save();

//     res.json({ success: true, archived: true });
//   } catch (err) {
//     next(err);
//   }
// };

// exports.relaunchController = async (req, res, next) => {
//   try {
//     const { transactionId } = req.body;

//     const tx = await Transaction.findById(transactionId);
//     if (!tx) throw createError(404, "Transaction non trouvée");

//     if (!["pending", "cancelled"].includes(tx.status)) {
//       throw createError(400, "Seules les transactions en attente ou annulées peuvent être relancées");
//     }

//     tx.status = "relaunch";
//     tx.relaunchedAt = new Date();
//     tx.relaunchedBy = req.user?.email || req.user?.id || null;
//     tx.relaunchCount = (tx.relaunchCount || 0) + 1;

//     await tx.save();

//     res.json({ success: true, relaunched: true, txId: tx._id });
//   } catch (err) {
//     next(err);
//   }
// };

// exports.notifyParties = notifyParties;






"use strict";

const { listInternal } = require("../services/transactions/handlers/listInternal");
const { getTransactionController } = require("../services/transactions/handlers/getTransaction");
const { initiateInternal } = require("../services/transactions/handlers/initiateInternal");
const { initiateByFlow } = require("../services/transactions/handlers/initiateByFlow");
const {
  initiateOutboundExternal,
  initiateInboundExternal,
} = require("../services/transactions/handlers/initiateExternalTransactions");
const { confirmController } = require("../services/transactions/handlers/confirmTransaction");
const { cancelController } = require("../services/transactions/handlers/cancelTransaction");
const {
  refundController,
  validateController,
  reassignController,
  archiveController,
  relaunchController,
} = require("../services/transactions/handlers/adminActions");
const {
  settleExternalTransactionWebhook,
} = require("../services/transactions/handlers/providerWebhookTransactions");

function safeLog(level, message, meta = {}) {
  try {
    const line = `${message} ${JSON.stringify(meta || {})}`;
    if (level === "error") return console.error(line);
    if (level === "warn") return console.warn(line);
    console.log(line);
  } catch {
    console.log(message);
  }
}

function wrapController(name, handler) {
  return async (req, res, next) => {
    try {
      safeLog("info", `[TX Controller] ${name} called`, {
        params: req?.params || {},
        query: req?.query || {},
        body: req?.body || {},
        userId: req?.user?.id || req?.user?._id || null,
        ip: req?.ip || null,
      });

      return await handler(req, res, next);
    } catch (err) {
      safeLog("error", `[TX Controller] ${name} failed`, {
        message: err?.message,
        status: err?.status || err?.statusCode || err?.response?.status || 500,
        stack: err?.stack,
        params: req?.params || {},
        query: req?.query || {},
        body: req?.body || {},
        userId: req?.user?.id || req?.user?._id || null,
        ip: req?.ip || null,
      });
      return next(err);
    }
  };
}

exports.listInternal = wrapController("listInternal", listInternal);
exports.getTransactionController = wrapController(
  "getTransactionController",
  getTransactionController
);

exports.initiateInternal = wrapController("initiateInternal", initiateInternal);
exports.initiateByFlow = wrapController("initiateByFlow", initiateByFlow);
exports.initiateOutboundExternal = wrapController(
  "initiateOutboundExternal",
  initiateOutboundExternal
);
exports.initiateInboundExternal = wrapController(
  "initiateInboundExternal",
  initiateInboundExternal
);

exports.confirmController = wrapController("confirmController", confirmController);
exports.cancelController = wrapController("cancelController", cancelController);

exports.refundController = wrapController("refundController", refundController);
exports.validateController = wrapController("validateController", validateController);
exports.reassignController = wrapController("reassignController", reassignController);
exports.archiveController = wrapController("archiveController", archiveController);
exports.relaunchController = wrapController("relaunchController", relaunchController);

exports.settleExternalTransactionWebhook = wrapController(
  "settleExternalTransactionWebhook",
  settleExternalTransactionWebhook
);