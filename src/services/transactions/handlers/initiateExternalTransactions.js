// File: src/services/transactions/handlers/initiateExternalTransactions.js
"use strict";

const createError = require("http-errors");
const { resoudreTypeExterne } = require("../shared/externalTxType");

const runtime = require("../shared/runtime");
const { validationService, logTransaction, logger, normCur, generateTransactionRef, reserveSenderFunds, normalizePricingSnapshot, normalizeTreasurySystemType, startTxSession, maybeSessionOpts, runInTransaction, safeAbort, safeEndSession } = runtime;

/**
 * Modèles liés PARESSEUSEMENT : chaque accès de propriété va chercher le
 * modèle au moment de l'usage. Les déstructurer directement résolvait la
 * connexion Mongo au chargement du fichier, ce qui rendait ce module
 * impossible à charger hors d'un serveur démarré.
 */
const { User, Transaction } = runtime.lazyModels(["User", "Transaction"]);

const { notifyTransactionEvent } = require("../transactionNotificationService");

const {
  sanitize,
  isEmailLike,
  toFloat,
  round2,
  dec2,
  sha256Hex,
  hashSecurityAnswer,
  MAX_DESC_LENGTH,
} = require("../shared/helpers");

const {
  pickBodyPricingInput,
  resolvePricingPayload,
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

const {
  assertUserCanTransact,
  buildEligibilitySnapshot,
  mergeEligibilityMetadata,
} = require("../shared/transactionEligibility");

const { submitExternalExecution } = require("./submitExternalExecution");
const { resolvePersistedIdempotencyKey } = require("../../../utils/idempotencyKeys");

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

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
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

/**
 * La résolution du type vit désormais dans `shared/externalTxType.js`, module
 * PUR et testé. Elle rend `null` quand l'appelant ne déclare rien, au lieu de
 * choisir `TRANSFER` à sa place : dépôt, retrait et transfert n'ont pas les
 * mêmes barèmes, et deviner produisait un prix plausible sur la mauvaise règle.
 */

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
  /* Exige un jeton `Bearer` et lève sinon. La valeur n'est plus transmise au
     devis — il se calcule dans le processus — mais le CONTRÔLE reste. */
  ensureBearer(req);
  const effectiveBody = { ...body, ...req.body };

  /**
   * Règle B.2 — le chemin de l'argent échoue en FERMETURE. Un appelant qui ne
   * déclare ni `txType` ni `action` était tarifé comme un TRANSFER : un prix
   * d'apparence normale, calculé sur un barème qui n'est pas le sien.
   */
  const typeExterne = resoudreTypeExterne(effectiveBody);

  if (!typeExterne) {
    throw createError(
      400,
      "Type d'opération non déclaré : indiquez `txType` — TRANSFER, DEPOSIT ou WITHDRAW. Le tarif dépend du type, il ne peut pas être supposé.",
      { code: "TX_TYPE_REQUIRED" }
    );
  }

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
    const {
      resolvePersistedIdempotencyKey,
    } = require("../../../utils/idempotencyKeys");

    /**
     * Même règle que sur le chemin interne : le prix appliqué est celui du
     * devis accepté. `effectiveBody` porte les alias historiques du verrou
     * (`pricingLockId`, `pricingId`, `quoteId`), que le mobile envoie tous.
     */
    pricingPayload = await resolvePricingPayload({
      pricingInput,
      quoteId:
        effectiveBody.effectivePricingId ||
        effectiveBody.pricingLockId ||
        effectiveBody.pricingId ||
        effectiveBody.quoteId ||
        null,
      userId: String(req.user?.id || req.user?._id || "").trim(),
      idempotencyKey: resolvePersistedIdempotencyKey(req, effectiveBody),
      contexte: "external",
    });
  } catch (e) {
    /* Nom corrigé le 2026-09-16 : ce chemin n'appelle plus aucun service tiers. */
    logger.error("[pricing/quote] erreur de tarification (externe)", {
      pricingInput,
      code: e?.code || null,
      status: e.status || e.response?.status,
      responseData: e.response?.data,
      message: e.message,
    });

    /**
     * ⚠️ UN REFUS DE DEVIS N'EST PAS UNE PANNE DE SERVICE — voir le même
     * raisonnement sur le chemin interne. « Ce devis a expiré » demande un
     * nouveau devis ; un 502 ferait réessayer à l'identique, sans fin.
     */
    if (e?.status >= 400 && e?.status < 500) throw e;

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
  /**
   * Pas de `|| 1` ici. Il y en avait un jusqu'au 2026-09-03, et il rendait la
   * garde de la ligne suivante INCAPABLE d'attraper ce qu'elle prétend
   * attraper : un `appliedRate` absent, nul ou `NaN` devenait 1 — un taux
   * 1:1 parfaitement fini et positif, qui franchit le contrôle. Sur une paire
   * XOF→EUR, cela transforme une panne de tarification en perte silencieuse
   * de trois ordres de grandeur (règle B.2 : le chemin de l'argent échoue en
   * FERMETURE, il ne prend pas de valeur par défaut).
   */
  const rateUsed = Number(pricingSnapshot?.result?.appliedRate);

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

function buildOutboundEligibilitySnapshot({ req, senderUser, senderEligibility }) {
  return {
    requester:
      req.transactionEligibility?.user ||
      senderEligibility.snapshot ||
      buildEligibilitySnapshot(senderUser),
    sender: senderEligibility.snapshot || buildEligibilitySnapshot(senderUser),
  };
}

function buildInboundEligibilitySnapshot({ req, receiverUser, receiverEligibility }) {
  return {
    requester:
      req.transactionEligibility?.user ||
      receiverEligibility.snapshot ||
      buildEligibilitySnapshot(receiverUser),
    receiver:
      receiverEligibility.snapshot || buildEligibilitySnapshot(receiverUser),
  };
}

async function initiateOutboundExternal(req, res, next) {
  const session = await startTxSession();

  try {

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

    /**
     * ════════════════════════════════════════════════════════════════════
     * PHASE 1 — PRÉPARATION. AUCUNE TRANSACTION OUVERTE.
     * ════════════════════════════════════════════════════════════════════
     *
     * `buildPricingContext()` appelle la passerelle en HTTP POST avec un
     * délai d'attente de DOUZE SECONDES. Le laisser dans la transaction,
     * c'est tenir des verrous Mongo pendant qu'on attend un autre service —
     * et au-delà de `transactionLifetimeLimitSeconds` (60 s par défaut) le
     * serveur tue la transaction sous nos pieds.
     *
     * Tout ce bloc ne fait que lire, valider et calculer : rien à annuler.
     */

    const senderUser = await User.findById(senderId)
      .select(USER_CORRIDOR_SELECT)
      .lean()
      .session(null);
    if (!senderUser) {
      throw createError(403, "Utilisateur invalide");
    }

    const senderEligibility = assertUserCanTransact(senderUser, {
      roleLabel: "expéditeur",
      codePrefix: "SENDER",
    });

    const eligibilitySnapshot = buildOutboundEligibilitySnapshot({
      req,
      senderUser,
      senderEligibility,
    });

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
    const securityAnswerHash = hashSecurityAnswer(aRaw);
    const amlSnapshot = req.aml || null;
    const treasurySeed = resolveFeesTreasurySeed();
    const autoCancelFields = buildAutoCancelFields("pending");

        const txMetaBase = {
      ...(isPlainObject(meta) ? meta : {}),
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

    const txMeta = mergeEligibilityMetadata(txMetaBase, eligibilitySnapshot);

    const txMetadataBase = {
      ...(isPlainObject(metadata) ? metadata : {}),
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

    const txMetadata = mergeEligibilityMetadata(
      txMetadataBase,
      eligibilitySnapshot
    );

    const destinationValue =
      flow === OUTBOUND_EXTERNAL_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT
        ? "mobilemoney"
        : "visa_direct";

    /**
     * ════════════════════════════════════════════════════════════════════
     * PHASE 2 — UNITÉ DE TRAVAIL. REJOUABLE DE BOUT EN BOUT.
     * ════════════════════════════════════════════════════════════════════
     *
     * Ne reste ici que ce qui doit être atomique : la création de la
     * transaction et la réservation des fonds. Rien n'en sort — ni réseau,
     * ni réponse HTTP, ni journal d'audit — donc le pilote peut réexécuter
     * ce corps autant de fois que Mongo le demande.
     */
    const tx = await runInTransaction(session, async (sess) => {
      const sessOpts = maybeSessionOpts(sess);

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
            idempotencyKey: resolvePersistedIdempotencyKey(req, body) || null,

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
            pricingRuleApplied: pricingCtx.pricingSnapshot?.ruleApplied || null,
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

            /**
             * ⚠️ ÉTAT INITIAL DÉCIDÉ PAR LE SCORE DE RISQUE.
             *
             * `amlMiddleware` s'exécute AVANT que la transaction existe : il ne
             * peut pas poser d'état, il pose son verdict sur `req.riskVerdict`.
             * C'est ici qu'il s'applique.
             *
             * `pending_review` n'est PAS un refus. Les fonds sont réservés
             * exactement comme pour un `pending` — indispensable : laisser le
             * solde disponible pendant la revue permettrait de le dépenser
             * ailleurs, et la transaction deviendrait impayable au moment de sa
             * validation. Seule la CONFIRMATION attend un opérateur.
             *
             * Sur un rail EXTERNE, la conséquence est plus forte encore :
             * aucune exécution prestataire ne part tant que l'état n'est pas
             * confirmé. La revue arrête donc l'argent AVANT qu'il ne quitte la
             * plateforme, ce qu'un contrôle après coup ne peut plus faire.
             */
            status:
              req?.riskVerdict?.band === "review" ? "pending_review" : "pending",
            riskScore:
              typeof req?.riskVerdict?.score === "number"
                ? req.riskVerdict.score
                : null,
            riskReasons: Array.isArray(req?.riskVerdict?.reasons)
              ? req.riskVerdict.reasons
              : null,
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
        session: sess,
      });

      tx.fundsReserved = true;
      tx.fundsReservedAt = new Date();
      tx.providerStatus = "FUNDS_RESERVED";

      await tx.save(sessOpts);

      /**
       * Écrit dans l'Outbox SOUS LA MÊME SESSION : si la réservation est
       * annulée, l'événement disparaît avec elle.
       */
      await notifyTransactionEvent(tx, "initiated", sess, currencySourceISO);

      return tx;
    });

    /**
     * Journal d'audit : APRÈS le commit, jamais dedans. Un rejeu du corps le
     * dupliquerait, et une trace d'audit en double vaut une trace fausse.
     */
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
        eligibility: {
          sender: {
            emailVerified: eligibilitySnapshot.sender.emailVerified,
            phoneVerified: eligibilitySnapshot.sender.phoneVerified,
            kycVerified: eligibilitySnapshot.sender.kycVerified,
            kybVerified: eligibilitySnapshot.sender.kybVerified,
            accountStatus: eligibilitySnapshot.sender.accountStatus,
          },
        },
      },
      flagged: false,
      flagReason: "",
      transactionId: tx._id,
      ip: req.ip,
    }).catch(() => {});

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

    await safeAbort(session);
    next(err);
  } finally {
    await safeEndSession(session);
  }
}

async function initiateInboundExternal(req, res, next) {
  const session = await startTxSession();

  try {

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

    /**
     * PHASE 1 — PRÉPARATION, HORS TRANSACTION.
     *
     * Même motif que le volet sortant : `buildPricingContext()` interroge la
     * passerelle en HTTP (12 s de délai d'attente). Aucun appel réseau ne
     * doit se trouver à l'intérieur d'une transaction Mongo.
     */


    const receiverUser = await User.findById(receiverId)
      .select(USER_CORRIDOR_SELECT)
      .lean()
      .session(null);

    if (!receiverUser) {
      throw createError(403, "Utilisateur invalide");
    }

    const receiverEligibility = assertUserCanTransact(receiverUser, {
      roleLabel: "destinataire",
      codePrefix: "RECEIVER",
    });

    const eligibilitySnapshot = buildInboundEligibilitySnapshot({
      req,
      receiverUser,
      receiverEligibility,
    });

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

    const reference =
      sanitize(body.reference) || (await generateTransactionRef());

    const amlSnapshot = req.aml || null;
    const treasurySeed = resolveFeesTreasurySeed();
    const autoCancelFields = buildAutoCancelFields("processing");

    const txMetaBase = {
      ...(isPlainObject(meta) ? meta : {}),
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

    const txMeta = mergeEligibilityMetadata(txMetaBase, eligibilitySnapshot);

    const txMetadataBase = {
      ...(isPlainObject(metadata) ? metadata : {}),
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

    const txMetadata = mergeEligibilityMetadata(
      txMetadataBase,
      eligibilitySnapshot
    );

    /**
     * Le repli valait « stripe » : rail retiré le 2026-09-08, dont l'adapter a
     * été supprimé. Toute alimentation par carte y retombait dès que `provider`
     * n'était pas exactement « visa_direct ».
     */
    const fundsValue =
      flow === INBOUND_EXTERNAL_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL
        ? "mobilemoney"
        : "visa_direct";

    /**
     * PHASE 2 — UNITÉ DE TRAVAIL, REJOUABLE.
     *
     * Encaissement entrant : aucun fonds n'est encore réservé ici, la
     * transaction ne couvre que la création du document et la mise en file
     * de l'événement — les deux doivent tenir ou tomber ensemble.
     */
    const tx = await runInTransaction(session, async (sess) => {
      const sessOpts = maybeSessionOpts(sess);

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
            idempotencyKey: resolvePersistedIdempotencyKey(req, body) || null,

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

      await notifyTransactionEvent(tx, "processing", sess, currencyTargetISO);

      return tx;
    });

    /**
     * Journal d'audit : après le commit. Un rejeu du corps le dupliquerait.
     */
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
        eligibility: {
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

    await safeAbort(session);
    next(err);
  } finally {
    await safeEndSession(session);
  }
}

module.exports = {
  initiateOutboundExternal,
  initiateInboundExternal,
};