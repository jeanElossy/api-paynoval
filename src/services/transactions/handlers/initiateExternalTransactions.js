// "use strict";

// const createError = require("http-errors");

// const {
//   User,
//   Transaction,
//   validationService,
//   logTransaction,
//   logger,
//   normCur,
//   generateTransactionRef,
//   reserveSenderFunds,
//   normalizePricingSnapshot,
//   startTxSession,
//   maybeSessionOpts,
//   CAN_USE_SHARED_SESSION,
// } = require("../shared/runtime");

// const { notifyParties } = require("../shared/notifications");

// const {
//   sanitize,
//   isEmailLike,
//   toFloat,
//   round2,
//   dec2,
//   sha256Hex,
//   MAX_DESC_LENGTH,
// } = require("../shared/helpers");

// const {
//   pickBodyPricingInput,
//   fetchPricingQuoteFromGateway,
//   extractPricingBundle,
// } = require("../shared/pricing");

// const {
//   OUTBOUND_EXTERNAL_FLOWS,
//   INBOUND_EXTERNAL_FLOWS,
//   resolveExternalFlow,
//   isOutboundExternalFlow,
//   isInboundExternalFlow,
//   resolveProviderForFlow,
//   resolveCountries,
//   resolveCurrencies,
//   buildExternalMetadata,
//   buildExternalMeta,
//   redactSensitiveFields,
//   maskPan,
// } = require("./flowHelpers");

// const { submitExternalExecution } = require("./submitExternalExecution");

// /* -------------------------------------------------------------------------- */
// /* Common helpers                                                             */
// /* -------------------------------------------------------------------------- */

// function ensureBearer(req) {
//   const authHeader = req.headers.authorization;
//   if (!authHeader || !authHeader.startsWith("Bearer ")) {
//     throw createError(401, "Token manquant");
//   }
//   return authHeader;
// }

// function pickExternalDisplayName(body = {}) {
//   return sanitize(
//     body.recipientName ||
//       body.accountHolder ||
//       body.cardHolder ||
//       body.toName ||
//       body.recipientInfo?.name ||
//       "Bénéficiaire externe"
//   );
// }

// function pickExternalRef(body = {}) {
//   return (
//     body.providerReference ||
//     body.externalReference ||
//     body.orderId ||
//     body.reference ||
//     null
//   );
// }

// function buildRecipientExternalMeta(flow, body = {}) {
//   if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT) {
//     return {
//       phoneNumber: body.phoneNumber || body.toPhone || null,
//       operator: body.operator || body.metadata?.provider || null,
//       recipientName: body.recipientName || body.recipientInfo?.name || null,
//     };
//   }

//   if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_BANK_PAYOUT) {
//     return {
//       iban: body.iban || null,
//       swift: body.swift || null,
//       bankName: body.bankName || null,
//       accountHolder: body.accountHolder || null,
//       accountNumberLast4: body.accountNumber
//         ? String(body.accountNumber).slice(-4)
//         : null,
//     };
//   }

//   if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_CARD_PAYOUT) {
//     return {
//       maskedCardNumber: maskPan(body.cardNumber),
//       cardHolder: body.cardHolder || body.toName || null,
//       providerHint: body.provider || body.providerSelected || null,
//     };
//   }

//   if (flow === INBOUND_EXTERNAL_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL) {
//     return {
//       phoneNumber: body.phoneNumber || body.fromPhone || null,
//       operator: body.operator || body.metadata?.provider || null,
//     };
//   }

//   if (flow === INBOUND_EXTERNAL_FLOWS.BANK_TRANSFER_TO_PAYNOVAL) {
//     return {
//       iban: body.iban || null,
//       swift: body.swift || null,
//       bankName: body.bankName || null,
//       accountHolder: body.accountHolder || null,
//       accountNumberLast4: body.accountNumber
//         ? String(body.accountNumber).slice(-4)
//         : null,
//     };
//   }

//   if (flow === INBOUND_EXTERNAL_FLOWS.CARD_TOPUP_TO_PAYNOVAL) {
//     return {
//       maskedCardNumber: maskPan(body.cardNumber),
//       cardHolder: body.cardHolder || null,
//       providerHint: body.provider || body.providerSelected || null,
//     };
//   }

//   return {};
// }

// async function buildPricingContext({ req, body, amount, country, provider, currencySourceISO, currencyTargetISO }) {
//   const authHeader = ensureBearer(req);

//   const pricingInput = pickBodyPricingInput({
//     ...req.body,
//     amount,
//     fromCurrency: currencySourceISO,
//     toCurrency: currencyTargetISO,
//     provider,
//     method: body.method || provider.toUpperCase(),
//     txType: body.txType || (body.action === "deposit" ? "DEPOSIT" : body.action === "withdraw" ? "WITHDRAW" : "TRANSFER"),
//     fromCountry: body.fromCountry || country,
//     toCountry: body.toCountry || body.destinationCountry || country,
//   });

//   let pricingPayload;
//   try {
//     pricingPayload = await fetchPricingQuoteFromGateway({
//       authHeader,
//       pricingInput,
//     });
//   } catch (e) {
//     logger.error("[pricing/quote] gateway error (external)", {
//       pricingInput,
//       status: e.response?.status,
//       responseData: e.response?.data,
//       message: e.message,
//     });
//     throw createError(502, "Service pricing indisponible");
//   }

//   const {
//     pricingSnapshot,
//     grossFrom,
//     fee,
//     netFrom,
//     netTo,
//     adminRevenue,
//   } = extractPricingBundle(pricingPayload, pricingInput);

//   if (!Number.isFinite(grossFrom) || grossFrom <= 0) {
//     throw createError(500, "grossFrom pricing invalide");
//   }
//   if (!Number.isFinite(netFrom) || netFrom < 0) {
//     throw createError(500, "netFrom pricing invalide");
//   }
//   if (!Number.isFinite(netTo) || netTo <= 0) {
//     throw createError(500, "netTo pricing invalide");
//   }

//   const amountSourceStd = round2(grossFrom);
//   const feeSourceStd = round2(fee);
//   const amountTargetStd = round2(netTo);
//   const rateUsed = Number(pricingSnapshot?.result?.appliedRate || 1);

//   return {
//     pricingInput,
//     pricingSnapshot,
//     amountSourceStd,
//     feeSourceStd,
//     netFrom,
//     amountTargetStd,
//     rateUsed,
//     adminRevenue,
//   };
// }

// /* -------------------------------------------------------------------------- */
// /* Outbound payout: PayNoval -> external rail                                 */
// /* -------------------------------------------------------------------------- */

// async function initiateOutboundExternal(req, res, next) {
//   const session = await startTxSession();

//   try {
//     if (CAN_USE_SHARED_SESSION) session.startTransaction();

//     const body = req.body || {};
//     const flow = resolveExternalFlow(body);

//     if (!isOutboundExternalFlow(flow)) {
//       throw createError(400, "Flow payout externe invalide");
//     }

//     const {
//       amount,
//       description = "",
//       securityQuestion,
//       securityAnswer,
//       question,
//       securityCode,
//       country,
//       metadata = {},
//       meta = {},
//     } = body;

//     if (description && description.length > MAX_DESC_LENGTH) {
//       throw createError(400, "Description trop longue");
//     }

//     const q = sanitize(securityQuestion || question || "");
//     const aRaw = sanitize(securityAnswer || securityCode || "");
//     if (!q || !aRaw) {
//       throw createError(400, "securityQuestion + securityAnswer requis");
//     }

//     const senderId = req.user.id;
//     const amt = toFloat(amount ?? body.amountSource);
//     if (!amt || Number.isNaN(amt) || amt <= 0) {
//       throw createError(400, "Montant invalide");
//     }

//     await validationService.validateTransactionAmount({ amount: amt });

//     const sessOpts = maybeSessionOpts(session);

//     const senderUser = await User.findById(senderId)
//       .select("fullName email")
//       .lean()
//       .session(sessOpts.session || null);

//     if (!senderUser) {
//       throw createError(403, "Utilisateur invalide");
//     }

//     const provider = resolveProviderForFlow(flow, body);
//     const externalRecipientMeta = buildRecipientExternalMeta(flow, body);
//     const { country: resolvedCountry, fromCountry, toCountry } = resolveCountries(body, country);
//     const { currencySourceISO, currencyTargetISO } = resolveCurrencies({
//       body,
//       normCur,
//       country: resolvedCountry,
//     });

//     await validationService.detectBasicFraud({
//       sender: senderId,
//       receiverEmail:
//         body.toEmail ||
//         body.recipientEmail ||
//         externalRecipientMeta.phoneNumber ||
//         externalRecipientMeta.iban ||
//         externalRecipientMeta.maskedCardNumber ||
//         "",
//       amount: amt,
//       currency: currencySourceISO,
//     });

//     req.body.senderCurrencyCode = currencySourceISO;
//     req.body.localCurrencyCode = currencyTargetISO;
//     req.body.senderCurrencySymbol = currencySourceISO;
//     req.body.localCurrencySymbol = currencyTargetISO;
//     req.body.fromCountry = fromCountry;
//     req.body.toCountry = toCountry;
//     req.body.country = resolvedCountry;

//     const pricingCtx = await buildPricingContext({
//       req,
//       body,
//       amount: amt,
//       country: resolvedCountry,
//       provider,
//       currencySourceISO,
//       currencyTargetISO,
//     });

//     const reference = await generateTransactionRef();
//     const securityAnswerHash = sha256Hex(aRaw);
//     const amlSnapshot = req.aml || null;

//     const txMeta = {
//       ...((meta && typeof meta === "object") ? meta : {}),
//       ...buildExternalMeta({
//         senderUser,
//         body,
//         extra: {
//           entry: "external_payout.pending",
//           requestOrigin: "tx-core",
//           externalRecipient: externalRecipientMeta,
//         },
//       }),
//     };

//     const txMetadata = {
//       ...((metadata && typeof metadata === "object") ? metadata : {}),
//       ...buildExternalMetadata({
//         flow,
//         provider,
//         body,
//         extra: {
//           providerReference: pickExternalRef(body),
//           externalRecipient: externalRecipientMeta,
//         },
//       }),
//     };

//     const [tx] = await Transaction.create(
//       [
//         {
//           userId: senderUser._id,
//           internalImported: false,

//           flow,
//           operationKind: "transfer",
//           initiatedBy: "user",
//           context: "external_payout",
//           contextId: null,

//           reference,
//           idempotencyKey: body.idempotencyKey || null,

//           sender: senderUser._id,
//           receiver: null,

//           senderName: senderUser.fullName,
//           senderEmail: senderUser.email,
//           nameDestinataire: pickExternalDisplayName(body),
//           recipientEmail: isEmailLike(body.toEmail || body.recipientEmail || "")
//             ? String(body.toEmail || body.recipientEmail).trim().toLowerCase()
//             : null,

//           destination:
//             flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT
//               ? "mobilemoney"
//               : flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_BANK_PAYOUT
//               ? "bank"
//               : "visa_direct",
//           funds: "paynoval",
//           provider,
//           operator: body.operator || txMetadata?.provider || null,
//           country: sanitize(resolvedCountry),

//           amount: dec2(pricingCtx.amountSourceStd),
//           transactionFees: dec2(pricingCtx.feeSourceStd),
//           netAmount: dec2(pricingCtx.netFrom),
//           exchangeRate: dec2(pricingCtx.rateUsed),
//           localAmount: dec2(pricingCtx.amountTargetStd),

//           senderCurrencySymbol: currencySourceISO,
//           localCurrencySymbol: currencyTargetISO,

//           amountSource: dec2(pricingCtx.amountSourceStd),
//           amountTarget: dec2(pricingCtx.amountTargetStd),
//           feeSource: dec2(pricingCtx.feeSourceStd),
//           fxRateSourceToTarget: dec2(pricingCtx.rateUsed),
//           currencySource: currencySourceISO,
//           currencyTarget: currencyTargetISO,

//           money: {
//             source: { amount: pricingCtx.amountSourceStd, currency: currencySourceISO },
//             feeSource: { amount: pricingCtx.feeSourceStd, currency: currencySourceISO },
//             target: { amount: pricingCtx.amountTargetStd, currency: currencyTargetISO },
//             fxRateSourceToTarget: pricingCtx.rateUsed,
//           },

//           pricingSnapshot: normalizePricingSnapshot(pricingCtx.pricingSnapshot),
//           pricingRuleApplied: pricingCtx.pricingSnapshot?.ruleApplied || null,
//           pricingFxRuleApplied: pricingCtx.pricingSnapshot?.fxRuleApplied || null,

//           feeSnapshot: {
//             fee: pricingCtx.feeSourceStd,
//             netAfterFees: pricingCtx.netFrom,
//             convertedNetAfterFees: pricingCtx.amountTargetStd,
//             exchangeRate: pricingCtx.rateUsed,
//             pricingDebug: pricingCtx.pricingSnapshot?.debug || null,
//           },
//           feeActual: null,
//           feeId: null,

//           adminRevenue: pricingCtx.adminRevenue,
//           adminRevenueCredited: false,
//           adminRevenueCreditedAt: null,

//           securityQuestion: q,
//           securityAnswerHash,
//           securityCode: securityAnswerHash,

//           amlSnapshot,
//           amlStatus: amlSnapshot?.status || "passed",

//           description: sanitize(description),
//           orderId: body.orderId || null,

//           metadata: txMetadata,
//           meta: txMeta,

//           status: "pending",
//           providerReference: pickExternalRef(body),
//           providerStatus: "PENDING_USER_CONFIRMATION",

//           fundsReserved: false,
//           fundsReservedAt: null,
//           fundsCaptured: false,
//           fundsCapturedAt: null,
//           beneficiaryCredited: false,
//           beneficiaryCreditedAt: null,
//           reserveReleased: false,
//           reserveReleasedAt: null,
//           reversedAt: null,
//           executedAt: null,

//           attemptCount: 0,
//           lastAttemptAt: null,
//           lockedUntil: null,
//         },
//       ],
//       sessOpts
//     );

//     await reserveSenderFunds({
//       transaction: tx,
//       senderId: senderUser._id,
//       amount: pricingCtx.amountSourceStd,
//       currency: currencySourceISO,
//       session,
//     });

//     tx.fundsReserved = true;
//     tx.fundsReservedAt = new Date();
//     tx.providerStatus = "FUNDS_RESERVED";
//     await tx.save(sessOpts);

//     logTransaction({
//       userId: senderId,
//       type: "initiate",
//       provider,
//       amount: pricingCtx.amountSourceStd,
//       currency: currencySourceISO,
//       toEmail:
//         tx.recipientEmail ||
//         externalRecipientMeta.phoneNumber ||
//         externalRecipientMeta.iban ||
//         externalRecipientMeta.maskedCardNumber ||
//         "",
//       details: {
//         transactionId: tx._id.toString(),
//         reference: tx.reference,
//         flow,
//       },
//       flagged: false,
//       flagReason: "",
//       transactionId: tx._id,
//       ip: req.ip,
//     }).catch(() => {});

//     await notifyParties(tx, "initiated", session, currencySourceISO);

//     if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
//     session.endSession();

//     let execution = null;
//     try {
//       execution = await submitExternalExecution({
//         req,
//         transactionId: tx._id.toString(),
//       });
//     } catch (e) {
//       logger.error("[TX-CORE][OUTBOUND] provider submission failed", {
//         transactionId: tx._id.toString(),
//         flow,
//         message: e.message,
//         status: e.status,
//       });
//     }

//     return res.status(201).json({
//       success: true,
//       transactionId: tx._id.toString(),
//       reference: tx.reference,
//       flow: tx.flow,
//       status: execution?.status || tx.status,
//       providerStatus: execution?.providerStatus || tx.providerStatus,
//       providerReference: execution?.providerReference || tx.providerReference || null,
//       securityQuestion: q,
//       pricing: {
//         feeSource: pricingCtx.feeSourceStd,
//         feeSourceCurrency: currencySourceISO,
//         netFrom: pricingCtx.netFrom,
//         netTo: pricingCtx.amountTargetStd,
//         targetCurrency: currencyTargetISO,
//         marketRate: pricingCtx.pricingSnapshot?.result?.marketRate ?? null,
//         appliedRate: pricingCtx.pricingSnapshot?.result?.appliedRate ?? null,
//         feeRevenue: pricingCtx.pricingSnapshot?.result?.feeRevenue || null,
//         fxRevenue: pricingCtx.pricingSnapshot?.result?.fxRevenue || null,
//       },
//       adminRevenue: pricingCtx.adminRevenue,
//       fundsReserved: true,
//       adminCreditedAtInitiate: false,
//       externalRecipient: redactSensitiveFields(externalRecipientMeta),
//     });
//   } catch (err) {
//     try {
//       if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
//     } catch {}
//     session.endSession();
//     next(err);
//   }
// }

// /* -------------------------------------------------------------------------- */
// /* Inbound collection: external rail -> PayNoval                              */
// /* -------------------------------------------------------------------------- */

// async function initiateInboundExternal(req, res, next) {
//   const session = await startTxSession();

//   try {
//     if (CAN_USE_SHARED_SESSION) session.startTransaction();

//     const body = req.body || {};
//     const flow = resolveExternalFlow(body);

//     if (!isInboundExternalFlow(flow)) {
//       throw createError(400, "Flow collection externe invalide");
//     }

//     const {
//       amount,
//       description = "",
//       country,
//       metadata = {},
//       meta = {},
//     } = body;

//     if (description && description.length > MAX_DESC_LENGTH) {
//       throw createError(400, "Description trop longue");
//     }

//     const receiverId = req.user.id;
//     const amt = toFloat(amount ?? body.amountSource);
//     if (!amt || Number.isNaN(amt) || amt <= 0) {
//       throw createError(400, "Montant invalide");
//     }

//     await validationService.validateTransactionAmount({ amount: amt });

//     const sessOpts = maybeSessionOpts(session);

//     const receiverUser = await User.findById(receiverId)
//       .select("fullName email")
//       .lean()
//       .session(sessOpts.session || null);

//     if (!receiverUser) {
//       throw createError(403, "Utilisateur invalide");
//     }

//     const provider = resolveProviderForFlow(flow, body);
//     const externalSourceMeta = buildRecipientExternalMeta(flow, body);
//     const { country: resolvedCountry, fromCountry, toCountry } = resolveCountries(body, country);
//     const { currencySourceISO, currencyTargetISO } = resolveCurrencies({
//       body,
//       normCur,
//       country: resolvedCountry,
//     });

//     await validationService.detectBasicFraud({
//       sender: body.phoneNumber || body.iban || body.cardHolder || body.accountHolder || "external",
//       receiverEmail: receiverUser.email,
//       amount: amt,
//       currency: currencySourceISO,
//     });

//     req.body.senderCurrencyCode = currencySourceISO;
//     req.body.localCurrencyCode = currencyTargetISO;
//     req.body.senderCurrencySymbol = currencySourceISO;
//     req.body.localCurrencySymbol = currencyTargetISO;
//     req.body.fromCountry = fromCountry;
//     req.body.toCountry = toCountry;
//     req.body.country = resolvedCountry;

//     const pricingCtx = await buildPricingContext({
//       req,
//       body,
//       amount: amt,
//       country: resolvedCountry,
//       provider,
//       currencySourceISO,
//       currencyTargetISO,
//     });

//     const reference = await generateTransactionRef();
//     const amlSnapshot = req.aml || null;

//     const txMeta = {
//       ...((meta && typeof meta === "object") ? meta : {}),
//       ...buildExternalMeta({
//         receiverUser,
//         body,
//         extra: {
//           entry: "external_collection.pending",
//           requestOrigin: "tx-core",
//           externalSource: externalSourceMeta,
//         },
//       }),
//     };

//     const txMetadata = {
//       ...((metadata && typeof metadata === "object") ? metadata : {}),
//       ...buildExternalMetadata({
//         flow,
//         provider,
//         body,
//         extra: {
//           providerReference: pickExternalRef(body),
//           externalSource: externalSourceMeta,
//         },
//       }),
//     };

//     const [tx] = await Transaction.create(
//       [
//         {
//           userId: receiverUser._id,
//           internalImported: false,

//           flow,
//           operationKind: "transfer",
//           initiatedBy: "user",
//           context: "external_collection",
//           contextId: null,

//           reference,
//           idempotencyKey: body.idempotencyKey || null,

//           sender: null,
//           receiver: receiverUser._id,

//           senderName: sanitize(
//             body.senderName ||
//               body.accountHolder ||
//               body.cardHolder ||
//               "Source externe"
//           ),
//           senderEmail: null,
//           nameDestinataire: receiverUser.fullName,
//           recipientEmail: receiverUser.email,

//           destination: "paynoval",
//           funds:
//             flow === INBOUND_EXTERNAL_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL
//               ? "mobilemoney"
//               : flow === INBOUND_EXTERNAL_FLOWS.BANK_TRANSFER_TO_PAYNOVAL
//               ? "bank"
//               : provider === "visa_direct"
//               ? "visa_direct"
//               : "stripe",
//           provider,
//           operator: body.operator || txMetadata?.provider || null,
//           country: sanitize(resolvedCountry),

//           amount: dec2(pricingCtx.amountSourceStd),
//           transactionFees: dec2(pricingCtx.feeSourceStd),
//           netAmount: dec2(pricingCtx.netFrom),
//           exchangeRate: dec2(pricingCtx.rateUsed),
//           localAmount: dec2(pricingCtx.amountTargetStd),

//           senderCurrencySymbol: currencySourceISO,
//           localCurrencySymbol: currencyTargetISO,

//           amountSource: dec2(pricingCtx.amountSourceStd),
//           amountTarget: dec2(pricingCtx.amountTargetStd),
//           feeSource: dec2(pricingCtx.feeSourceStd),
//           fxRateSourceToTarget: dec2(pricingCtx.rateUsed),
//           currencySource: currencySourceISO,
//           currencyTarget: currencyTargetISO,

//           money: {
//             source: { amount: pricingCtx.amountSourceStd, currency: currencySourceISO },
//             feeSource: { amount: pricingCtx.feeSourceStd, currency: currencySourceISO },
//             target: { amount: pricingCtx.amountTargetStd, currency: currencyTargetISO },
//             fxRateSourceToTarget: pricingCtx.rateUsed,
//           },

//           pricingSnapshot: normalizePricingSnapshot(pricingCtx.pricingSnapshot),
//           pricingRuleApplied: pricingCtx.pricingSnapshot?.ruleApplied || null,
//           pricingFxRuleApplied: pricingCtx.pricingSnapshot?.fxRuleApplied || null,

//           feeSnapshot: {
//             fee: pricingCtx.feeSourceStd,
//             netAfterFees: pricingCtx.netFrom,
//             convertedNetAfterFees: pricingCtx.amountTargetStd,
//             exchangeRate: pricingCtx.rateUsed,
//             pricingDebug: pricingCtx.pricingSnapshot?.debug || null,
//           },
//           feeActual: null,
//           feeId: null,

//           adminRevenue: pricingCtx.adminRevenue,
//           adminRevenueCredited: false,
//           adminRevenueCreditedAt: null,

//           securityQuestion: null,
//           securityAnswerHash: null,
//           securityCode: null,

//           amlSnapshot,
//           amlStatus: amlSnapshot?.status || "passed",

//           description: sanitize(description),
//           orderId: body.orderId || null,

//           metadata: txMetadata,
//           meta: txMeta,

//           status: "processing",
//           providerReference: pickExternalRef(body),
//           providerStatus: "AWAITING_PROVIDER_PAYMENT",

//           fundsReserved: false,
//           fundsReservedAt: null,
//           fundsCaptured: false,
//           fundsCapturedAt: null,
//           beneficiaryCredited: false,
//           beneficiaryCreditedAt: null,
//           reserveReleased: false,
//           reserveReleasedAt: null,
//           reversedAt: null,
//           executedAt: null,

//           attemptCount: 0,
//           lastAttemptAt: null,
//           lockedUntil: null,
//         },
//       ],
//       sessOpts
//     );

//     logTransaction({
//       userId: receiverId,
//       type: "initiate",
//       provider,
//       amount: pricingCtx.amountSourceStd,
//       currency: currencySourceISO,
//       toEmail: receiverUser.email,
//       details: {
//         transactionId: tx._id.toString(),
//         reference: tx.reference,
//         flow,
//       },
//       flagged: false,
//       flagReason: "",
//       transactionId: tx._id,
//       ip: req.ip,
//     }).catch(() => {});

//     await notifyParties(tx, "processing", session, currencyTargetISO);

//     if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
//     session.endSession();

//     let execution = null;
//     try {
//       execution = await submitExternalExecution({
//         req,
//         transactionId: tx._id.toString(),
//       });
//     } catch (e) {
//       logger.error("[TX-CORE][INBOUND] provider submission failed", {
//         transactionId: tx._id.toString(),
//         flow,
//         message: e.message,
//         status: e.status,
//       });
//     }

//     return res.status(201).json({
//       success: true,
//       transactionId: tx._id.toString(),
//       reference: tx.reference,
//       flow: tx.flow,
//       status: execution?.status || tx.status,
//       providerStatus: execution?.providerStatus || tx.providerStatus,
//       providerReference: execution?.providerReference || tx.providerReference || null,
//       pricing: {
//         feeSource: pricingCtx.feeSourceStd,
//         feeSourceCurrency: currencySourceISO,
//         netFrom: pricingCtx.netFrom,
//         netTo: pricingCtx.amountTargetStd,
//         targetCurrency: currencyTargetISO,
//         marketRate: pricingCtx.pricingSnapshot?.result?.marketRate ?? null,
//         appliedRate: pricingCtx.pricingSnapshot?.result?.appliedRate ?? null,
//         feeRevenue: pricingCtx.pricingSnapshot?.result?.feeRevenue || null,
//         fxRevenue: pricingCtx.pricingSnapshot?.result?.fxRevenue || null,
//       },
//       adminRevenue: pricingCtx.adminRevenue,
//       externalSource: redactSensitiveFields(externalSourceMeta),
//       message: "Demande créée. En attente de confirmation provider.",
//     });
//   } catch (err) {
//     try {
//       if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
//     } catch {}
//     session.endSession();
//     next(err);
//   }
// }

// module.exports = {
//   initiateOutboundExternal,
//   initiateInboundExternal,
// };







"use strict";

const createError = require("http-errors");

const {
  User,
  Transaction,
  validationService,
  logTransaction,
  logger,
  normCur,
  generateTransactionRef,
  reserveSenderFunds,
  normalizePricingSnapshot,
  startTxSession,
  maybeSessionOpts,
  CAN_USE_SHARED_SESSION,
} = require("../shared/runtime");

const { notifyTransactionEvent } = require("../transactionNotificationService");

const {
  sanitize,
  isEmailLike,
  toFloat,
  round2,
  dec2,
  sha256Hex,
  MAX_DESC_LENGTH,
} = require("../shared/helpers");

const {
  pickBodyPricingInput,
  fetchPricingQuoteFromGateway,
  extractPricingBundle,
} = require("../shared/pricing");

const {
  OUTBOUND_EXTERNAL_FLOWS,
  INBOUND_EXTERNAL_FLOWS,
  resolveExternalFlow,
  isOutboundExternalFlow,
  isInboundExternalFlow,
  resolveProviderForFlow,
  resolveCountries,
  resolveCurrencies,
  buildExternalMetadata,
  buildExternalMeta,
  redactSensitiveFields,
  maskPan,
} = require("./flowHelpers");

const { submitExternalExecution } = require("./submitExternalExecution");

function ensureBearer(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw createError(401, "Token manquant");
  }
  return authHeader;
}

function pickExternalDisplayName(body = {}) {
  return sanitize(
    body.recipientName ||
      body.accountHolder ||
      body.cardHolder ||
      body.toName ||
      body.recipientInfo?.name ||
      "Bénéficiaire externe"
  );
}

function pickExternalRef(body = {}) {
  return (
    body.providerReference ||
    body.externalReference ||
    body.orderId ||
    body.reference ||
    null
  );
}

function buildRecipientExternalMeta(flow, body = {}) {
  if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT) {
    return {
      phoneNumber: body.phoneNumber || body.toPhone || null,
      operator: body.operator || body.metadata?.provider || null,
      recipientName: body.recipientName || body.recipientInfo?.name || null,
    };
  }

  if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_BANK_PAYOUT) {
    return {
      iban: body.iban || null,
      swift: body.swift || null,
      bankName: body.bankName || null,
      accountHolder: body.accountHolder || null,
      accountNumberLast4: body.accountNumber
        ? String(body.accountNumber).slice(-4)
        : null,
    };
  }

  if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_CARD_PAYOUT) {
    return {
      maskedCardNumber: maskPan(body.cardNumber),
      cardHolder: body.cardHolder || body.toName || null,
      providerHint: body.provider || body.providerSelected || null,
    };
  }

  if (flow === INBOUND_EXTERNAL_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL) {
    return {
      phoneNumber: body.phoneNumber || body.fromPhone || null,
      operator: body.operator || body.metadata?.provider || null,
    };
  }

  if (flow === INBOUND_EXTERNAL_FLOWS.BANK_TRANSFER_TO_PAYNOVAL) {
    return {
      iban: body.iban || null,
      swift: body.swift || null,
      bankName: body.bankName || null,
      accountHolder: body.accountHolder || null,
      accountNumberLast4: body.accountNumber
        ? String(body.accountNumber).slice(-4)
        : null,
    };
  }

  if (flow === INBOUND_EXTERNAL_FLOWS.CARD_TOPUP_TO_PAYNOVAL) {
    return {
      maskedCardNumber: maskPan(body.cardNumber),
      cardHolder: body.cardHolder || null,
      providerHint: body.provider || body.providerSelected || null,
    };
  }

  return {};
}

async function buildPricingContext({ req, body, amount, country, provider, currencySourceISO, currencyTargetISO }) {
  const authHeader = ensureBearer(req);

  const pricingInput = pickBodyPricingInput({
    ...req.body,
    amount,
    fromCurrency: currencySourceISO,
    toCurrency: currencyTargetISO,
    provider,
    method: body.method || provider.toUpperCase(),
    txType: body.txType || (body.action === "deposit" ? "DEPOSIT" : body.action === "withdraw" ? "WITHDRAW" : "TRANSFER"),
    fromCountry: body.fromCountry || country,
    toCountry: body.toCountry || body.destinationCountry || country,
  });

  let pricingPayload;
  try {
    pricingPayload = await fetchPricingQuoteFromGateway({
      authHeader,
      pricingInput,
    });
  } catch (e) {
    logger.error("[pricing/quote] gateway error (external)", {
      pricingInput,
      status: e.response?.status,
      responseData: e.response?.data,
      message: e.message,
    });
    throw createError(502, "Service pricing indisponible");
  }

  const {
    pricingSnapshot,
    grossFrom,
    fee,
    netFrom,
    netTo,
    adminRevenue,
  } = extractPricingBundle(pricingPayload, pricingInput);

  if (!Number.isFinite(grossFrom) || grossFrom <= 0) {
    throw createError(500, "grossFrom pricing invalide");
  }
  if (!Number.isFinite(netFrom) || netFrom < 0) {
    throw createError(500, "netFrom pricing invalide");
  }
  if (!Number.isFinite(netTo) || netTo <= 0) {
    throw createError(500, "netTo pricing invalide");
  }

  const amountSourceStd = round2(grossFrom);
  const feeSourceStd = round2(fee);
  const amountTargetStd = round2(netTo);
  const rateUsed = Number(pricingSnapshot?.result?.appliedRate || 1);

  return {
    pricingInput,
    pricingSnapshot,
    amountSourceStd,
    feeSourceStd,
    netFrom,
    amountTargetStd,
    rateUsed,
    adminRevenue,
  };
}

async function initiateOutboundExternal(req, res, next) {
  const session = await startTxSession();

  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

    const body = req.body || {};
    const flow = resolveExternalFlow(body);

    if (!isOutboundExternalFlow(flow)) {
      throw createError(400, "Flow payout externe invalide");
    }

    const {
      amount,
      description = "",
      securityQuestion,
      securityAnswer,
      question,
      securityCode,
      country,
      metadata = {},
      meta = {},
    } = body;

    if (description && description.length > MAX_DESC_LENGTH) {
      throw createError(400, "Description trop longue");
    }

    const q = sanitize(securityQuestion || question || "");
    const aRaw = sanitize(securityAnswer || securityCode || "");
    if (!q || !aRaw) {
      throw createError(400, "securityQuestion + securityAnswer requis");
    }

    const senderId = req.user.id;
    const amt = toFloat(amount ?? body.amountSource);
    if (!amt || Number.isNaN(amt) || amt <= 0) {
      throw createError(400, "Montant invalide");
    }

    await validationService.validateTransactionAmount({ amount: amt });

    const sessOpts = maybeSessionOpts(session);

    const senderUser = await User.findById(senderId)
      .select("fullName email")
      .lean()
      .session(sessOpts.session || null);

    if (!senderUser) {
      throw createError(403, "Utilisateur invalide");
    }

    const provider = resolveProviderForFlow(flow, body);
    const externalRecipientMeta = buildRecipientExternalMeta(flow, body);
    const { country: resolvedCountry, fromCountry, toCountry } = resolveCountries(body, country);
    const { currencySourceISO, currencyTargetISO } = resolveCurrencies({
      body,
      normCur,
      country: resolvedCountry,
    });

    await validationService.detectBasicFraud({
      sender: senderId,
      receiverEmail:
        body.toEmail ||
        body.recipientEmail ||
        externalRecipientMeta.phoneNumber ||
        externalRecipientMeta.iban ||
        externalRecipientMeta.maskedCardNumber ||
        "",
      amount: amt,
      currency: currencySourceISO,
    });

    req.body.senderCurrencyCode = currencySourceISO;
    req.body.localCurrencyCode = currencyTargetISO;
    req.body.senderCurrencySymbol = currencySourceISO;
    req.body.localCurrencySymbol = currencyTargetISO;
    req.body.fromCountry = fromCountry;
    req.body.toCountry = toCountry;
    req.body.country = resolvedCountry;

    const pricingCtx = await buildPricingContext({
      req,
      body,
      amount: amt,
      country: resolvedCountry,
      provider,
      currencySourceISO,
      currencyTargetISO,
    });

    const reference = await generateTransactionRef();
    const securityAnswerHash = sha256Hex(aRaw);
    const amlSnapshot = req.aml || null;

    const txMeta = {
      ...((meta && typeof meta === "object") ? meta : {}),
      ...buildExternalMeta({
        senderUser,
        body,
        extra: {
          entry: "external_payout.pending",
          requestOrigin: "tx-core",
          externalRecipient: externalRecipientMeta,
        },
      }),
    };

    const txMetadata = {
      ...((metadata && typeof metadata === "object") ? metadata : {}),
      ...buildExternalMetadata({
        flow,
        provider,
        body,
        extra: {
          providerReference: pickExternalRef(body),
          externalRecipient: externalRecipientMeta,
        },
      }),
    };

    const [tx] = await Transaction.create(
      [
        {
          userId: senderUser._id,
          internalImported: false,
          flow,
          operationKind: "transfer",
          initiatedBy: "user",
          context: "external_payout",
          contextId: null,
          reference,
          idempotencyKey: body.idempotencyKey || null,
          sender: senderUser._id,
          receiver: null,
          senderName: senderUser.fullName,
          senderEmail: senderUser.email,
          nameDestinataire: pickExternalDisplayName(body),
          recipientEmail: isEmailLike(body.toEmail || body.recipientEmail || "")
            ? String(body.toEmail || body.recipientEmail).trim().toLowerCase()
            : null,
          destination:
            flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT
              ? "mobilemoney"
              : flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_BANK_PAYOUT
              ? "bank"
              : "visa_direct",
          funds: "paynoval",
          provider,
          operator: body.operator || txMetadata?.provider || null,
          country: sanitize(resolvedCountry),
          amount: dec2(pricingCtx.amountSourceStd),
          transactionFees: dec2(pricingCtx.feeSourceStd),
          netAmount: dec2(pricingCtx.netFrom),
          exchangeRate: dec2(pricingCtx.rateUsed),
          localAmount: dec2(pricingCtx.amountTargetStd),
          senderCurrencySymbol: currencySourceISO,
          localCurrencySymbol: currencyTargetISO,
          amountSource: dec2(pricingCtx.amountSourceStd),
          amountTarget: dec2(pricingCtx.amountTargetStd),
          feeSource: dec2(pricingCtx.feeSourceStd),
          fxRateSourceToTarget: dec2(pricingCtx.rateUsed),
          currencySource: currencySourceISO,
          currencyTarget: currencyTargetISO,
          money: {
            source: { amount: pricingCtx.amountSourceStd, currency: currencySourceISO },
            feeSource: { amount: pricingCtx.feeSourceStd, currency: currencySourceISO },
            target: { amount: pricingCtx.amountTargetStd, currency: currencyTargetISO },
            fxRateSourceToTarget: pricingCtx.rateUsed,
          },
          pricingSnapshot: normalizePricingSnapshot(pricingCtx.pricingSnapshot),
          pricingRuleApplied: pricingCtx.pricingSnapshot?.ruleApplied || null,
          pricingFxRuleApplied: pricingCtx.pricingSnapshot?.fxRuleApplied || null,
          feeSnapshot: {
            fee: pricingCtx.feeSourceStd,
            netAfterFees: pricingCtx.netFrom,
            convertedNetAfterFees: pricingCtx.amountTargetStd,
            exchangeRate: pricingCtx.rateUsed,
            pricingDebug: pricingCtx.pricingSnapshot?.debug || null,
          },
          feeActual: null,
          feeId: null,
          adminRevenue: pricingCtx.adminRevenue,
          adminRevenueCredited: false,
          adminRevenueCreditedAt: null,
          securityQuestion: q,
          securityAnswerHash,
          securityCode: securityAnswerHash,
          amlSnapshot,
          amlStatus: amlSnapshot?.status || "passed",
          description: sanitize(description),
          orderId: body.orderId || null,
          metadata: txMetadata,
          meta: txMeta,
          status: "pending",
          providerReference: pickExternalRef(body),
          providerStatus: "PENDING_USER_CONFIRMATION",
          fundsReserved: false,
          fundsReservedAt: null,
          fundsCaptured: false,
          fundsCapturedAt: null,
          beneficiaryCredited: false,
          beneficiaryCreditedAt: null,
          reserveReleased: false,
          reserveReleasedAt: null,
          reversedAt: null,
          executedAt: null,
          attemptCount: 0,
          lastAttemptAt: null,
          lockedUntil: null,
        },
      ],
      sessOpts
    );

    await reserveSenderFunds({
      transaction: tx,
      senderId: senderUser._id,
      amount: pricingCtx.amountSourceStd,
      currency: currencySourceISO,
      session,
    });

    tx.fundsReserved = true;
    tx.fundsReservedAt = new Date();
    tx.providerStatus = "FUNDS_RESERVED";
    await tx.save(sessOpts);

    logTransaction({
      userId: senderId,
      type: "initiate",
      provider,
      amount: pricingCtx.amountSourceStd,
      currency: currencySourceISO,
      toEmail:
        tx.recipientEmail ||
        externalRecipientMeta.phoneNumber ||
        externalRecipientMeta.iban ||
        externalRecipientMeta.maskedCardNumber ||
        "",
      details: {
        transactionId: tx._id.toString(),
        reference: tx.reference,
        flow,
      },
      flagged: false,
      flagReason: "",
      transactionId: tx._id,
      ip: req.ip,
    }).catch(() => {});

    await notifyTransactionEvent(tx, "initiated", session, currencySourceISO);

    if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
    session.endSession();

    let execution = null;
    try {
      execution = await submitExternalExecution({
        req,
        transactionId: tx._id.toString(),
      });
    } catch (e) {
      logger.error("[TX-CORE][OUTBOUND] provider submission failed", {
        transactionId: tx._id.toString(),
        flow,
        message: e.message,
        status: e.status,
      });
    }

    return res.status(201).json({
      success: true,
      transactionId: tx._id.toString(),
      reference: tx.reference,
      flow: tx.flow,
      status: execution?.status || tx.status,
      providerStatus: execution?.providerStatus || tx.providerStatus,
      providerReference: execution?.providerReference || tx.providerReference || null,
      securityQuestion: q,
      pricing: {
        feeSource: pricingCtx.feeSourceStd,
        feeSourceCurrency: currencySourceISO,
        netFrom: pricingCtx.netFrom,
        netTo: pricingCtx.amountTargetStd,
        targetCurrency: currencyTargetISO,
        marketRate: pricingCtx.pricingSnapshot?.result?.marketRate ?? null,
        appliedRate: pricingCtx.pricingSnapshot?.result?.appliedRate ?? null,
        feeRevenue: pricingCtx.pricingSnapshot?.result?.feeRevenue || null,
        fxRevenue: pricingCtx.pricingSnapshot?.result?.fxRevenue || null,
      },
      adminRevenue: pricingCtx.adminRevenue,
      fundsReserved: true,
      adminCreditedAtInitiate: false,
      externalRecipient: redactSensitiveFields(externalRecipientMeta),
    });
  } catch (err) {
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    next(err);
  }
}

async function initiateInboundExternal(req, res, next) {
  const session = await startTxSession();

  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

    const body = req.body || {};
    const flow = resolveExternalFlow(body);

    if (!isInboundExternalFlow(flow)) {
      throw createError(400, "Flow collection externe invalide");
    }

    const {
      amount,
      description = "",
      country,
      metadata = {},
      meta = {},
    } = body;

    if (description && description.length > MAX_DESC_LENGTH) {
      throw createError(400, "Description trop longue");
    }

    const receiverId = req.user.id;
    const amt = toFloat(amount ?? body.amountSource);
    if (!amt || Number.isNaN(amt) || amt <= 0) {
      throw createError(400, "Montant invalide");
    }

    await validationService.validateTransactionAmount({ amount: amt });

    const sessOpts = maybeSessionOpts(session);

    const receiverUser = await User.findById(receiverId)
      .select("fullName email")
      .lean()
      .session(sessOpts.session || null);

    if (!receiverUser) {
      throw createError(403, "Utilisateur invalide");
    }

    const provider = resolveProviderForFlow(flow, body);
    const externalSourceMeta = buildRecipientExternalMeta(flow, body);
    const { country: resolvedCountry, fromCountry, toCountry } = resolveCountries(body, country);
    const { currencySourceISO, currencyTargetISO } = resolveCurrencies({
      body,
      normCur,
      country: resolvedCountry,
    });

    await validationService.detectBasicFraud({
      sender: body.phoneNumber || body.iban || body.cardHolder || body.accountHolder || "external",
      receiverEmail: receiverUser.email,
      amount: amt,
      currency: currencySourceISO,
    });

    req.body.senderCurrencyCode = currencySourceISO;
    req.body.localCurrencyCode = currencyTargetISO;
    req.body.senderCurrencySymbol = currencySourceISO;
    req.body.localCurrencySymbol = currencyTargetISO;
    req.body.fromCountry = fromCountry;
    req.body.toCountry = toCountry;
    req.body.country = resolvedCountry;

    const pricingCtx = await buildPricingContext({
      req,
      body,
      amount: amt,
      country: resolvedCountry,
      provider,
      currencySourceISO,
      currencyTargetISO,
    });

    const reference = await generateTransactionRef();
    const amlSnapshot = req.aml || null;

    const txMeta = {
      ...((meta && typeof meta === "object") ? meta : {}),
      ...buildExternalMeta({
        receiverUser,
        body,
        extra: {
          entry: "external_collection.pending",
          requestOrigin: "tx-core",
          externalSource: externalSourceMeta,
        },
      }),
    };

    const txMetadata = {
      ...((metadata && typeof metadata === "object") ? metadata : {}),
      ...buildExternalMetadata({
        flow,
        provider,
        body,
        extra: {
          providerReference: pickExternalRef(body),
          externalSource: externalSourceMeta,
        },
      }),
    };

    const [tx] = await Transaction.create(
      [
        {
          userId: receiverUser._id,
          internalImported: false,
          flow,
          operationKind: "transfer",
          initiatedBy: "user",
          context: "external_collection",
          contextId: null,
          reference,
          idempotencyKey: body.idempotencyKey || null,
          sender: null,
          receiver: receiverUser._id,
          senderName: sanitize(
            body.senderName ||
              body.accountHolder ||
              body.cardHolder ||
              "Source externe"
          ),
          senderEmail: null,
          nameDestinataire: receiverUser.fullName,
          recipientEmail: receiverUser.email,
          destination: "paynoval",
          funds:
            flow === INBOUND_EXTERNAL_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL
              ? "mobilemoney"
              : flow === INBOUND_EXTERNAL_FLOWS.BANK_TRANSFER_TO_PAYNOVAL
              ? "bank"
              : provider === "visa_direct"
              ? "visa_direct"
              : "stripe",
          provider,
          operator: body.operator || txMetadata?.provider || null,
          country: sanitize(resolvedCountry),
          amount: dec2(pricingCtx.amountSourceStd),
          transactionFees: dec2(pricingCtx.feeSourceStd),
          netAmount: dec2(pricingCtx.netFrom),
          exchangeRate: dec2(pricingCtx.rateUsed),
          localAmount: dec2(pricingCtx.amountTargetStd),
          senderCurrencySymbol: currencySourceISO,
          localCurrencySymbol: currencyTargetISO,
          amountSource: dec2(pricingCtx.amountSourceStd),
          amountTarget: dec2(pricingCtx.amountTargetStd),
          feeSource: dec2(pricingCtx.feeSourceStd),
          fxRateSourceToTarget: dec2(pricingCtx.rateUsed),
          currencySource: currencySourceISO,
          currencyTarget: currencyTargetISO,
          money: {
            source: { amount: pricingCtx.amountSourceStd, currency: currencySourceISO },
            feeSource: { amount: pricingCtx.feeSourceStd, currency: currencySourceISO },
            target: { amount: pricingCtx.amountTargetStd, currency: currencyTargetISO },
            fxRateSourceToTarget: pricingCtx.rateUsed,
          },
          pricingSnapshot: normalizePricingSnapshot(pricingCtx.pricingSnapshot),
          pricingRuleApplied: pricingCtx.pricingSnapshot?.ruleApplied || null,
          pricingFxRuleApplied: pricingCtx.pricingSnapshot?.fxRuleApplied || null,
          feeSnapshot: {
            fee: pricingCtx.feeSourceStd,
            netAfterFees: pricingCtx.netFrom,
            convertedNetAfterFees: pricingCtx.amountTargetStd,
            exchangeRate: pricingCtx.rateUsed,
            pricingDebug: pricingCtx.pricingSnapshot?.debug || null,
          },
          feeActual: null,
          feeId: null,
          adminRevenue: pricingCtx.adminRevenue,
          adminRevenueCredited: false,
          adminRevenueCreditedAt: null,
          securityQuestion: null,
          securityAnswerHash: null,
          securityCode: null,
          amlSnapshot,
          amlStatus: amlSnapshot?.status || "passed",
          description: sanitize(description),
          orderId: body.orderId || null,
          metadata: txMetadata,
          meta: txMeta,
          status: "processing",
          providerReference: pickExternalRef(body),
          providerStatus: "AWAITING_PROVIDER_PAYMENT",
          fundsReserved: false,
          fundsReservedAt: null,
          fundsCaptured: false,
          fundsCapturedAt: null,
          beneficiaryCredited: false,
          beneficiaryCreditedAt: null,
          reserveReleased: false,
          reserveReleasedAt: null,
          reversedAt: null,
          executedAt: null,
          attemptCount: 0,
          lastAttemptAt: null,
          lockedUntil: null,
        },
      ],
      sessOpts
    );

    logTransaction({
      userId: receiverId,
      type: "initiate",
      provider,
      amount: pricingCtx.amountSourceStd,
      currency: currencySourceISO,
      toEmail: receiverUser.email,
      details: {
        transactionId: tx._id.toString(),
        reference: tx.reference,
        flow,
      },
      flagged: false,
      flagReason: "",
      transactionId: tx._id,
      ip: req.ip,
    }).catch(() => {});

    await notifyTransactionEvent(tx, "processing", session, currencyTargetISO);

    if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
    session.endSession();

    let execution = null;
    try {
      execution = await submitExternalExecution({
        req,
        transactionId: tx._id.toString(),
      });
    } catch (e) {
      logger.error("[TX-CORE][INBOUND] provider submission failed", {
        transactionId: tx._id.toString(),
        flow,
        message: e.message,
        status: e.status,
      });
    }

    return res.status(201).json({
      success: true,
      transactionId: tx._id.toString(),
      reference: tx.reference,
      flow: tx.flow,
      status: execution?.status || tx.status,
      providerStatus: execution?.providerStatus || tx.providerStatus,
      providerReference: execution?.providerReference || tx.providerReference || null,
      pricing: {
        feeSource: pricingCtx.feeSourceStd,
        feeSourceCurrency: currencySourceISO,
        netFrom: pricingCtx.netFrom,
        netTo: pricingCtx.amountTargetStd,
        targetCurrency: currencyTargetISO,
        marketRate: pricingCtx.pricingSnapshot?.result?.marketRate ?? null,
        appliedRate: pricingCtx.pricingSnapshot?.result?.appliedRate ?? null,
        feeRevenue: pricingCtx.pricingSnapshot?.result?.feeRevenue || null,
        fxRevenue: pricingCtx.pricingSnapshot?.result?.fxRevenue || null,
      },
      adminRevenue: pricingCtx.adminRevenue,
      externalSource: redactSensitiveFields(externalSourceMeta),
      message: "Demande créée. En attente de confirmation provider.",
    });
  } catch (err) {
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    next(err);
  }
}

module.exports = {
  initiateOutboundExternal,
  initiateInboundExternal,
};