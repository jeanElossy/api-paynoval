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
//   normalizeTreasurySystemType,
//   startTxSession,
//   maybeSessionOpts,
//   canUseSharedSession,
// } = require("../shared/runtime");

// const { notifyTransactionEvent } = require("../transactionNotificationService");

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

// const DEFAULT_FEES_TREASURY_SYSTEM_TYPE = "FEES_TREASURY";
// const DEFAULT_FEES_TREASURY_LABEL = "PayNoval Fees Treasury";

// function ensureBearer(req) {
//   const authHeader = req.headers.authorization;
//   if (!authHeader || !authHeader.startsWith("Bearer ")) {
//     throw createError(401, "Token manquant");
//   }
//   return authHeader;
// }

// function resolveFeesTreasurySeed() {
//   const treasurySystemType = normalizeTreasurySystemType
//     ? normalizeTreasurySystemType(DEFAULT_FEES_TREASURY_SYSTEM_TYPE)
//     : DEFAULT_FEES_TREASURY_SYSTEM_TYPE;

//   return {
//     treasuryUserId: null,
//     treasurySystemType,
//     treasuryLabel: DEFAULT_FEES_TREASURY_LABEL,
//   };
// }

// function pickExternalDisplayName(body = {}) {
//   return sanitize(
//     body.recipientName ||
//       body.accountHolder ||
//       body.cardHolder ||
//       body.toName ||
//       body.recipientInfo?.name ||
//       body.beneficiary?.name ||
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

// function pickExternalRecipientEmail(body = {}) {
//   const email =
//     body.toEmail ||
//     body.recipientEmail ||
//     body.recipientInfo?.email ||
//     body.recipientInfo?.recipientEmail ||
//     body.beneficiary?.email ||
//     "";

//   if (!isEmailLike(email)) return null;
//   return String(email).trim().toLowerCase();
// }

// function normalizeMethodForPricing(body = {}, provider = "") {
//   const method = String(body.method || "").trim().toUpperCase();
//   if (method) return method;

//   const methodType = String(body.methodType || "").trim().toLowerCase();

//   if (methodType === "internal") return "INTERNAL";
//   if (methodType === "bank") return "BANK";
//   if (methodType === "visa" || methodType === "card") return "VISA";

//   if (
//     ["mobilemoney", "mobile_money", "momo", "mobilemoneyaccount", "mobile_money_account"].includes(
//       methodType
//     )
//   ) {
//     return "MOBILE_MONEY";
//   }

//   if (provider) return String(provider).trim().toUpperCase();
//   return "MOBILE_MONEY";
// }

// function normalizeTxTypeForPricing(body = {}) {
//   const txType = String(body.txType || body.transactionType || "").trim().toUpperCase();
//   if (txType) return txType;

//   const action = String(body.action || "").trim().toLowerCase();
//   if (action === "deposit") return "DEPOSIT";
//   if (action === "withdraw") return "WITHDRAW";

//   return "TRANSFER";
// }

// function buildRecipientExternalMeta(flow, body = {}) {
//   if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT) {
//     return {
//       phoneNumber:
//         body.phoneNumber ||
//         body.toPhone ||
//         body.recipientPhone ||
//         body.recipient ||
//         body.beneficiary?.phoneNumber ||
//         null,
//       operator:
//         body.operator ||
//         body.operatorName ||
//         body.metadata?.provider ||
//         body.meta?.provider ||
//         null,
//       recipientName:
//         body.recipientName ||
//         body.toName ||
//         body.recipientInfo?.name ||
//         body.beneficiary?.name ||
//         null,
//     };
//   }

//   if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_BANK_PAYOUT) {
//     return {
//       iban: body.iban || body.beneficiary?.iban || null,
//       swift: body.swift || body.beneficiary?.swift || null,
//       bankName: body.bankName || body.beneficiary?.bankName || null,
//       accountHolder:
//         body.accountHolder ||
//         body.recipientName ||
//         body.beneficiary?.accountHolder ||
//         body.beneficiary?.name ||
//         null,
//       accountNumberLast4: body.accountNumber
//         ? String(body.accountNumber).slice(-4)
//         : body.bankAccountNumber
//         ? String(body.bankAccountNumber).slice(-4)
//         : body.beneficiary?.accountNumber
//         ? String(body.beneficiary.accountNumber).slice(-4)
//         : null,
//     };
//   }

//   if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_CARD_PAYOUT) {
//     return {
//       maskedCardNumber: maskPan(body.cardNumber || body.beneficiary?.cardNumber),
//       cardHolder:
//         body.cardHolder ||
//         body.toName ||
//         body.recipientName ||
//         body.beneficiary?.cardHolder ||
//         body.beneficiary?.name ||
//         null,
//       providerHint: body.provider || body.providerSelected || null,
//     };
//   }

//   if (flow === INBOUND_EXTERNAL_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL) {
//     return {
//       phoneNumber:
//         body.phoneNumber ||
//         body.fromPhone ||
//         body.recipientPhone ||
//         body.beneficiary?.phoneNumber ||
//         null,
//       operator:
//         body.operator ||
//         body.operatorName ||
//         body.metadata?.provider ||
//         body.meta?.provider ||
//         null,
//     };
//   }

//   if (flow === INBOUND_EXTERNAL_FLOWS.BANK_TRANSFER_TO_PAYNOVAL) {
//     return {
//       iban: body.iban || body.beneficiary?.iban || null,
//       swift: body.swift || body.beneficiary?.swift || null,
//       bankName: body.bankName || body.beneficiary?.bankName || null,
//       accountHolder:
//         body.accountHolder ||
//         body.senderName ||
//         body.beneficiary?.accountHolder ||
//         body.beneficiary?.name ||
//         null,
//       accountNumberLast4: body.accountNumber
//         ? String(body.accountNumber).slice(-4)
//         : body.bankAccountNumber
//         ? String(body.bankAccountNumber).slice(-4)
//         : body.beneficiary?.accountNumber
//         ? String(body.beneficiary.accountNumber).slice(-4)
//         : null,
//     };
//   }

//   if (flow === INBOUND_EXTERNAL_FLOWS.CARD_TOPUP_TO_PAYNOVAL) {
//     return {
//       maskedCardNumber: maskPan(body.cardNumber || body.beneficiary?.cardNumber),
//       cardHolder:
//         body.cardHolder ||
//         body.senderName ||
//         body.beneficiary?.cardHolder ||
//         null,
//       providerHint: body.provider || body.providerSelected || null,
//     };
//   }

//   return {};
// }

// async function buildPricingContext({
//   req,
//   body,
//   amount,
//   country,
//   provider,
//   currencySourceISO,
//   currencyTargetISO,
// }) {
//   const authHeader = ensureBearer(req);

//   const pricingInput = pickBodyPricingInput({
//     ...req.body,
//     amount,
//     fromCurrency: currencySourceISO,
//     toCurrency: currencyTargetISO,
//     provider,
//     method: normalizeMethodForPricing(body, provider),
//     txType: normalizeTxTypeForPricing(body),
//     fromCountry: body.fromCountry || body.sourceCountry || country,
//     toCountry: body.toCountry || body.targetCountry || body.destinationCountry || country,
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
//     treasuryRevenue,
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
//     treasuryRevenue,
//   };
// }

// async function initiateOutboundExternal(req, res, next) {
//   const session = await startTxSession();

//   try {
//     if (canUseSharedSession()) session.startTransaction();

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
//         pickExternalRecipientEmail(body) ||
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
//     req.body.sourceCountry = fromCountry;
//     req.body.targetCountry = toCountry;
//     req.body.country = resolvedCountry;
//     req.body.description = sanitize(description);
//     req.body.securityQuestion = q;
//     req.body.securityAnswer = aRaw;

//     const pricingCtx = await buildPricingContext({
//       req,
//       body,
//       amount: amt,
//       country: resolvedCountry,
//       provider,
//       currencySourceISO,
//       currencyTargetISO,
//     });

//     const reference = sanitize(body.reference) || (await generateTransactionRef());
//     const securityAnswerHash = sha256Hex(aRaw);
//     const amlSnapshot = req.aml || null;
//     const treasurySeed = resolveFeesTreasurySeed();

//     const txMeta = {
//       ...((meta && typeof meta === "object") ? meta : {}),
//       ...buildExternalMeta({
//         senderUser,
//         body,
//         extra: {
//           entry: "external_payout.pending",
//           requestOrigin: "tx-core",
//           externalRecipient: externalRecipientMeta,
//           description: sanitize(description),
//           securityQuestion: q,
//           effectivePricingId:
//             body.effectivePricingId ||
//             body.pricingLockId ||
//             body.pricingId ||
//             body.quoteId ||
//             null,
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
//           recipientEmail: pickExternalRecipientEmail(body),
//           destination:
//             flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT
//               ? "mobilemoney"
//               : flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_BANK_PAYOUT
//               ? "bank"
//               : "visa_direct",
//           funds: "paynoval",
//           provider,
//           operator: body.operator || body.operatorName || txMetadata?.provider || null,
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
//           treasuryRevenue: pricingCtx.treasuryRevenue,
//           treasuryRevenueCredited: false,
//           treasuryRevenueCreditedAt: null,
//           treasuryUserId: treasurySeed.treasuryUserId,
//           treasurySystemType: treasurySeed.treasurySystemType,
//           treasuryLabel: treasurySeed.treasuryLabel,
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

//     await notifyTransactionEvent(tx, "initiated", session, currencySourceISO);

//     if (canUseSharedSession()) await session.commitTransaction();
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
//       treasuryRevenue: pricingCtx.treasuryRevenue,
//       fundsReserved: true,
//       treasuryCreditedAtInitiate: false,
//       externalRecipient: redactSensitiveFields(externalRecipientMeta),
//     });
//   } catch (err) {
//     try {
//       if (canUseSharedSession()) await session.abortTransaction();
//     } catch {}
//     session.endSession();
//     next(err);
//   }
// }

// async function initiateInboundExternal(req, res, next) {
//   const session = await startTxSession();

//   try {
//     if (canUseSharedSession()) session.startTransaction();

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
//       sender:
//         body.phoneNumber ||
//         body.fromPhone ||
//         body.iban ||
//         body.cardHolder ||
//         body.accountHolder ||
//         "external",
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
//     req.body.sourceCountry = fromCountry;
//     req.body.targetCountry = toCountry;
//     req.body.country = resolvedCountry;
//     req.body.description = sanitize(description);

//     const pricingCtx = await buildPricingContext({
//       req,
//       body,
//       amount: amt,
//       country: resolvedCountry,
//       provider,
//       currencySourceISO,
//       currencyTargetISO,
//     });

//     const reference = sanitize(body.reference) || (await generateTransactionRef());
//     const amlSnapshot = req.aml || null;
//     const treasurySeed = resolveFeesTreasurySeed();

//     const txMeta = {
//       ...((meta && typeof meta === "object") ? meta : {}),
//       ...buildExternalMeta({
//         receiverUser,
//         body,
//         extra: {
//           entry: "external_collection.pending",
//           requestOrigin: "tx-core",
//           externalSource: externalSourceMeta,
//           description: sanitize(description),
//           effectivePricingId:
//             body.effectivePricingId ||
//             body.pricingLockId ||
//             body.pricingId ||
//             body.quoteId ||
//             null,
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
//           operator: body.operator || body.operatorName || txMetadata?.provider || null,
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
//           treasuryRevenue: pricingCtx.treasuryRevenue,
//           treasuryRevenueCredited: false,
//           treasuryRevenueCreditedAt: null,
//           treasuryUserId: treasurySeed.treasuryUserId,
//           treasurySystemType: treasurySeed.treasurySystemType,
//           treasuryLabel: treasurySeed.treasuryLabel,
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

//     await notifyTransactionEvent(tx, "processing", session, currencyTargetISO);

//     if (canUseSharedSession()) await session.commitTransaction();
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
//       treasuryRevenue: pricingCtx.treasuryRevenue,
//       externalSource: redactSensitiveFields(externalSourceMeta),
//       message: "Demande créée. En attente de confirmation provider.",
//     });
//   } catch (err) {
//     try {
//       if (canUseSharedSession()) await session.abortTransaction();
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
  normalizeTreasurySystemType,
  startTxSession,
  maybeSessionOpts,
  canUseSharedSession,
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

const {
  normalizeCurrency,
  validateOutboundExternalCorridor,
  validateInboundExternalCorridor,
} = require("./corridorValidation");

const { submitExternalExecution } = require("./submitExternalExecution");

const DEFAULT_FEES_TREASURY_SYSTEM_TYPE = "FEES_TREASURY";
const DEFAULT_FEES_TREASURY_LABEL = "PayNoval Fees Treasury";
const DEFAULT_AUTO_CANCEL_AFTER_DAYS = 7;

const USER_CORRIDOR_SELECT = [
  "_id",
  "fullName",
  "email",
  "phone",

  "country",
  "countryCode",
  "selectedCountry",
  "residenceCountry",
  "registrationCountry",
  "nationality",

  "currency",
  "currencyCode",
  "defaultCurrency",
  "managedCurrency",

  "userType",
  "role",
  "isBusiness",
  "isSystem",
  "systemType",

  "accountStatus",
  "status",
  "staffStatus",

  "isBlocked",
  "isLoginDisabled",
  "hiddenFromTransfers",
  "hiddenFromUserSearch",
  "hiddenFromUserApp",

  "kycStatus",
  "kybStatus",

  "kyc",
  "kyb",
  "profile",
  "address",
  "wallet",

  "isDeleted",
  "deletedAt",
].join(" ");

function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .replace(/\s+/g, "_")
    .toLowerCase();
}

function getAutoCancelAfterDays() {
  const raw = Number(
    process.env.TX_AUTO_CANCEL_AFTER_DAYS || DEFAULT_AUTO_CANCEL_AFTER_DAYS
  );

  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_AUTO_CANCEL_AFTER_DAYS;
  }

  return Math.max(1, Math.floor(raw));
}

function buildAutoCancelAt(fromDate = new Date()) {
  const base = fromDate instanceof Date ? fromDate : new Date();
  const days = getAutoCancelAfterDays();

  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

function isAutoCancellableStatus(status) {
  const s = normalizeStatus(status);

  return [
    "pending",
    "pendingvalidation",
    "pending_validation",
    "initiated",
    "awaiting_validation",
    "awaiting_confirmation",
    "processing",
  ].includes(s);
}

function buildAutoCancelFields(status = "pending") {
  if (!isAutoCancellableStatus(status)) {
    return {
      autoCancelAt: null,
      autoCancelledAt: null,
      autoCancelReason: "",
      autoCancelLockAt: null,
      autoCancelWorkerId: "",
      lastAutoCancelError: "",
    };
  }

  return {
    autoCancelAt: buildAutoCancelAt(),
    autoCancelledAt: null,
    autoCancelReason: "",
    autoCancelLockAt: null,
    autoCancelWorkerId: "",
    lastAutoCancelError: "",
  };
}

function ensureBearer(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw createError(401, "Token manquant");
  }

  return authHeader;
}

function resolveFeesTreasurySeed() {
  const treasurySystemType = normalizeTreasurySystemType
    ? normalizeTreasurySystemType(DEFAULT_FEES_TREASURY_SYSTEM_TYPE)
    : DEFAULT_FEES_TREASURY_SYSTEM_TYPE;

  return {
    treasuryUserId: null,
    treasurySystemType,
    treasuryLabel: DEFAULT_FEES_TREASURY_LABEL,
  };
}

function pickExternalDisplayName(body = {}) {
  return sanitize(
    body.recipientName ||
      body.accountHolder ||
      body.cardHolder ||
      body.toName ||
      body.recipientInfo?.name ||
      body.beneficiary?.name ||
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

function pickExternalRecipientEmail(body = {}) {
  const email =
    body.toEmail ||
    body.recipientEmail ||
    body.recipientInfo?.email ||
    body.recipientInfo?.recipientEmail ||
    body.beneficiary?.email ||
    "";

  if (!isEmailLike(email)) return null;

  return String(email).trim().toLowerCase();
}

function normalizeMethodForPricing(body = {}, provider = "") {
  const method = String(body.method || "").trim().toUpperCase();

  if (method) return method;

  const methodType = String(body.methodType || "").trim().toLowerCase();

  if (methodType === "internal") return "INTERNAL";
  if (methodType === "bank") return "BANK";
  if (methodType === "visa" || methodType === "card") return "VISA";

  if (
    [
      "mobilemoney",
      "mobile_money",
      "momo",
      "mobilemoneyaccount",
      "mobile_money_account",
    ].includes(methodType)
  ) {
    return "MOBILE_MONEY";
  }

  if (provider) return String(provider).trim().toUpperCase();

  return "MOBILE_MONEY";
}

function normalizeTxTypeForPricing(body = {}) {
  const txType = String(body.txType || body.transactionType || "")
    .trim()
    .toUpperCase();

  if (txType) return txType;

  const action = String(body.action || "").trim().toLowerCase();

  if (action === "deposit") return "DEPOSIT";
  if (action === "withdraw") return "WITHDRAW";

  return "TRANSFER";
}

function buildRecipientExternalMeta(flow, body = {}) {
  if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT) {
    return {
      phoneNumber:
        body.phoneNumber ||
        body.toPhone ||
        body.recipientPhone ||
        body.recipient ||
        body.beneficiary?.phoneNumber ||
        null,
      operator:
        body.operator ||
        body.operatorName ||
        body.metadata?.provider ||
        body.meta?.provider ||
        null,
      recipientName:
        body.recipientName ||
        body.toName ||
        body.recipientInfo?.name ||
        body.beneficiary?.name ||
        null,
    };
  }

  if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_BANK_PAYOUT) {
    return {
      iban: body.iban || body.beneficiary?.iban || null,
      swift: body.swift || body.beneficiary?.swift || null,
      bankName: body.bankName || body.beneficiary?.bankName || null,
      accountHolder:
        body.accountHolder ||
        body.recipientName ||
        body.beneficiary?.accountHolder ||
        body.beneficiary?.name ||
        null,
      accountNumberLast4: body.accountNumber
        ? String(body.accountNumber).slice(-4)
        : body.bankAccountNumber
        ? String(body.bankAccountNumber).slice(-4)
        : body.beneficiary?.accountNumber
        ? String(body.beneficiary.accountNumber).slice(-4)
        : null,
    };
  }

  if (flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_CARD_PAYOUT) {
    return {
      maskedCardNumber: maskPan(body.cardNumber || body.beneficiary?.cardNumber),
      cardHolder:
        body.cardHolder ||
        body.toName ||
        body.recipientName ||
        body.beneficiary?.cardHolder ||
        body.beneficiary?.name ||
        null,
      providerHint: body.provider || body.providerSelected || null,
    };
  }

  if (flow === INBOUND_EXTERNAL_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL) {
    return {
      phoneNumber:
        body.phoneNumber ||
        body.fromPhone ||
        body.recipientPhone ||
        body.beneficiary?.phoneNumber ||
        null,
      operator:
        body.operator ||
        body.operatorName ||
        body.metadata?.provider ||
        body.meta?.provider ||
        null,
    };
  }

  if (flow === INBOUND_EXTERNAL_FLOWS.BANK_TRANSFER_TO_PAYNOVAL) {
    return {
      iban: body.iban || body.beneficiary?.iban || null,
      swift: body.swift || body.beneficiary?.swift || null,
      bankName: body.bankName || body.beneficiary?.bankName || null,
      accountHolder:
        body.accountHolder ||
        body.senderName ||
        body.beneficiary?.accountHolder ||
        body.beneficiary?.name ||
        null,
      accountNumberLast4: body.accountNumber
        ? String(body.accountNumber).slice(-4)
        : body.bankAccountNumber
        ? String(body.bankAccountNumber).slice(-4)
        : body.beneficiary?.accountNumber
        ? String(body.beneficiary.accountNumber).slice(-4)
        : null,
    };
  }

  if (flow === INBOUND_EXTERNAL_FLOWS.CARD_TOPUP_TO_PAYNOVAL) {
    return {
      maskedCardNumber: maskPan(body.cardNumber || body.beneficiary?.cardNumber),
      cardHolder:
        body.cardHolder ||
        body.senderName ||
        body.beneficiary?.cardHolder ||
        null,
      providerHint: body.provider || body.providerSelected || null,
    };
  }

  return {};
}

async function buildPricingContext({
  req,
  body,
  amount,
  country,
  provider,
  currencySourceISO,
  currencyTargetISO,
}) {
  const authHeader = ensureBearer(req);
  const effectiveBody = { ...body, ...req.body };

  const pricingInput = pickBodyPricingInput({
    ...effectiveBody,
    amount,
    fromCurrency: currencySourceISO,
    toCurrency: currencyTargetISO,
    provider,
    method: normalizeMethodForPricing(effectiveBody, provider),
    txType: normalizeTxTypeForPricing(effectiveBody),
    fromCountry:
      effectiveBody.fromCountry || effectiveBody.sourceCountry || country,
    toCountry:
      effectiveBody.toCountry ||
      effectiveBody.targetCountry ||
      effectiveBody.destinationCountry ||
      country,
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
    treasuryRevenue,
  } = extractPricingBundle(pricingPayload, pricingInput);

  if (!Number.isFinite(grossFrom) || grossFrom <= 0) {
    throw createError(500, "grossFrom pricing invalide");
  }

  if (!Number.isFinite(fee) || fee < 0) {
    throw createError(500, "fee pricing invalide");
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

  if (!Number.isFinite(rateUsed) || rateUsed <= 0) {
    throw createError(500, "Taux appliqué invalide");
  }

  return {
    pricingInput,
    pricingSnapshot,
    amountSourceStd,
    feeSourceStd,
    netFrom,
    amountTargetStd,
    rateUsed,
    treasuryRevenue,
  };
}

function safeResolveFlow(body) {
  try {
    return resolveExternalFlow(body || {});
  } catch {
    return null;
  }
}

async function initiateOutboundExternal(req, res, next) {
  const session = await startTxSession();

  try {
    if (canUseSharedSession()) session.startTransaction();

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

    const senderId = String(req.user?.id || req.user?._id || "").trim();

    if (!senderId) {
      throw createError(401, "Utilisateur non authentifié");
    }

    const amt = toFloat(amount ?? body.amountSource);

    if (!Number.isFinite(amt) || amt <= 0) {
      throw createError(400, "Montant invalide");
    }

    await validationService.validateTransactionAmount({ amount: amt });

    const sessOpts = maybeSessionOpts(session);

    const senderUser = await User.findById(senderId)
      .select(USER_CORRIDOR_SELECT)
      .lean()
      .session(sessOpts.session || null);

    if (!senderUser) {
      throw createError(403, "Utilisateur invalide");
    }

    const provider = resolveProviderForFlow(flow, body);
    const externalRecipientMeta = buildRecipientExternalMeta(flow, body);

    const {
      country: resolvedCountry,
      fromCountry,
      toCountry,
    } = resolveCountries(body, country);

    let { currencySourceISO, currencyTargetISO } = resolveCurrencies({
      body,
      normCur,
      country: resolvedCountry,
    });

    currencySourceISO = normalizeCurrency(currencySourceISO);
    currencyTargetISO = normalizeCurrency(currencyTargetISO);

    const requestedSourceCountry = body.fromCountry || body.sourceCountry || "";
    const requestedTargetCountry =
      body.toCountry ||
      body.destinationCountry ||
      body.targetCountry ||
      body.country ||
      toCountry ||
      resolvedCountry ||
      "";

    const corridorLock = validateOutboundExternalCorridor({
      flow,
      body,
      senderUser,
      fromCountry: requestedSourceCountry || fromCountry || "",
      toCountry: requestedTargetCountry,
      currencySource: currencySourceISO,
      currencyTarget: currencyTargetISO,
    });

    currencySourceISO = corridorLock.lockedSourceCurrency;
    currencyTargetISO = corridorLock.lockedTargetCurrency;

    if (!currencySourceISO) {
      throw createError(400, "Devise source introuvable");
    }

    if (!currencyTargetISO) {
      throw createError(400, "Devise destination introuvable");
    }

    await validationService.detectBasicFraud({
      sender: senderId,
      receiverEmail:
        pickExternalRecipientEmail(body) ||
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

    req.body.currencySource = currencySourceISO;
    req.body.currencyTarget = currencyTargetISO;
    req.body.fromCurrency = currencySourceISO;
    req.body.toCurrency = currencyTargetISO;

    req.body.fromCountry = corridorLock.lockedSourceCountry;
    req.body.toCountry = corridorLock.lockedTargetCountry;
    req.body.sourceCountry = corridorLock.lockedSourceCountry;
    req.body.targetCountry = corridorLock.lockedTargetCountry;
    req.body.destinationCountry = corridorLock.lockedTargetCountry;
    req.body.country = corridorLock.lockedTargetCountry;

    req.body.description = sanitize(description);
    req.body.securityQuestion = q;
    req.body.securityAnswer = aRaw;

    const pricingCtx = await buildPricingContext({
      req,
      body,
      amount: amt,
      country: req.body.country,
      provider,
      currencySourceISO,
      currencyTargetISO,
    });

    const reference = sanitize(body.reference) || (await generateTransactionRef());
    const securityAnswerHash = sha256Hex(aRaw);
    const amlSnapshot = req.aml || null;
    const treasurySeed = resolveFeesTreasurySeed();
    const autoCancelFields = buildAutoCancelFields("pending");

    const txMeta = {
      ...((meta && typeof meta === "object") ? meta : {}),
      ...buildExternalMeta({
        senderUser,
        body: req.body,
        extra: {
          entry: "external_payout.pending",
          requestOrigin: "tx-core",
          externalRecipient: externalRecipientMeta,
          description: sanitize(description),
          securityQuestion: q,
          corridorLock: corridorLock.snapshot,
          effectivePricingId:
            body.effectivePricingId ||
            body.pricingLockId ||
            body.pricingId ||
            body.quoteId ||
            null,
          autoCancelAt: autoCancelFields.autoCancelAt,
          autoCancelAfterDays: getAutoCancelAfterDays(),
        },
      }),
    };

    const txMetadata = {
      ...((metadata && typeof metadata === "object") ? metadata : {}),
      ...buildExternalMetadata({
        flow,
        provider,
        body: req.body,
        extra: {
          providerReference: pickExternalRef(body),
          externalRecipient: externalRecipientMeta,
          corridorLock: corridorLock.snapshot,
          autoCancelAt: autoCancelFields.autoCancelAt,
          autoCancelAfterDays: getAutoCancelAfterDays(),
        },
      }),
      corridorLock: corridorLock.snapshot,
      autoCancelAt: autoCancelFields.autoCancelAt,
      autoCancelAfterDays: getAutoCancelAfterDays(),
    };

    const destinationValue =
      flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT
        ? "mobilemoney"
        : flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_BANK_PAYOUT
        ? "bank"
        : "visa_direct";

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
          recipientEmail: pickExternalRecipientEmail(body),

          destination: destinationValue,
          funds: "paynoval",
          provider,
          operator:
            body.operator || body.operatorName || txMetadata?.provider || null,
          country: sanitize(corridorLock.lockedTargetCountry),

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
            source: {
              amount: pricingCtx.amountSourceStd,
              currency: currencySourceISO,
            },
            feeSource: {
              amount: pricingCtx.feeSourceStd,
              currency: currencySourceISO,
            },
            target: {
              amount: pricingCtx.amountTargetStd,
              currency: currencyTargetISO,
            },
            fxRateSourceToTarget: pricingCtx.rateUsed,
          },

          pricingSnapshot: normalizePricingSnapshot(pricingCtx.pricingSnapshot),
          pricingRuleApplied:
            pricingCtx.pricingSnapshot?.ruleApplied || null,
          pricingFxRuleApplied:
            pricingCtx.pricingSnapshot?.fxRuleApplied || null,

          feeSnapshot: {
            fee: pricingCtx.feeSourceStd,
            netAfterFees: pricingCtx.netFrom,
            convertedNetAfterFees: pricingCtx.amountTargetStd,
            exchangeRate: pricingCtx.rateUsed,
            pricingDebug: pricingCtx.pricingSnapshot?.debug || null,
          },
          feeActual: null,
          feeId: null,

          treasuryRevenue: pricingCtx.treasuryRevenue,
          treasuryRevenueCredited: false,
          treasuryRevenueCreditedAt: null,
          treasuryUserId: treasurySeed.treasuryUserId,
          treasurySystemType: treasurySeed.treasurySystemType,
          treasuryLabel: treasurySeed.treasuryLabel,

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

          ...autoCancelFields,

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
        corridorLock: corridorLock.snapshot,
        autoCancelAt: tx.autoCancelAt || null,
      },
      flagged: false,
      flagReason: "",
      transactionId: tx._id,
      ip: req.ip,
    }).catch(() => {});

    await notifyTransactionEvent(tx, "initiated", session, currencySourceISO);

    if (canUseSharedSession()) await session.commitTransaction();

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
      providerReference:
        execution?.providerReference || tx.providerReference || null,
      securityQuestion: q,
      autoCancelAt: tx.autoCancelAt || null,
      autoCancelAfterDays: getAutoCancelAfterDays(),
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
      treasuryRevenue: pricingCtx.treasuryRevenue,
      fundsReserved: true,
      treasuryCreditedAtInitiate: false,
      externalRecipient: redactSensitiveFields(externalRecipientMeta),
      corridorLock: corridorLock.snapshot,
    });
  } catch (err) {
    logger.error("[TX-CORE][OUTBOUND] initiate failed", {
      message: err.message,
      code: err.code || null,
      details: err.details || null,
      status: err.status || err.statusCode || 500,
      flow: safeResolveFlow(req.body),
    });

    try {
      if (canUseSharedSession()) await session.abortTransaction();
    } catch {}

    session.endSession();
    next(err);
  }
}

async function initiateInboundExternal(req, res, next) {
  const session = await startTxSession();

  try {
    if (canUseSharedSession()) session.startTransaction();

    const body = req.body || {};
    const flow = resolveExternalFlow(body);

    if (!isInboundExternalFlow(flow)) {
      throw createError(400, "Flow collection externe invalide");
    }

    const { amount, description = "", country, metadata = {}, meta = {} } = body;

    if (description && description.length > MAX_DESC_LENGTH) {
      throw createError(400, "Description trop longue");
    }

    const receiverId = String(req.user?.id || req.user?._id || "").trim();

    if (!receiverId) {
      throw createError(401, "Utilisateur non authentifié");
    }

    const amt = toFloat(amount ?? body.amountSource);

    if (!Number.isFinite(amt) || amt <= 0) {
      throw createError(400, "Montant invalide");
    }

    await validationService.validateTransactionAmount({ amount: amt });

    const sessOpts = maybeSessionOpts(session);

    const receiverUser = await User.findById(receiverId)
      .select(USER_CORRIDOR_SELECT)
      .lean()
      .session(sessOpts.session || null);

    if (!receiverUser) {
      throw createError(403, "Utilisateur invalide");
    }

    const provider = resolveProviderForFlow(flow, body);
    const externalSourceMeta = buildRecipientExternalMeta(flow, body);

    const {
      country: resolvedCountry,
      fromCountry,
      toCountry,
    } = resolveCountries(body, country);

    let { currencySourceISO, currencyTargetISO } = resolveCurrencies({
      body,
      normCur,
      country: resolvedCountry,
    });

    currencySourceISO = normalizeCurrency(currencySourceISO);
    currencyTargetISO = normalizeCurrency(currencyTargetISO);

    const requestedSourceCountry =
      body.fromCountry ||
      body.sourceCountry ||
      body.country ||
      fromCountry ||
      resolvedCountry ||
      "";

    const requestedTargetCountry =
      body.toCountry ||
      body.destinationCountry ||
      body.targetCountry ||
      "";

    const corridorLock = validateInboundExternalCorridor({
      flow,
      body,
      receiverUser,
      fromCountry: requestedSourceCountry,
      toCountry: requestedTargetCountry || toCountry || "",
      currencySource: currencySourceISO,
      currencyTarget: currencyTargetISO,
    });

    currencySourceISO = corridorLock.lockedSourceCurrency;
    currencyTargetISO = corridorLock.lockedTargetCurrency;

    if (!currencySourceISO) {
      throw createError(400, "Devise source introuvable");
    }

    if (!currencyTargetISO) {
      throw createError(400, "Devise destination introuvable");
    }

    await validationService.detectBasicFraud({
      sender:
        body.phoneNumber ||
        body.fromPhone ||
        body.iban ||
        body.cardHolder ||
        body.accountHolder ||
        "external",
      receiverEmail: receiverUser.email,
      amount: amt,
      currency: currencySourceISO,
    });

    req.body.senderCurrencyCode = currencySourceISO;
    req.body.localCurrencyCode = currencyTargetISO;
    req.body.senderCurrencySymbol = currencySourceISO;
    req.body.localCurrencySymbol = currencyTargetISO;

    req.body.currencySource = currencySourceISO;
    req.body.currencyTarget = currencyTargetISO;
    req.body.fromCurrency = currencySourceISO;
    req.body.toCurrency = currencyTargetISO;

    req.body.fromCountry = corridorLock.lockedSourceCountry;
    req.body.toCountry = corridorLock.lockedTargetCountry;
    req.body.sourceCountry = corridorLock.lockedSourceCountry;
    req.body.targetCountry = corridorLock.lockedTargetCountry;
    req.body.destinationCountry = corridorLock.lockedTargetCountry;
    req.body.country = corridorLock.lockedTargetCountry;

    req.body.description = sanitize(description);

    const pricingCtx = await buildPricingContext({
      req,
      body,
      amount: amt,
      country: req.body.country,
      provider,
      currencySourceISO,
      currencyTargetISO,
    });

    const reference = sanitize(body.reference) || (await generateTransactionRef());
    const amlSnapshot = req.aml || null;
    const treasurySeed = resolveFeesTreasurySeed();
    const autoCancelFields = buildAutoCancelFields("processing");

    const txMeta = {
      ...((meta && typeof meta === "object") ? meta : {}),
      ...buildExternalMeta({
        receiverUser,
        body: req.body,
        extra: {
          entry: "external_collection.pending",
          requestOrigin: "tx-core",
          externalSource: externalSourceMeta,
          description: sanitize(description),
          corridorLock: corridorLock.snapshot,
          effectivePricingId:
            body.effectivePricingId ||
            body.pricingLockId ||
            body.pricingId ||
            body.quoteId ||
            null,
          autoCancelAt: autoCancelFields.autoCancelAt,
          autoCancelAfterDays: getAutoCancelAfterDays(),
        },
      }),
    };

    const txMetadata = {
      ...((metadata && typeof metadata === "object") ? metadata : {}),
      ...buildExternalMetadata({
        flow,
        provider,
        body: req.body,
        extra: {
          providerReference: pickExternalRef(body),
          externalSource: externalSourceMeta,
          corridorLock: corridorLock.snapshot,
          autoCancelAt: autoCancelFields.autoCancelAt,
          autoCancelAfterDays: getAutoCancelAfterDays(),
        },
      }),
      corridorLock: corridorLock.snapshot,
      autoCancelAt: autoCancelFields.autoCancelAt,
      autoCancelAfterDays: getAutoCancelAfterDays(),
    };

    const fundsValue =
      flow === INBOUND_EXTERNAL_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL
        ? "mobilemoney"
        : flow === INBOUND_EXTERNAL_FLOWS.BANK_TRANSFER_TO_PAYNOVAL
        ? "bank"
        : provider === "visa_direct"
        ? "visa_direct"
        : "stripe";

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
          funds: fundsValue,
          provider,
          operator:
            body.operator || body.operatorName || txMetadata?.provider || null,
          country: sanitize(corridorLock.lockedTargetCountry),

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
            source: {
              amount: pricingCtx.amountSourceStd,
              currency: currencySourceISO,
            },
            feeSource: {
              amount: pricingCtx.feeSourceStd,
              currency: currencySourceISO,
            },
            target: {
              amount: pricingCtx.amountTargetStd,
              currency: currencyTargetISO,
            },
            fxRateSourceToTarget: pricingCtx.rateUsed,
          },

          pricingSnapshot: normalizePricingSnapshot(pricingCtx.pricingSnapshot),
          pricingRuleApplied:
            pricingCtx.pricingSnapshot?.ruleApplied || null,
          pricingFxRuleApplied:
            pricingCtx.pricingSnapshot?.fxRuleApplied || null,

          feeSnapshot: {
            fee: pricingCtx.feeSourceStd,
            netAfterFees: pricingCtx.netFrom,
            convertedNetAfterFees: pricingCtx.amountTargetStd,
            exchangeRate: pricingCtx.rateUsed,
            pricingDebug: pricingCtx.pricingSnapshot?.debug || null,
          },
          feeActual: null,
          feeId: null,

          treasuryRevenue: pricingCtx.treasuryRevenue,
          treasuryRevenueCredited: false,
          treasuryRevenueCreditedAt: null,
          treasuryUserId: treasurySeed.treasuryUserId,
          treasurySystemType: treasurySeed.treasurySystemType,
          treasuryLabel: treasurySeed.treasuryLabel,

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

          ...autoCancelFields,

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
        corridorLock: corridorLock.snapshot,
        autoCancelAt: tx.autoCancelAt || null,
      },
      flagged: false,
      flagReason: "",
      transactionId: tx._id,
      ip: req.ip,
    }).catch(() => {});

    await notifyTransactionEvent(tx, "processing", session, currencyTargetISO);

    if (canUseSharedSession()) await session.commitTransaction();

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
      providerReference:
        execution?.providerReference || tx.providerReference || null,
      autoCancelAt: tx.autoCancelAt || null,
      autoCancelAfterDays: getAutoCancelAfterDays(),
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
      treasuryRevenue: pricingCtx.treasuryRevenue,
      externalSource: redactSensitiveFields(externalSourceMeta),
      corridorLock: corridorLock.snapshot,
      message: "Demande créée. En attente de confirmation provider.",
    });
  } catch (err) {
    logger.error("[TX-CORE][INBOUND] initiate failed", {
      message: err.message,
      code: err.code || null,
      details: err.details || null,
      status: err.status || err.statusCode || 500,
      flow: safeResolveFlow(req.body),
    });

    try {
      if (canUseSharedSession()) await session.abortTransaction();
    } catch {}

    session.endSession();
    next(err);
  }
}

module.exports = {
  initiateOutboundExternal,
  initiateInboundExternal,
};