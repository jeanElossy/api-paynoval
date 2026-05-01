// "use strict";

// const createError = require("http-errors");
// const runtime = require("../shared/runtime");

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
//   normalizeCurrency,
//   validateInternalPaynovalCorridor,
// } = require("./corridorValidation");

// const DEFAULT_FEES_TREASURY_SYSTEM_TYPE = "FEES_TREASURY";
// const DEFAULT_FEES_TREASURY_LABEL = "PayNoval Fees Treasury";
// const DEFAULT_AUTO_CANCEL_AFTER_DAYS = 7;

// const USER_CORRIDOR_SELECT = [
//   "_id",
//   "fullName",
//   "email",
//   "phone",

//   "country",
//   "countryCode",
//   "selectedCountry",
//   "residenceCountry",
//   "registrationCountry",
//   "nationality",

//   "currency",
//   "currencyCode",
//   "defaultCurrency",
//   "managedCurrency",

//   "userType",
//   "role",
//   "isBusiness",
//   "isSystem",
//   "systemType",

//   "accountStatus",
//   "status",
//   "staffStatus",

//   "isBlocked",
//   "isLoginDisabled",
//   "hiddenFromTransfers",
//   "hiddenFromUserSearch",
//   "hiddenFromUserApp",

//   "kycStatus",
//   "kybStatus",

//   "kyc",
//   "kyb",
//   "profile",
//   "address",
//   "wallet",

//   "isDeleted",
//   "deletedAt",
// ].join(" ");

// function norm(v) {
//   return String(v || "").trim().toLowerCase();
// }

// function upperSanitized(v) {
//   return sanitize(v || "").toUpperCase();
// }

// function isPlainObject(v) {
//   return !!v && typeof v === "object" && !Array.isArray(v);
// }

// function buildSafeMeta(...parts) {
//   return Object.assign({}, ...parts.map((p) => (isPlainObject(p) ? p : {})));
// }

// function normalizeStatus(status) {
//   return String(status || "")
//     .trim()
//     .replace(/\s+/g, "_")
//     .toLowerCase();
// }

// function getAutoCancelAfterDays() {
//   const raw = Number(
//     process.env.TX_AUTO_CANCEL_AFTER_DAYS || DEFAULT_AUTO_CANCEL_AFTER_DAYS
//   );

//   if (!Number.isFinite(raw) || raw <= 0) {
//     return DEFAULT_AUTO_CANCEL_AFTER_DAYS;
//   }

//   return Math.max(1, Math.floor(raw));
// }

// function buildAutoCancelAt(fromDate = new Date()) {
//   const base = fromDate instanceof Date ? fromDate : new Date();
//   const days = getAutoCancelAfterDays();

//   return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
// }

// function isAutoCancellableStatus(status) {
//   const s = normalizeStatus(status);

//   return [
//     "pending",
//     "pendingvalidation",
//     "pending_validation",
//     "initiated",
//     "awaiting_validation",
//     "awaiting_confirmation",
//     "processing",
//   ].includes(s);
// }

// function buildAutoCancelFields(status = "pending") {
//   if (!isAutoCancellableStatus(status)) {
//     return {
//       autoCancelAt: null,
//       autoCancelledAt: null,
//       autoCancelReason: "",
//       autoCancelLockAt: null,
//       autoCancelWorkerId: "",
//       lastAutoCancelError: "",
//     };
//   }

//   return {
//     autoCancelAt: buildAutoCancelAt(),
//     autoCancelledAt: null,
//     autoCancelReason: "",
//     autoCancelLockAt: null,
//     autoCancelWorkerId: "",
//     lastAutoCancelError: "",
//   };
// }

// function safeLog(level, message, meta = {}) {
//   try {
//     const payload = isPlainObject(meta) ? meta : {};
//     const logger = runtime.logger;

//     if (logger && typeof logger[level] === "function") {
//       logger[level](message, payload);
//       return;
//     }

//     const line = `${message} ${JSON.stringify(payload)}`;

//     if (level === "error") return console.error(line);
//     if (level === "warn") return console.warn(line);

//     console.log(line);
//   } catch {
//     console.log(message);
//   }
// }

// function safeSessionChain(query, session) {
//   return session ? query.session(session) : query;
// }

// async function abortQuietly(session) {
//   try {
//     if (session && runtime.canUseSharedSession()) {
//       await session.abortTransaction();
//     }
//   } catch {}
// }

// async function endQuietly(session) {
//   try {
//     if (session) session.endSession();
//   } catch {}
// }

// function maskSecret(v) {
//   return v ? "***" : undefined;
// }

// function resolveCountryForSource(body = {}) {
//   return body.fromCountry || body.sourceCountry || "";
// }

// function resolveCountryForTarget(body = {}) {
//   return (
//     body.toCountry ||
//     body.destinationCountry ||
//     body.targetCountry ||
//     body.country ||
//     ""
//   );
// }

// function getEffectivePricingId(body = {}) {
//   return String(
//     body.effectivePricingId ||
//       body.pricingId ||
//       body.quoteId ||
//       body.meta?.effectivePricingId ||
//       body.meta?.pricingId ||
//       body.meta?.quoteId ||
//       ""
//   ).trim();
// }

// function buildDebugBody(body = {}) {
//   return {
//     toEmail: body?.toEmail,
//     amount: body?.amount,
//     amountSource: body?.amountSource,
//     amountTarget: body?.amountTarget,
//     feeSource: body?.feeSource,
//     exchangeRate: body?.exchangeRate,
//     fxRateSourceToTarget: body?.fxRateSourceToTarget,
//     destination: body?.destination,
//     funds: body?.funds,
//     provider: body?.provider,
//     method: body?.method,
//     txType: body?.txType,
//     country: body?.country,
//     fromCountry: body?.fromCountry,
//     toCountry: body?.toCountry,
//     sourceCountry: body?.sourceCountry,
//     destinationCountry: body?.destinationCountry,
//     currency: body?.currency,
//     currencySource: body?.currencySource,
//     currencyTarget: body?.currencyTarget,
//     senderCurrencyCode: body?.senderCurrencyCode,
//     localCurrencyCode: body?.localCurrencyCode,
//     pricingId: body?.pricingId,
//     quoteId: body?.quoteId,
//     effectivePricingId: body?.effectivePricingId,
//     securityQuestion: body?.securityQuestion || body?.question,
//     securityAnswer: maskSecret(body?.securityAnswer || body?.securityCode),
//     recipientInfo: body?.recipientInfo,
//     meta: body?.meta,
//     metadata: body?.metadata,
//   };
// }

// function resolveFeesTreasurySeed() {
//   const treasurySystemType = String(
//     runtime.normalizeTreasurySystemType
//       ? runtime.normalizeTreasurySystemType(DEFAULT_FEES_TREASURY_SYSTEM_TYPE)
//       : DEFAULT_FEES_TREASURY_SYSTEM_TYPE
//   )
//     .trim()
//     .toUpperCase();

//   return {
//     treasuryUserId: null,
//     treasurySystemType,
//     treasuryLabel: DEFAULT_FEES_TREASURY_LABEL,
//   };
// }

// async function initiateInternal(req, res, next) {
//   const session = await runtime.startTxSession();

//   try {
//     const User = runtime.User;
//     const Transaction = runtime.Transaction;
//     const validationService = runtime.validationService;
//     const logTransaction = runtime.logTransaction;
//     const normCur = runtime.normCur;
//     const generateTransactionRef = runtime.generateTransactionRef;
//     const reserveSenderFunds = runtime.reserveSenderFunds;
//     const normalizePricingSnapshot = runtime.normalizePricingSnapshot;

//     if (!User) throw createError(500, "User model indisponible");
//     if (!Transaction) throw createError(500, "Transaction model indisponible");

//     if (runtime.canUseSharedSession()) {
//       session.startTransaction();
//     }

//     const body = isPlainObject(req.body) ? req.body : {};

//     safeLog("info", "[TX INTERNAL] raw-body", {
//       body: buildDebugBody(body),
//       userId: req.user?.id || req.user?._id || null,
//       ip: req.ip || null,
//     });

//     const {
//       toEmail,
//       amount,
//       recipientInfo = {},
//       description = "",
//       securityQuestion,
//       securityAnswer,
//       question,
//       securityCode,
//       destination,
//       funds,
//       metadata = {},
//       meta = {},
//     } = body;

//     const fundsNorm = norm(funds);
//     const destinationNorm = norm(destination);
//     const providerNorm = norm(body.provider);
//     const methodNorm = norm(body.method);

//     const isInternalFlow =
//       fundsNorm === "paynoval" &&
//       destinationNorm === "paynoval" &&
//       (!providerNorm || providerNorm === "paynoval") &&
//       (!methodNorm || methodNorm === "paynoval" || methodNorm === "internal");

//     if (!isInternalFlow) {
//       throw createError(
//         400,
//         "initiateInternal ne supporte que le flow PayNoval vers PayNoval"
//       );
//     }

//     const authHeader = String(req.headers?.authorization || "").trim();

//     if (!authHeader || !authHeader.startsWith("Bearer ")) {
//       throw createError(401, "Token manquant");
//     }

//     const senderId = String(req.user?.id || req.user?._id || "").trim();

//     if (!senderId) {
//       throw createError(401, "Utilisateur non authentifié");
//     }

//     const cleanEmail = String(toEmail || recipientInfo?.email || "")
//       .trim()
//       .toLowerCase();

//     if (!cleanEmail || !isEmailLike(cleanEmail)) {
//       throw createError(400, "Email du destinataire requis");
//     }

//     const q = sanitize(securityQuestion || question || "");
//     const aRaw = sanitize(securityAnswer || securityCode || "");

//     if (!q || !aRaw) {
//       throw createError(400, "securityQuestion + securityAnswer requis");
//     }

//     if (description && String(description).length > MAX_DESC_LENGTH) {
//       throw createError(400, "Description trop longue");
//     }

//     const amt = toFloat(amount ?? body.amountSource);

//     if (!Number.isFinite(amt) || amt <= 0) {
//       throw createError(400, "Montant invalide");
//     }

//     await validationService.validateTransactionAmount({ amount: amt });

//     await validationService.detectBasicFraud({
//       sender: senderId,
//       receiverEmail: cleanEmail,
//       amount: amt,
//       currency:
//         body.senderCurrencyCode ||
//         body.currencySource ||
//         body.senderCurrencySymbol ||
//         body.fromCurrency ||
//         body.currency ||
//         null,
//     });

//     const sessOpts = runtime.maybeSessionOpts(session);
//     const activeSession = sessOpts?.session || null;

//     let senderQuery = User.findById(senderId).select(USER_CORRIDOR_SELECT);

//     let receiverQuery = User.findOne({
//       email: cleanEmail,
//       isDeleted: { $ne: true },
//     }).select(USER_CORRIDOR_SELECT);

//     senderQuery = safeSessionChain(senderQuery, activeSession).lean();
//     receiverQuery = safeSessionChain(receiverQuery, activeSession).lean();

//     const [senderUser, receiver] = await Promise.all([
//       senderQuery,
//       receiverQuery,
//     ]);

//     if (!senderUser) {
//       throw createError(403, "Utilisateur invalide");
//     }

//     if (!receiver) {
//       throw createError(404, "Destinataire introuvable");
//     }

//     if (String(receiver._id) === senderId) {
//       throw createError(400, "Auto-transfert impossible");
//     }

//     const sourceCountryRaw = resolveCountryForSource(body);
//     const targetCountryRaw = resolveCountryForTarget(body);

//     let currencySourceISO =
//       normCur(
//         body.senderCurrencyCode ||
//           body.currencySource ||
//           body.fromCurrency ||
//           body.senderCurrencySymbol ||
//           body.currency,
//         sourceCountryRaw
//       ) ||
//       upperSanitized(
//         body.senderCurrencyCode ||
//           body.currencySource ||
//           body.fromCurrency ||
//           body.senderCurrencySymbol ||
//           body.currency
//       );

//     let currencyTargetISO =
//       normCur(
//         body.localCurrencyCode ||
//           body.currencyTarget ||
//           body.toCurrency ||
//           body.localCurrencySymbol,
//         targetCountryRaw
//       ) ||
//       upperSanitized(
//         body.localCurrencyCode ||
//           body.currencyTarget ||
//           body.toCurrency ||
//           body.localCurrencySymbol
//       );

//     currencySourceISO = normalizeCurrency(currencySourceISO);
//     currencyTargetISO = normalizeCurrency(currencyTargetISO);

//     const corridorLock = validateInternalPaynovalCorridor({
//       sender: senderUser,
//       receiver,
//       sourceCountry: sourceCountryRaw,
//       targetCountry: targetCountryRaw,
//       currencySource: currencySourceISO,
//       currencyTarget: currencyTargetISO,
//     });

//     currencySourceISO = corridorLock.currencySource;
//     currencyTargetISO = corridorLock.currencyTarget;

//     const lockedSourceCountry = corridorLock.sourceCountry;
//     const lockedTargetCountry = corridorLock.targetCountry;

//     if (!currencySourceISO) {
//       throw createError(400, "Devise source introuvable");
//     }

//     if (!currencyTargetISO) {
//       throw createError(400, "Devise destination introuvable");
//     }

//     req.body.senderCurrencyCode = currencySourceISO;
//     req.body.localCurrencyCode = currencyTargetISO;
//     req.body.senderCurrencySymbol = currencySourceISO;
//     req.body.localCurrencySymbol = currencyTargetISO;

//     req.body.currencySource = currencySourceISO;
//     req.body.currencyTarget = currencyTargetISO;
//     req.body.fromCurrency = currencySourceISO;
//     req.body.toCurrency = currencyTargetISO;

//     req.body.fromCountry = lockedSourceCountry;
//     req.body.sourceCountry = lockedSourceCountry;
//     req.body.toCountry = lockedTargetCountry;
//     req.body.destinationCountry = lockedTargetCountry;
//     req.body.targetCountry = lockedTargetCountry;
//     req.body.country = lockedTargetCountry;

//     req.body.funds = "paynoval";
//     req.body.destination = "paynoval";
//     req.body.provider = "paynoval";
//     req.body.method = "INTERNAL";

//     const effectivePricingId = getEffectivePricingId(body);

//     const pricingInput = pickBodyPricingInput({
//       ...body,
//       ...req.body,
//       amount: amt,
//       funds: "paynoval",
//       destination: "paynoval",
//       provider: "paynoval",
//       method: "INTERNAL",
//       txType: body.txType || "TRANSFER",
//       fromCurrency: currencySourceISO,
//       toCurrency: currencyTargetISO,
//       fromCountry: lockedSourceCountry,
//       toCountry: lockedTargetCountry,
//       pricingId: body.pricingId || undefined,
//       quoteId: body.quoteId || undefined,
//       effectivePricingId: effectivePricingId || undefined,
//     });

//     let pricingPayload;

//     try {
//       pricingPayload = await fetchPricingQuoteFromGateway({
//         authHeader,
//         pricingInput,
//       });
//     } catch (e) {
//       safeLog("error", "[TX INTERNAL] pricing quote gateway error", {
//         senderId,
//         toEmail: cleanEmail,
//         pricingInput,
//         status: e?.response?.status || null,
//         responseData: e?.response?.data || null,
//         message: e?.message || "unknown_error",
//       });

//       throw createError(502, "Service pricing indisponible");
//     }

//     const {
//       pricingSnapshot,
//       grossFrom,
//       fee,
//       netFrom,
//       netTo,
//       treasuryRevenue,
//     } = extractPricingBundle(pricingPayload, pricingInput);

//     if (!Number.isFinite(grossFrom) || grossFrom <= 0) {
//       throw createError(500, "grossFrom pricing invalide");
//     }

//     if (!Number.isFinite(fee) || fee < 0) {
//       throw createError(500, "fee pricing invalide");
//     }

//     if (!Number.isFinite(netFrom) || netFrom < 0) {
//       throw createError(500, "netFrom pricing invalide");
//     }

//     if (!Number.isFinite(netTo) || netTo <= 0) {
//       throw createError(500, "netTo pricing invalide");
//     }

//     const amountSourceStd = round2(grossFrom);
//     const feeSourceStd = round2(fee);
//     const netFromStd = round2(netFrom);
//     const amountTargetStd = round2(netTo);
//     const rateUsed = Number(pricingSnapshot?.result?.appliedRate || 1);

//     if (!Number.isFinite(rateUsed) || rateUsed <= 0) {
//       throw createError(500, "Taux appliqué invalide");
//     }

//     const reference = await generateTransactionRef();
//     const securityAnswerHash = sha256Hex(aRaw);
//     const amlSnapshot = req.aml || null;
//     const treasurySeed = resolveFeesTreasurySeed();

//     const safeRecipientInfo = isPlainObject(recipientInfo) ? recipientInfo : {};

//     const recipientName =
//       sanitize(
//         safeRecipientInfo.name ||
//           safeRecipientInfo.accountHolderName ||
//           safeRecipientInfo.holder ||
//           ""
//       ) ||
//       receiver.fullName ||
//       cleanEmail;

//     const autoCancelFields = buildAutoCancelFields("pending");

//     const txMeta = buildSafeMeta(meta, metadata, {
//       entry: "transfer.pending",
//       ownerUserId: senderUser._id,
//       receiverUserId: receiver._id,
//       requestOrigin: "tx-core",
//       flowIsolation: "internal_only",
//       pricingId: body?.pricingId || null,
//       quoteId: body?.quoteId || null,
//       effectivePricingId: effectivePricingId || null,
//       corridorLock: corridorLock.snapshot,
//       autoCancelAt: autoCancelFields.autoCancelAt,
//       autoCancelAfterDays: getAutoCancelAfterDays(),
//     });

//     const txMetadata = {
//       provider: "paynoval",
//       method: "INTERNAL",
//       txType: body.txType || "TRANSFER",
//       rail: "internal",
//       corridorLock: corridorLock.snapshot,
//       autoCancelAt: autoCancelFields.autoCancelAt,
//       autoCancelAfterDays: getAutoCancelAfterDays(),
//     };

//     const txDoc = {
//       userId: senderUser._id,
//       internalImported: false,

//       flow: "PAYNOVAL_INTERNAL_TRANSFER",
//       operationKind: "transfer",
//       initiatedBy: "user",
//       context: "paynoval_internal_transfer",
//       contextId: null,

//       reference,
//       idempotencyKey:
//         typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
//           ? body.idempotencyKey.trim()
//           : undefined,

//       sender: senderUser._id,
//       receiver: receiver._id,

//       senderName: senderUser.fullName,
//       senderEmail: senderUser.email,
//       nameDestinataire: recipientName,
//       recipientEmail: cleanEmail,

//       destination: "paynoval",
//       funds: "paynoval",
//       provider: "paynoval",
//       operator: body.operator || null,
//       country: sanitize(lockedTargetCountry),

//       amount: dec2(amountSourceStd),
//       transactionFees: dec2(feeSourceStd),
//       netAmount: dec2(netFromStd),
//       exchangeRate: dec2(rateUsed),
//       localAmount: dec2(amountTargetStd),

//       senderCurrencySymbol: currencySourceISO,
//       localCurrencySymbol: currencyTargetISO,

//       amountSource: dec2(amountSourceStd),
//       amountTarget: dec2(amountTargetStd),
//       feeSource: dec2(feeSourceStd),
//       fxRateSourceToTarget: dec2(rateUsed),
//       currencySource: currencySourceISO,
//       currencyTarget: currencyTargetISO,

//       money: {
//         source: { amount: amountSourceStd, currency: currencySourceISO },
//         feeSource: { amount: feeSourceStd, currency: currencySourceISO },
//         target: { amount: amountTargetStd, currency: currencyTargetISO },
//         fxRateSourceToTarget: rateUsed,
//       },

//       pricingSnapshot: normalizePricingSnapshot(pricingSnapshot),
//       pricingRuleApplied: pricingSnapshot?.ruleApplied || null,
//       pricingFxRuleApplied: pricingSnapshot?.fxRuleApplied || null,

//       feeSnapshot: {
//         fee: feeSourceStd,
//         netAfterFees: netFromStd,
//         convertedNetAfterFees: amountTargetStd,
//         exchangeRate: rateUsed,
//         pricingDebug: pricingSnapshot?.debug || null,
//       },
//       feeActual: null,
//       feeId: null,

//       treasuryRevenue,
//       treasuryRevenueCredited: false,
//       treasuryRevenueCreditedAt: null,
//       treasuryUserId: treasurySeed.treasuryUserId,
//       treasurySystemType: treasurySeed.treasurySystemType,
//       treasuryLabel: treasurySeed.treasuryLabel,

//       securityQuestion: q,
//       securityAnswerHash,
//       securityCode: securityAnswerHash,

//       amlSnapshot,
//       amlStatus: amlSnapshot?.status || "passed",

//       description: sanitize(description),
//       orderId: body.orderId || null,

//       metadata: txMetadata,
//       meta: txMeta,

//       status: "pending",
//       providerStatus: "FUNDS_RESERVED_PENDING_CONFIRMATION",

//       ...autoCancelFields,

//       fundsReserved: false,
//       fundsReservedAt: null,
//       fundsCaptured: false,
//       fundsCapturedAt: null,
//       beneficiaryCredited: false,
//       beneficiaryCreditedAt: null,
//       reserveReleased: false,
//       reserveReleasedAt: null,
//       reversedAt: null,
//       executedAt: null,

//       attemptCount: 0,
//       lastAttemptAt: null,
//       lockedUntil: null,
//     };

//     const [tx] = await Transaction.create([txDoc], sessOpts);

//     await reserveSenderFunds({
//       transaction: tx,
//       senderId: senderUser._id,
//       amount: amountSourceStd,
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
//       provider: "paynoval",
//       amount: amountSourceStd,
//       currency: currencySourceISO,
//       toEmail: cleanEmail,
//       details: {
//         transactionId: String(tx._id),
//         reference: tx.reference,
//         flow: tx.flow,
//         corridorLock: corridorLock.snapshot,
//         autoCancelAt: tx.autoCancelAt || null,
//       },
//       flagged: false,
//       flagReason: "",
//       transactionId: tx._id,
//       ip: req.ip,
//     }).catch(() => {});

//     await notifyTransactionEvent(tx, "initiated", session, currencySourceISO);

//     if (runtime.canUseSharedSession()) {
//       await session.commitTransaction();
//     }

//     await endQuietly(session);

//     return res.status(201).json({
//       success: true,
//       transactionId: String(tx._id),
//       reference: tx.reference,
//       flow: tx.flow,
//       status: tx.status,
//       providerStatus: tx.providerStatus,
//       securityQuestion: q,
//       autoCancelAt: tx.autoCancelAt || null,
//       autoCancelAfterDays: getAutoCancelAfterDays(),
//       pricing: {
//         feeSource: feeSourceStd,
//         feeSourceCurrency: currencySourceISO,
//         netFrom: netFromStd,
//         netTo: amountTargetStd,
//         targetCurrency: currencyTargetISO,
//         marketRate: pricingSnapshot?.result?.marketRate ?? null,
//         appliedRate: pricingSnapshot?.result?.appliedRate ?? null,
//         feeRevenue: pricingSnapshot?.result?.feeRevenue ?? null,
//         fxRevenue: pricingSnapshot?.result?.fxRevenue ?? null,
//       },
//       treasuryRevenue,
//       fundsReserved: true,
//       treasuryCreditedAtInitiate: false,
//       corridorLock: corridorLock.snapshot,
//     });
//   } catch (err) {
//     safeLog("error", "[TX INTERNAL] failed", {
//       message: err?.message,
//       code: err?.code || null,
//       details: err?.details || null,
//       status: err?.status || err?.statusCode || 500,
//       stack: err?.stack,
//       body: buildDebugBody(req.body || {}),
//       userId: req.user?.id || req.user?._id || null,
//       ip: req.ip || null,
//     });

//     await abortQuietly(session);
//     await endQuietly(session);
//     next(err);
//   }
// }

// module.exports = { initiateInternal };







"use strict";

const createError = require("http-errors");
const runtime = require("../shared/runtime");

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
  normalizeCurrency,
  validateInternalPaynovalCorridor,
} = require("./corridorValidation");

const {
  assertUserCanTransact,
  buildEligibilitySnapshot,
  mergeEligibilityMetadata,
} = require("../shared/transactionEligibility");

const DEFAULT_FEES_TREASURY_SYSTEM_TYPE = "FEES_TREASURY";
const DEFAULT_FEES_TREASURY_LABEL = "PayNoval Fees Treasury";
const DEFAULT_AUTO_CANCEL_AFTER_DAYS = 7;

const USER_CORRIDOR_SELECT = [
  "_id",
  "fullName",
  "email",
  "phone",
  "phoneNumber",

  "emailVerified",
  "isEmailVerified",
  "emailVerifiedAt",
  "emailVerification",
  "verifications",

  "phoneVerified",
  "isPhoneVerified",
  "phoneVerifiedAt",
  "phoneVerification",

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
  "type",
  "accountType",
  "role",
  "isBusiness",
  "isSystem",
  "systemType",

  "accountStatus",
  "status",
  "staffStatus",

  "isBlocked",
  "blocked",
  "isLoginDisabled",
  "hiddenFromTransfers",
  "hiddenFromUserSearch",
  "hiddenFromUserApp",
  "frozenUntil",

  "kycStatus",
  "kycLevel",
  "kybStatus",
  "businessStatus",
  "businessKYBLevel",

  "kyc",
  "kyb",
  "business",
  "profile",
  "address",
  "wallet",

  "kycVerified",
  "isKycVerified",
  "kybVerified",
  "isKybVerified",

  "isDeleted",
  "deletedAt",
].join(" ");

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function upperSanitized(v) {
  return sanitize(v || "").toUpperCase();
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function buildSafeMeta(...parts) {
  return Object.assign({}, ...parts.map((p) => (isPlainObject(p) ? p : {})));
}

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

function safeLog(level, message, meta = {}) {
  try {
    const payload = isPlainObject(meta) ? meta : {};
    const logger = runtime.logger;

    if (logger && typeof logger[level] === "function") {
      logger[level](message, payload);
      return;
    }

    const line = `${message} ${JSON.stringify(payload)}`;

    if (level === "error") return console.error(line);
    if (level === "warn") return console.warn(line);

    console.log(line);
  } catch {
    console.log(message);
  }
}

function safeSessionChain(query, session) {
  return session ? query.session(session) : query;
}

async function abortQuietly(session) {
  try {
    if (session && runtime.canUseSharedSession()) {
      await session.abortTransaction();
    }
  } catch {}
}

async function endQuietly(session) {
  try {
    if (session) session.endSession();
  } catch {}
}

function maskSecret(v) {
  return v ? "***" : undefined;
}

function resolveCountryForSource(body = {}) {
  return body.fromCountry || body.sourceCountry || "";
}

function resolveCountryForTarget(body = {}) {
  return (
    body.toCountry ||
    body.destinationCountry ||
    body.targetCountry ||
    body.country ||
    ""
  );
}

function getEffectivePricingId(body = {}) {
  return String(
    body.effectivePricingId ||
      body.pricingId ||
      body.quoteId ||
      body.meta?.effectivePricingId ||
      body.meta?.pricingId ||
      body.meta?.quoteId ||
      ""
  ).trim();
}

function buildDebugBody(body = {}) {
  return {
    toEmail: body?.toEmail,
    amount: body?.amount,
    amountSource: body?.amountSource,
    amountTarget: body?.amountTarget,
    feeSource: body?.feeSource,
    exchangeRate: body?.exchangeRate,
    fxRateSourceToTarget: body?.fxRateSourceToTarget,
    destination: body?.destination,
    funds: body?.funds,
    provider: body?.provider,
    method: body?.method,
    txType: body?.txType,
    country: body?.country,
    fromCountry: body?.fromCountry,
    toCountry: body?.toCountry,
    sourceCountry: body?.sourceCountry,
    destinationCountry: body?.destinationCountry,
    currency: body?.currency,
    currencySource: body?.currencySource,
    currencyTarget: body?.currencyTarget,
    senderCurrencyCode: body?.senderCurrencyCode,
    localCurrencyCode: body?.localCurrencyCode,
    pricingId: body?.pricingId,
    quoteId: body?.quoteId,
    effectivePricingId: body?.effectivePricingId,
    securityQuestion: body?.securityQuestion || body?.question,
    securityAnswer: maskSecret(body?.securityAnswer || body?.securityCode),
    recipientInfo: body?.recipientInfo,
    meta: body?.meta,
    metadata: body?.metadata,
  };
}

function resolveFeesTreasurySeed() {
  const treasurySystemType = String(
    runtime.normalizeTreasurySystemType
      ? runtime.normalizeTreasurySystemType(DEFAULT_FEES_TREASURY_SYSTEM_TYPE)
      : DEFAULT_FEES_TREASURY_SYSTEM_TYPE
  )
    .trim()
    .toUpperCase();

  return {
    treasuryUserId: null,
    treasurySystemType,
    treasuryLabel: DEFAULT_FEES_TREASURY_LABEL,
  };
}

async function initiateInternal(req, res, next) {
  const session = await runtime.startTxSession();

  try {
    const User = runtime.User;
    const Transaction = runtime.Transaction;
    const validationService = runtime.validationService;
    const logTransaction = runtime.logTransaction;
    const normCur = runtime.normCur;
    const generateTransactionRef = runtime.generateTransactionRef;
    const reserveSenderFunds = runtime.reserveSenderFunds;
    const normalizePricingSnapshot = runtime.normalizePricingSnapshot;

    if (!User) throw createError(500, "User model indisponible");
    if (!Transaction) throw createError(500, "Transaction model indisponible");

    if (runtime.canUseSharedSession()) {
      session.startTransaction();
    }

    const body = isPlainObject(req.body) ? req.body : {};

    safeLog("info", "[TX INTERNAL] raw-body", {
      body: buildDebugBody(body),
      userId: req.user?.id || req.user?._id || null,
      ip: req.ip || null,
    });

    const {
      toEmail,
      amount,
      recipientInfo = {},
      description = "",
      securityQuestion,
      securityAnswer,
      question,
      securityCode,
      destination,
      funds,
      metadata = {},
      meta = {},
    } = body;

    const fundsNorm = norm(funds);
    const destinationNorm = norm(destination);
    const providerNorm = norm(body.provider);
    const methodNorm = norm(body.method);

    const isInternalFlow =
      fundsNorm === "paynoval" &&
      destinationNorm === "paynoval" &&
      (!providerNorm || providerNorm === "paynoval") &&
      (!methodNorm || methodNorm === "paynoval" || methodNorm === "internal");

    if (!isInternalFlow) {
      throw createError(
        400,
        "initiateInternal ne supporte que le flow PayNoval vers PayNoval"
      );
    }

    const authHeader = String(req.headers?.authorization || "").trim();

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw createError(401, "Token manquant");
    }

    const senderId = String(req.user?.id || req.user?._id || "").trim();

    if (!senderId) {
      throw createError(401, "Utilisateur non authentifié");
    }

    const cleanEmail = String(toEmail || recipientInfo?.email || "")
      .trim()
      .toLowerCase();

    if (!cleanEmail || !isEmailLike(cleanEmail)) {
      throw createError(400, "Email du destinataire requis");
    }

    const q = sanitize(securityQuestion || question || "");
    const aRaw = sanitize(securityAnswer || securityCode || "");

    if (!q || !aRaw) {
      throw createError(400, "securityQuestion + securityAnswer requis");
    }

    if (description && String(description).length > MAX_DESC_LENGTH) {
      throw createError(400, "Description trop longue");
    }

    const amt = toFloat(amount ?? body.amountSource);

    if (!Number.isFinite(amt) || amt <= 0) {
      throw createError(400, "Montant invalide");
    }

    await validationService.validateTransactionAmount({ amount: amt });

    await validationService.detectBasicFraud({
      sender: senderId,
      receiverEmail: cleanEmail,
      amount: amt,
      currency:
        body.senderCurrencyCode ||
        body.currencySource ||
        body.senderCurrencySymbol ||
        body.fromCurrency ||
        body.currency ||
        null,
    });

    const sessOpts = runtime.maybeSessionOpts(session);
    const activeSession = sessOpts?.session || null;

    let senderQuery = User.findById(senderId).select(USER_CORRIDOR_SELECT);

    let receiverQuery = User.findOne({
      email: cleanEmail,
      isDeleted: { $ne: true },
    }).select(USER_CORRIDOR_SELECT);

    senderQuery = safeSessionChain(senderQuery, activeSession).lean();
    receiverQuery = safeSessionChain(receiverQuery, activeSession).lean();

    const [senderUser, receiver] = await Promise.all([
      senderQuery,
      receiverQuery,
    ]);

    if (!senderUser) {
      throw createError(403, "Utilisateur invalide");
    }

    if (!receiver) {
      throw createError(404, "Destinataire introuvable");
    }

    if (String(receiver._id) === senderId) {
      throw createError(400, "Auto-transfert impossible");
    }

    const senderEligibility = assertUserCanTransact(senderUser, {
      roleLabel: "expéditeur",
      codePrefix: "SENDER",
    });

    const receiverEligibility = assertUserCanTransact(receiver, {
      roleLabel: "destinataire",
      codePrefix: "RECEIVER",
    });

    const eligibilitySnapshot = {
      requester:
        req.transactionEligibility?.user ||
        senderEligibility.snapshot ||
        buildEligibilitySnapshot(senderUser),
      sender: senderEligibility.snapshot || buildEligibilitySnapshot(senderUser),
      receiver:
        receiverEligibility.snapshot || buildEligibilitySnapshot(receiver),
    };

    const sourceCountryRaw = resolveCountryForSource(body);
    const targetCountryRaw = resolveCountryForTarget(body);

    let currencySourceISO =
      normCur(
        body.senderCurrencyCode ||
          body.currencySource ||
          body.fromCurrency ||
          body.senderCurrencySymbol ||
          body.currency,
        sourceCountryRaw
      ) ||
      upperSanitized(
        body.senderCurrencyCode ||
          body.currencySource ||
          body.fromCurrency ||
          body.senderCurrencySymbol ||
          body.currency
      );

    let currencyTargetISO =
      normCur(
        body.localCurrencyCode ||
          body.currencyTarget ||
          body.toCurrency ||
          body.localCurrencySymbol,
        targetCountryRaw
      ) ||
      upperSanitized(
        body.localCurrencyCode ||
          body.currencyTarget ||
          body.toCurrency ||
          body.localCurrencySymbol
      );

    currencySourceISO = normalizeCurrency(currencySourceISO);
    currencyTargetISO = normalizeCurrency(currencyTargetISO);

    const corridorLock = validateInternalPaynovalCorridor({
      sender: senderUser,
      receiver,
      sourceCountry: sourceCountryRaw,
      targetCountry: targetCountryRaw,
      currencySource: currencySourceISO,
      currencyTarget: currencyTargetISO,
    });

    currencySourceISO = corridorLock.currencySource;
    currencyTargetISO = corridorLock.currencyTarget;

    const lockedSourceCountry = corridorLock.sourceCountry;
    const lockedTargetCountry = corridorLock.targetCountry;

    if (!currencySourceISO) {
      throw createError(400, "Devise source introuvable");
    }

    if (!currencyTargetISO) {
      throw createError(400, "Devise destination introuvable");
    }

    req.body.senderCurrencyCode = currencySourceISO;
    req.body.localCurrencyCode = currencyTargetISO;
    req.body.senderCurrencySymbol = currencySourceISO;
    req.body.localCurrencySymbol = currencyTargetISO;

    req.body.currencySource = currencySourceISO;
    req.body.currencyTarget = currencyTargetISO;
    req.body.fromCurrency = currencySourceISO;
    req.body.toCurrency = currencyTargetISO;

    req.body.fromCountry = lockedSourceCountry;
    req.body.sourceCountry = lockedSourceCountry;
    req.body.toCountry = lockedTargetCountry;
    req.body.destinationCountry = lockedTargetCountry;
    req.body.targetCountry = lockedTargetCountry;
    req.body.country = lockedTargetCountry;

    req.body.funds = "paynoval";
    req.body.destination = "paynoval";
    req.body.provider = "paynoval";
    req.body.method = "INTERNAL";

    const effectivePricingId = getEffectivePricingId(body);

    const pricingInput = pickBodyPricingInput({
      ...body,
      ...req.body,
      amount: amt,
      funds: "paynoval",
      destination: "paynoval",
      provider: "paynoval",
      method: "INTERNAL",
      txType: body.txType || "TRANSFER",
      fromCurrency: currencySourceISO,
      toCurrency: currencyTargetISO,
      fromCountry: lockedSourceCountry,
      toCountry: lockedTargetCountry,
      pricingId: body.pricingId || undefined,
      quoteId: body.quoteId || undefined,
      effectivePricingId: effectivePricingId || undefined,
    });

    let pricingPayload;

    try {
      pricingPayload = await fetchPricingQuoteFromGateway({
        authHeader,
        pricingInput,
      });
    } catch (e) {
      safeLog("error", "[TX INTERNAL] pricing quote gateway error", {
        senderId,
        toEmail: cleanEmail,
        pricingInput,
        status: e?.response?.status || null,
        responseData: e?.response?.data || null,
        message: e?.message || "unknown_error",
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
    const netFromStd = round2(netFrom);
    const amountTargetStd = round2(netTo);
    const rateUsed = Number(pricingSnapshot?.result?.appliedRate || 1);

    if (!Number.isFinite(rateUsed) || rateUsed <= 0) {
      throw createError(500, "Taux appliqué invalide");
    }

    const reference = await generateTransactionRef();
    const securityAnswerHash = sha256Hex(aRaw);
    const amlSnapshot = req.aml || null;
    const treasurySeed = resolveFeesTreasurySeed();

    const safeRecipientInfo = isPlainObject(recipientInfo) ? recipientInfo : {};

    const recipientName =
      sanitize(
        safeRecipientInfo.name ||
          safeRecipientInfo.accountHolderName ||
          safeRecipientInfo.holder ||
          ""
      ) ||
      receiver.fullName ||
      cleanEmail;

    const autoCancelFields = buildAutoCancelFields("pending");

    const txMetaBase = buildSafeMeta(meta, metadata, {
      entry: "transfer.pending",
      ownerUserId: senderUser._id,
      receiverUserId: receiver._id,
      requestOrigin: "tx-core",
      flowIsolation: "internal_only",
      pricingId: body?.pricingId || null,
      quoteId: body?.quoteId || null,
      effectivePricingId: effectivePricingId || null,
      corridorLock: corridorLock.snapshot,
      autoCancelAt: autoCancelFields.autoCancelAt,
      autoCancelAfterDays: getAutoCancelAfterDays(),
    });

    const txMeta = mergeEligibilityMetadata(txMetaBase, eligibilitySnapshot);

    const txMetadataBase = buildSafeMeta(metadata, {
      provider: "paynoval",
      method: "INTERNAL",
      txType: body.txType || "TRANSFER",
      rail: "internal",
      corridorLock: corridorLock.snapshot,
      autoCancelAt: autoCancelFields.autoCancelAt,
      autoCancelAfterDays: getAutoCancelAfterDays(),
    });

    const txMetadata = mergeEligibilityMetadata(
      txMetadataBase,
      eligibilitySnapshot
    );

    const txDoc = {
      userId: senderUser._id,
      internalImported: false,

      flow: "PAYNOVAL_INTERNAL_TRANSFER",
      operationKind: "transfer",
      initiatedBy: "user",
      context: "paynoval_internal_transfer",
      contextId: null,

      reference,
      idempotencyKey:
        typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
          ? body.idempotencyKey.trim()
          : undefined,

      sender: senderUser._id,
      receiver: receiver._id,

      senderName: senderUser.fullName,
      senderEmail: senderUser.email,
      nameDestinataire: recipientName,
      recipientEmail: cleanEmail,

      destination: "paynoval",
      funds: "paynoval",
      provider: "paynoval",
      operator: body.operator || null,
      country: sanitize(lockedTargetCountry),

      amount: dec2(amountSourceStd),
      transactionFees: dec2(feeSourceStd),
      netAmount: dec2(netFromStd),
      exchangeRate: dec2(rateUsed),
      localAmount: dec2(amountTargetStd),

      senderCurrencySymbol: currencySourceISO,
      localCurrencySymbol: currencyTargetISO,

      amountSource: dec2(amountSourceStd),
      amountTarget: dec2(amountTargetStd),
      feeSource: dec2(feeSourceStd),
      fxRateSourceToTarget: dec2(rateUsed),
      currencySource: currencySourceISO,
      currencyTarget: currencyTargetISO,

      money: {
        source: { amount: amountSourceStd, currency: currencySourceISO },
        feeSource: { amount: feeSourceStd, currency: currencySourceISO },
        target: { amount: amountTargetStd, currency: currencyTargetISO },
        fxRateSourceToTarget: rateUsed,
      },

      pricingSnapshot: normalizePricingSnapshot(pricingSnapshot),
      pricingRuleApplied: pricingSnapshot?.ruleApplied || null,
      pricingFxRuleApplied: pricingSnapshot?.fxRuleApplied || null,

      feeSnapshot: {
        fee: feeSourceStd,
        netAfterFees: netFromStd,
        convertedNetAfterFees: amountTargetStd,
        exchangeRate: rateUsed,
        pricingDebug: pricingSnapshot?.debug || null,
      },
      feeActual: null,
      feeId: null,

      treasuryRevenue,
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
      providerStatus: "FUNDS_RESERVED_PENDING_CONFIRMATION",

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
    };

    const [tx] = await Transaction.create([txDoc], sessOpts);

    await reserveSenderFunds({
      transaction: tx,
      senderId: senderUser._id,
      amount: amountSourceStd,
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
      provider: "paynoval",
      amount: amountSourceStd,
      currency: currencySourceISO,
      toEmail: cleanEmail,
      details: {
        transactionId: String(tx._id),
        reference: tx.reference,
        flow: tx.flow,
        corridorLock: corridorLock.snapshot,
        autoCancelAt: tx.autoCancelAt || null,
        eligibility: {
          sender: {
            emailVerified: eligibilitySnapshot.sender.emailVerified,
            phoneVerified: eligibilitySnapshot.sender.phoneVerified,
            kycVerified: eligibilitySnapshot.sender.kycVerified,
            kybVerified: eligibilitySnapshot.sender.kybVerified,
            accountStatus: eligibilitySnapshot.sender.accountStatus,
          },
          receiver: {
            emailVerified: eligibilitySnapshot.receiver.emailVerified,
            phoneVerified: eligibilitySnapshot.receiver.phoneVerified,
            kycVerified: eligibilitySnapshot.receiver.kycVerified,
            kybVerified: eligibilitySnapshot.receiver.kybVerified,
            accountStatus: eligibilitySnapshot.receiver.accountStatus,
          },
        },
      },
      flagged: false,
      flagReason: "",
      transactionId: tx._id,
      ip: req.ip,
    }).catch(() => {});

    await notifyTransactionEvent(tx, "initiated", session, currencySourceISO);

    if (runtime.canUseSharedSession()) {
      await session.commitTransaction();
    }

    await endQuietly(session);

    return res.status(201).json({
      success: true,
      transactionId: String(tx._id),
      reference: tx.reference,
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      securityQuestion: q,
      autoCancelAt: tx.autoCancelAt || null,
      autoCancelAfterDays: getAutoCancelAfterDays(),
      pricing: {
        feeSource: feeSourceStd,
        feeSourceCurrency: currencySourceISO,
        netFrom: netFromStd,
        netTo: amountTargetStd,
        targetCurrency: currencyTargetISO,
        marketRate: pricingSnapshot?.result?.marketRate ?? null,
        appliedRate: pricingSnapshot?.result?.appliedRate ?? null,
        feeRevenue: pricingSnapshot?.result?.feeRevenue ?? null,
        fxRevenue: pricingSnapshot?.result?.fxRevenue ?? null,
      },
      treasuryRevenue,
      fundsReserved: true,
      treasuryCreditedAtInitiate: false,
      corridorLock: corridorLock.snapshot,
    });
  } catch (err) {
    safeLog("error", "[TX INTERNAL] failed", {
      message: err?.message,
      code: err?.code || null,
      details: err?.details || null,
      status: err?.status || err?.statusCode || 500,
      stack: err?.stack,
      body: buildDebugBody(req.body || {}),
      userId: req.user?.id || req.user?._id || null,
      ip: req.ip || null,
    });

    await abortQuietly(session);
    await endQuietly(session);
    next(err);
  }
}

module.exports = { initiateInternal };