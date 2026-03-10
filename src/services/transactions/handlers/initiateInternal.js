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

const { notifyParties } = require("../shared/notifications");

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

async function initiateInternal(req, res, next) {
  const session = await startTxSession();

  try {
    if (CAN_USE_SHARED_SESSION) session.startTransaction();

    const body = req.body || {};

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
      country,
      metadata = {},
      meta = {},
    } = body;

    const cleanEmail = String(toEmail || "").trim().toLowerCase();
    if (!cleanEmail || !isEmailLike(cleanEmail)) {
      throw createError(400, "Email du destinataire requis");
    }

    const q = sanitize(securityQuestion || question || "");
    const aRaw = sanitize(securityAnswer || securityCode || "");
    if (!q || !aRaw) {
      throw createError(400, "securityQuestion + securityAnswer requis");
    }

    if (!destination || !funds || !country) {
      throw createError(400, "Données de transaction incomplètes");
    }

    if (description && description.length > MAX_DESC_LENGTH) {
      throw createError(400, "Description trop longue");
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw createError(401, "Token manquant");
    }

    const senderId = req.user.id;
    const amt = toFloat(amount ?? body.amountSource);
    if (!amt || Number.isNaN(amt) || amt <= 0) {
      throw createError(400, "Montant invalide");
    }

    await validationService.validateTransactionAmount({ amount: amt });

    await validationService.detectBasicFraud({
      sender: senderId,
      receiverEmail: cleanEmail,
      amount: amt,
      currency: body.senderCurrencyCode || body.currencySource || body.senderCurrencySymbol,
    });

    const sessOpts = maybeSessionOpts(session);

    const senderUser = await User.findById(senderId)
      .select("fullName email")
      .lean()
      .session(sessOpts.session || null);

    if (!senderUser) {
      throw createError(403, "Utilisateur invalide");
    }

    const receiver = await User.findOne({ email: cleanEmail })
      .select("_id fullName email")
      .lean()
      .session(sessOpts.session || null);

    if (!receiver) {
      throw createError(404, "Destinataire introuvable");
    }

    if (receiver._id.toString() === senderId) {
      throw createError(400, "Auto-transfert impossible");
    }

    const currencySourceISO =
      normCur(
        body.senderCurrencyCode ||
          body.currencySource ||
          body.fromCurrency ||
          body.senderCurrencySymbol ||
          body.currency,
        country
      ) ||
      sanitize(
        body.senderCurrencyCode ||
          body.currencySource ||
          body.fromCurrency ||
          body.senderCurrencySymbol ||
          body.currency
      ).toUpperCase();

    const currencyTargetISO =
      normCur(
        body.localCurrencyCode ||
          body.currencyTarget ||
          body.toCurrency ||
          body.localCurrencySymbol,
        country
      ) ||
      sanitize(
        body.localCurrencyCode ||
          body.currencyTarget ||
          body.toCurrency ||
          body.localCurrencySymbol
      ).toUpperCase();

    req.body.senderCurrencyCode = currencySourceISO;
    req.body.localCurrencyCode = currencyTargetISO;
    req.body.senderCurrencySymbol = currencySourceISO;
    req.body.localCurrencySymbol = currencyTargetISO;

    const pricingInput = pickBodyPricingInput({
      ...req.body,
      amount: amt,
      fromCurrency: currencySourceISO,
      toCurrency: currencyTargetISO,
      provider: "paynoval",
      method: req.body.method || "INTERNAL",
      txType: req.body.txType || "TRANSFER",
      fromCountry: req.body.fromCountry || country,
      toCountry: req.body.toCountry || req.body.destinationCountry || country,
    });

    let pricingPayload;
    try {
      pricingPayload = await fetchPricingQuoteFromGateway({
        authHeader,
        pricingInput,
      });
    } catch (e) {
      logger.error("[pricing/quote] gateway error", {
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

    const reference = await generateTransactionRef();
    const securityAnswerHash = sha256Hex(aRaw);
    const amlSnapshot = req.aml || null;

    const txMeta = {
      ...((meta && typeof meta === "object") ? meta : {}),
      ...((metadata && typeof metadata === "object") ? metadata : {}),
      entry: "transfer.pending",
      ownerUserId: senderUser._id,
      receiverUserId: receiver._id,
      requestOrigin: "tx-core",
    };

    const [tx] = await Transaction.create(
      [
        {
          userId: senderUser._id,
          internalImported: false,

          flow: "PAYNOVAL_INTERNAL_TRANSFER",
          operationKind: "transfer",
          initiatedBy: "user",
          context: "paynoval_internal_transfer",
          contextId: null,

          reference,
          idempotencyKey: body.idempotencyKey || null,

          sender: senderUser._id,
          receiver: receiver._id,

          senderName: senderUser.fullName,
          senderEmail: senderUser.email,
          nameDestinataire:
            recipientInfo.name && sanitize(recipientInfo.name)
              ? sanitize(recipientInfo.name)
              : receiver.fullName,
          recipientEmail: cleanEmail,

          destination: "paynoval",
          funds: "paynoval",
          provider: "paynoval",
          operator: body.operator || null,
          country: sanitize(country),

          amount: dec2(amountSourceStd),
          transactionFees: dec2(feeSourceStd),
          netAmount: dec2(netFrom),
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
            netAfterFees: netFrom,
            convertedNetAfterFees: amountTargetStd,
            exchangeRate: rateUsed,
            pricingDebug: pricingSnapshot?.debug || null,
          },
          feeActual: null,
          feeId: null,

          adminRevenue,
          adminRevenueCredited: false,
          adminRevenueCreditedAt: null,

          securityQuestion: q,
          securityAnswerHash,
          securityCode: securityAnswerHash,

          amlSnapshot,
          amlStatus: amlSnapshot?.status || "passed",

          description: sanitize(description),
          orderId: body.orderId || null,

          metadata: {
            provider: "paynoval",
            method: req.body.method || "INTERNAL",
            txType: req.body.txType || "TRANSFER",
          },
          meta: txMeta,

          status: "pending",
          providerStatus: "PENDING_CONFIRMATION",

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
      details: { transactionId: tx._id.toString(), reference: tx.reference },
      flagged: false,
      flagReason: "",
      transactionId: tx._id,
      ip: req.ip,
    }).catch(() => {});

    await notifyParties(tx, "initiated", session, currencySourceISO);

    if (CAN_USE_SHARED_SESSION) await session.commitTransaction();
    session.endSession();

    return res.status(201).json({
      success: true,
      transactionId: tx._id.toString(),
      reference: tx.reference,
      flow: tx.flow,
      status: tx.status,
      providerStatus: tx.providerStatus,
      securityQuestion: q,
      pricing: {
        feeSource: feeSourceStd,
        feeSourceCurrency: currencySourceISO,
        netFrom,
        netTo: amountTargetStd,
        targetCurrency: currencyTargetISO,
        marketRate: pricingSnapshot?.result?.marketRate ?? null,
        appliedRate: pricingSnapshot?.result?.appliedRate ?? null,
        feeRevenue: pricingSnapshot?.result?.feeRevenue || null,
        fxRevenue: pricingSnapshot?.result?.fxRevenue || null,
      },
      adminRevenue,
      fundsReserved: true,
      adminCreditedAtInitiate: false,
    });
  } catch (err) {
    try {
      if (CAN_USE_SHARED_SESSION) await session.abortTransaction();
    } catch {}
    session.endSession();
    next(err);
  }
}

module.exports = { initiateInternal };