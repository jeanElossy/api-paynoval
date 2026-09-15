"use strict";

/**
 * ============================================================================
 * PARTICIPATION À UNE CAGNOTTE DEPUIS L'APPLICATION — DEVIS, RÈGLEMENT,
 * REMBOURSEMENT
 * ============================================================================
 *
 * ── Le défaut que cette refonte ferme (R-14, 2026-09-10) ────────────────────
 *
 * Ce contrôleur débitait `payer.amount` en `payer.currency` et créditait des
 * frais en `feeCredit.currency` — trois valeurs reçues du backend, qui les
 * tenait lui-même du CLIENT (`amountViewer`, `viewerCurrencyCode`). Le montant
 * crédité au coffre, lui, n'était même pas connu d'ici. Tx-Core réglait donc
 * un mouvement dont il ne connaissait ni le taux ni le résultat, et le retrait
 * payait ensuite ce que le backend annonçait.
 *
 * ── La forme retenue : devis figé, puis règlement qui le consomme ───────────
 *
 *   1. DEVIS    — la devise source est lue sur le COMPTE du participant, la
 *                 devise cible sur la POSITION du coffre (immuable) ; montant,
 *                 frais, taux et marge sortent du moteur `PricingRule`. Le
 *                 devis est figé dans `CagnotteQuote` (base transactions).
 *   2. RÈGLEMENT — dans UNE transaction : consommation conditionnelle du devis
 *                 (ACTIVE → USED), crédit conditionnel de la position (objectif,
 *                 clôture), débit conditionnel du portefeuille, trésoreries,
 *                 document de règlement, grand livre.
 *   3. REMBOURSEMENT — contre-écriture au taux d'origine, au prorata.
 *
 * Aucun montant, taux ou devise de ce règlement ne vient de l'appelant : il
 * ne fournit que des identifiants. C'est la propriété qui ferme R-14.
 *
 * Réseau (taux en direct) : UNIQUEMENT au devis, hors transaction. Le
 * règlement relit le devis et ne fait aucun appel sortant.
 */

const crypto = require("node:crypto");
const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");

const { getTxConn, getUsersConn } = require("../config/db");
const buildTxWalletBalanceModel = require("../models/TxWalletBalance");
const buildTxSystemBalanceModel = require("../models/TxSystemBalance");
const buildCagnotteSettlementModel = require("../models/CagnotteSettlement");
const buildCagnotteQuoteModel = require("../models/CagnotteQuote");
const buildCagnotteVaultPositionModel = require("../models/CagnotteVaultPosition");
const buildCagnotteRefundSettlementModel = require("../models/CagnotteRefundSettlement");
const buildUserModel = require("../models/User");

const { runWithTransaction } = require("../utils/transactionRunner");
const { canUseSharedSession } = require("../utils/sharedSession");
const {
  settlementObjectIdFromReference,
  postCagnotteLotEntries,
  getTreasuryUserIdBySystemType,
} = require("../services/ledgerService");
const {
  buildCagnotteCreditLots,
  buildCagnotteRefundLots,
  computeRefundAmounts,
} = require("../services/ledger/cagnotteLegs");
const { computeCagnottePricing, TX_TYPES } = require("../services/cagnotte/participationPricing");
const { assertSupportedCagnotteCurrency } = require("../services/cagnotte/currencies");
const {
  openPosition,
  getPosition,
  creditPosition,
  debitPosition,
  positionToJSON,
} = require("../services/cagnotte/vaultPosition");
const { roundMoney, decimalsForCurrency } = require("../services/pricing/pricingEngine");
const logger = require("../utils/logger");

const CAGNOTTE_FEES = "CAGNOTTE_FEES_TREASURY";
const FX_MARGIN = "FX_MARGIN_TREASURY";

const QUOTE_TTL_MS = (() => {
  const s = Number(process.env.CAGNOTTE_QUOTE_TTL_SECONDS || 600);
  const bounded = Number.isFinite(s) ? Math.min(Math.max(s, 60), 1800) : 600;
  return bounded * 1000;
})();

const QUOTE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Outils                                                                     */
/* -------------------------------------------------------------------------- */

function httpError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.code = code;
  if (details) err.details = details;
  return err;
}

/**
 * Une erreur NOMMÉE rend son message ; une erreur inattendue rend un message
 * générique et est journalisée ici (règle B.4 : un message interne peut
 * porter un identifiant, un chemin, une requête).
 */
function sendError(res, err, context) {
  const status = Number(err?.statusCode || err?.status || 500);
  const named = Boolean(err?.code) && typeof err.code === "string";

  if (!named || status >= 500) {
    logger.error(`[cagnotte][${context}] ${err?.message || err}`, {
      code: err?.code || null,
      status,
    });
  }

  return res.status(status >= 400 && status < 600 ? status : 500).json({
    success: false,
    code: named ? err.code : "INTERNAL_ERROR",
    error: named ? err.message : "Erreur interne Tx-Core.",
    ...(err?.details ? { details: err.details } : {}),
  });
}

function str(v) {
  return String(v ?? "").trim();
}

function models() {
  const txConn = getTxConn();
  return {
    txConn,
    TxWalletBalance: buildTxWalletBalanceModel(txConn),
    TxSystemBalance: buildTxSystemBalanceModel(txConn),
    Settlement: buildCagnotteSettlementModel(txConn),
    Quote: buildCagnotteQuoteModel(txConn),
    Position: buildCagnotteVaultPositionModel(txConn),
    Refund: buildCagnotteRefundSettlementModel(txConn),
  };
}

function decimal(amount, currency, { negative = false } = {}) {
  const r = roundMoney(Number(amount), currency);
  const d = decimalsForCurrency(currency);
  return mongoose.Types.Decimal128.fromString((negative ? -r : r).toFixed(d));
}

function numberOf(v) {
  const n = Number(v && typeof v === "object" && v.toString ? v.toString() : v);
  return Number.isFinite(n) ? n : 0;
}

function walletAfter(doc) {
  if (!doc) return null;
  return {
    walletId: String(doc._id),
    currency: doc.currency,
    amount: numberOf(doc.amount),
    availableAmount: numberOf(doc.availableAmount),
    reservedAmount: numberOf(doc.reservedAmount),
  };
}

function treasuryFor(systemType) {
  try {
    return { userId: getTreasuryUserIdBySystemType(systemType), systemType };
  } catch {
    throw httpError(
      500,
      "TREASURY_UNCONFIGURED",
      `Trésorerie ${systemType} non configurée : l'opération est refusée plutôt ` +
        "que d'encaisser des fonds sans compte de destination."
    );
  }
}

/**
 * ⚠️ REFUS EN FERMETURE QUAND AUCUNE TRANSACTION RÉELLE N'EST DISPONIBLE.
 *
 * `postDoubleEntry` ne transmet la session au grand livre que si les deux
 * connexions partagent leur client Mongo. Sans elle, les écritures partiraient
 * HORS de la transaction qui porte le mouvement de solde : un grand livre faux
 * est pire qu'un grand livre absent — on lui fait confiance.
 */
function refuseWithoutAtomicSession(res, reference, label) {
  if (canUseSharedSession(getUsersConn, getTxConn)) return false;

  logger.error(`[cagnotte][${label}] REFUS : session atomique indisponible`, {
    reference,
    consequence: "le grand livre s'écrirait hors transaction ; aucun mouvement n'a eu lieu",
  });

  res.status(503).json({
    success: false,
    code: "ATOMIC_SESSION_UNAVAILABLE",
    error:
      "Opération de cagnotte refusée : les deux bases ne partagent pas de session " +
      "Mongo, le mouvement de solde et l'écriture au grand livre ne peuvent donc " +
      "pas être atomiques. Vérifier MONGO_SHARE_CLIENT.",
  });

  return true;
}

/* -------------------------------------------------------------------------- */
/* Participant                                                                */
/* -------------------------------------------------------------------------- */

const RESTRICTED_STATUSES = new Set(["restricted", "frozen", "suspended", "blocked", "closed"]);

/**
 * Charge le participant depuis la base Users — la source de vérité de sa
 * devise. PURE hormis la lecture : aucune devise par défaut (règle B.2).
 */
async function loadParticipant(userId) {
  const id = str(userId);

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw httpError(400, "INVALID_USER_ID", "Identifiant de participant invalide.");
  }

  const User = buildUserModel(getUsersConn());
  const user = await User.findById(id)
    .select("-password -pin -pinHash -securityAnswerHash -twoFactorSecret -resetPasswordToken")
    .lean();

  if (!user) {
    throw httpError(404, "PARTICIPANT_NOT_FOUND", "Participant introuvable.");
  }

  const status = str(user.accountStatus || user.status).toLowerCase();

  if (user.isBlocked === true || RESTRICTED_STATUSES.has(status)) {
    throw httpError(
      403,
      "ACCOUNT_RESTRICTED",
      "Votre compte fait l'objet d'une restriction : la participation est suspendue."
    );
  }

  if (!str(user.currency)) {
    throw httpError(
      409,
      "ACCOUNT_CURRENCY_MISSING",
      "La devise de votre compte n'est pas définie. Aucune devise n'est devinée : " +
        "contactez le support."
    );
  }

  const currency = assertSupportedCagnotteCurrency(user.currency, process.env, "devise du compte");

  return { user, currency };
}

/**
 * Middleware : prépare la requête de DEVIS pour le contrôle AML existant
 * (`middleware/aml.js`) — même porte que les virements, aucune architecture
 * parallèle. Le participant est lu en base, jamais pris dans le corps.
 */
async function attachCagnotteParticipant(req, res, next) {
  try {
    const { user, currency } = await loadParticipant(req.body?.userId);

    req.user = user;
    req.routedProvider = "paynoval";
    req.cagnotteParticipant = { userId: String(user._id), currency, country: user.country || null };

    // `amlMiddleware` lit le montant et la devise dans le corps.
    req.body = { ...req.body, amountSource: req.body.amount, currency };

    return next();
  } catch (err) {
    return sendError(res, err, "participant");
  }
}

/* -------------------------------------------------------------------------- */
/* Mise en forme                                                              */
/* -------------------------------------------------------------------------- */

function quoteToJSON(q) {
  return {
    quoteId: q.quoteId,
    expiresAt: q.expiresAt,
    paymentMethod: "PAYNOVAL_BALANCE",
    source: { amount: q.source.amount, currency: q.source.currency },
    fee: { amount: q.fee.amount, currency: q.fee.currency },
    netSource: q.netSource,
    fx: q.fx.required
      ? {
          required: true,
          rate: q.fx.appliedRate,
          marketRate: q.fx.marketRate,
          provider: q.fx.provider,
          timestamp: q.fx.asOf,
        }
      : { required: false },
    destination: { amount: q.destination.amount, currency: q.destination.currency },
  };
}

function settlementToJSON(s, position = null) {
  const doc = s && typeof s.toObject === "function" ? s.toObject() : s;

  return {
    settlementId: String(doc._id),
    reference: doc.reference,
    quoteId: doc.quoteId || null,
    cagnotteId: doc.cagnotteId || null,
    vaultId: doc.vaultId || null,
    status: doc.status,
    source: doc.source || doc.payer || null,
    fee: doc.fee || null,
    netSource: doc.netSource ?? null,
    destination: doc.destination || null,
    fx: doc.fx || null,
    refunded: doc.refunded || { source: 0, target: 0 },
    payerWalletAfter: doc.payerWalletAfter || null,
    createdAt: doc.createdAt,
    ...(position ? { position: positionToJSON(position) } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* 1. Devis                                                                   */
/* -------------------------------------------------------------------------- */

const quoteCagnotteParticipation = asyncHandler(async (req, res) => {
  const { Position, Quote } = models();

  try {
    const userId = str(req.body?.userId);
    const cagnotteId = str(req.body?.cagnotteId);
    const vaultId = str(req.body?.vaultId);
    const amount = Number(req.body?.amount);

    if (!cagnotteId || !vaultId) {
      throw httpError(400, "INVALID_REQUEST", "cagnotteId et vaultId sont requis.");
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw httpError(400, "INVALID_AMOUNT", "Montant de participation invalide.");
    }

    const target = assertSupportedCagnotteCurrency(
      req.body?.cagnotteCurrency,
      process.env,
      "devise de la cagnotte"
    );

    const participant =
      req.cagnotteParticipant && req.cagnotteParticipant.userId === userId
        ? req.cagnotteParticipant
        : await loadParticipant(userId).then(({ user, currency }) => ({
            userId: String(user._id),
            currency,
            country: user.country || null,
          }));

    // La position fige la devise du coffre à sa première ouverture (R3).
    const position = await openPosition({ Model: Position, vaultId, cagnotteId, currency: target });

    if (position.closedAt) {
      throw httpError(409, "VAULT_CLOSED", "La cagnotte est clôturée : elle ne reçoit plus de participation.");
    }

    const pricing = await computeCagnottePricing({
      txType: TX_TYPES.PARTICIPATION,
      method: "INTERNAL",
      provider: "paynoval",
      amount,
      sourceCurrency: participant.currency,
      targetCurrency: target,
      country: participant.country,
      requestId: str(req.get?.("x-request-id")) || null,
    });

    const now = Date.now();

    const quote = await Quote.create({
      quoteId: crypto.randomUUID(),
      userId: participant.userId,
      cagnotteId,
      vaultId,
      status: "ACTIVE",
      expiresAt: new Date(now + QUOTE_TTL_MS),
      purgeAt: new Date(now + QUOTE_TTL_MS + QUOTE_RETENTION_MS),
      source: pricing.source,
      fee: pricing.fee,
      netSource: pricing.netSource,
      destination: pricing.destination,
      fx: {
        required: pricing.fx.required,
        appliedRate: pricing.fx.appliedRate,
        marketRate: pricing.fx.marketRate,
        revenue: pricing.fx.revenue,
        provider: pricing.fx.provider,
        rateSource: pricing.fx.rateSource,
        asOf: pricing.fx.asOf,
      },
      rule: pricing.rule,
      requestId: str(req.get?.("x-request-id")) || null,
    });

    return res.status(201).json({ success: true, data: quoteToJSON(quote) });
  } catch (err) {
    return sendError(res, err, "devis");
  }
});

/* -------------------------------------------------------------------------- */
/* 2. Règlement                                                               */
/* -------------------------------------------------------------------------- */

/** Pourquoi la consommation conditionnelle du devis n'a rien trouvé. */
async function diagnoseQuote({ Quote, quoteId, userId, cagnotteId, vaultId, session }) {
  const q = await Quote.findOne({ quoteId }).session(session).lean();

  if (!q) return httpError(404, "QUOTE_NOT_FOUND", "Devis introuvable. Redemandez un devis.");

  if (q.userId !== userId || q.cagnotteId !== cagnotteId || q.vaultId !== vaultId) {
    return httpError(409, "QUOTE_MISMATCH", "Ce devis ne correspond pas à cette participation.");
  }

  if (q.status === "USED") {
    return httpError(409, "QUOTE_ALREADY_USED", "Ce devis a déjà servi à une participation.");
  }

  return httpError(409, "QUOTE_EXPIRED", "Le devis a expiré. Redemandez un devis : le taux a pu changer.");
}

async function debitPayerWallet({ TxWalletBalance, userId, currency, amount, session }) {
  const wallet = await TxWalletBalance.findOne({
    currency,
    $or: [{ user: userId }, { userId }],
  }).session(session);

  if (!wallet) {
    throw httpError(404, "WALLET_NOT_FOUND", `Aucun portefeuille PayNoval en ${currency}.`);
  }

  const dec = decimal(amount, currency);

  const updated = await TxWalletBalance.findOneAndUpdate(
    { _id: wallet._id, amount: { $gte: dec }, availableAmount: { $gte: dec } },
    { $inc: { amount: decimal(amount, currency, { negative: true }), availableAmount: decimal(amount, currency, { negative: true }) } },
    { new: true, session }
  );

  if (!updated) {
    throw httpError(400, "INSUFFICIENT_BALANCE", "Solde PayNoval insuffisant pour cette participation.", {
      currency,
      available: numberOf(wallet.availableAmount ?? wallet.amount),
      required: amount,
    });
  }

  return updated;
}

const settleCagnotteParticipation = asyncHandler(async (req, res) => {
  const { txConn, TxWalletBalance, TxSystemBalance, Settlement, Quote, Position } = models();

  const quoteId = str(req.body?.quoteId);
  const ref = str(req.body?.reference);
  const idem = str(req.body?.idempotencyKey);
  const userId = str(req.body?.userId);
  const cagnotteId = str(req.body?.cagnotteId);
  const vaultId = str(req.body?.vaultId);

  if (!quoteId) {
    return res.status(410).json({
      success: false,
      code: "LEGACY_PARTICIPATION_SETTLE_REMOVED",
      error:
        "Le règlement sur montants fournis par l'appelant est retiré (R-14). Une " +
        "participation se règle sur un devis Tx-Core : POST /api/v1/cagnotte/participation/quote.",
    });
  }

  let target;
  let goalCap = null;

  try {
    if (!ref || !idem || !userId || !cagnotteId || !vaultId) {
      throw httpError(400, "INVALID_REQUEST", "reference, idempotencyKey, userId, cagnotteId et vaultId sont requis.");
    }

    target = assertSupportedCagnotteCurrency(req.body?.cagnotteCurrency, process.env, "devise de la cagnotte");

    if (req.body?.goalCap != null) {
      goalCap = Number(req.body.goalCap);
      if (!Number.isFinite(goalCap) || goalCap <= 0) {
        throw httpError(400, "INVALID_GOAL", "Objectif invalide.");
      }
    }
  } catch (err) {
    return sendError(res, err, "règlement");
  }

  if (refuseWithoutAtomicSession(res, ref, "participation")) return undefined;

  const settlementId = settlementObjectIdFromReference(ref, "cagnotte.participation");

  const existing = await Settlement.findOne({ reference: ref }).lean();
  if (existing) {
    if (existing.userId !== userId) {
      return sendError(res, httpError(409, "REFERENCE_CONFLICT", "Référence déjà utilisée par un autre participant."), "règlement");
    }
    return res.status(200).json({ success: true, alreadyProcessed: true, data: settlementToJSON(existing) });
  }

  /**
   * MODE REJEU : l'appelant sait que la cagnotte ne doit plus recevoir de
   * participation (pause, objectif, échéance) mais cherche à rattraper un
   * règlement dont la réponse s'est perdue. On rend l'existant, et on ne
   * déclenche JAMAIS de nouveau mouvement.
   */
  if (req.body?.replayOnly === true) {
    return res.status(404).json({
      success: false,
      code: "SETTLEMENT_NOT_FOUND",
      error: "Aucun règlement pour cette référence ; en mode rejeu, aucun mouvement n'est déclenché.",
    });
  }

  const session = await txConn.startSession();

  try {
    const result = await runWithTransaction(session, async () => {
      const again = await Settlement.findOne({ reference: ref }).session(session);
      if (again) return { replay: again };

      const now = new Date();

      const quote = await Quote.findOneAndUpdate(
        { quoteId, userId, cagnotteId, vaultId, status: "ACTIVE", expiresAt: { $gt: now } },
        { $set: { status: "USED", usedAt: now, usedByReference: ref } },
        { new: true, session }
      );

      if (!quote) {
        throw await diagnoseQuote({ Quote, quoteId, userId, cagnotteId, vaultId, session });
      }

      if (quote.destination.currency !== target) {
        throw httpError(409, "VAULT_CURRENCY_MISMATCH", "Le devis n'est pas libellé dans la devise de la cagnotte.");
      }

      const S = quote.source.currency;
      const gross = quote.source.amount;
      const fee = quote.fee.amount;
      const netSource = quote.netSource;
      const netTarget = quote.destination.amount;
      const fxRevenue = Number(quote.fx?.revenue?.amount || 0);

      const feesTreasury = fee > 0 ? treasuryFor(CAGNOTTE_FEES) : null;
      const fxMarginTreasury = fxRevenue > 0 ? treasuryFor(FX_MARGIN) : null;

      // Construit AVANT toute écriture : une incohérence lève sans rien déplacer.
      const lots = buildCagnotteCreditLots({
        origin: { kind: "USER_WALLET", userId },
        sourceCurrency: S,
        targetCurrency: target,
        gross,
        fee,
        netSource,
        netTarget,
        fxRevenue,
        feesTreasury,
        fxMarginTreasury,
      });

      const position = await creditPosition({
        Model: Position,
        vaultId,
        currency: target,
        amount: netTarget,
        goalCap,
        session,
      });

      const payerWallet = await debitPayerWallet({
        TxWalletBalance,
        userId,
        currency: S,
        amount: gross,
        session,
      });

      let treasuryWallet = null;

      if (fee > 0) {
        treasuryWallet = await TxSystemBalance.credit(feesTreasury.userId, CAGNOTTE_FEES, S, fee, {
          session,
          fullName: "Cagnotte Fees Treasury",
          reference: ref,
          historyMetadata: { source: "settleCagnotteParticipation", cagnotteId },
        });
      }

      if (fxRevenue > 0) {
        await TxSystemBalance.credit(fxMarginTreasury.userId, FX_MARGIN, target, fxRevenue, {
          session,
          fullName: "FX Margin Treasury",
          reference: ref,
          historyMetadata: { source: "settleCagnotteParticipation", cagnotteId },
        });
      }

      const [settlement] = await Settlement.create(
        [
          {
            _id: settlementId,
            reference: ref,
            idempotencyKey: idem,
            userId,
            treasuryUserId: feesTreasury?.userId || "",
            treasurySystemType: feesTreasury ? CAGNOTTE_FEES : "",
            treasuryLabel: feesTreasury ? "Cagnotte Fees Treasury" : "",
            payer: { amount: gross, currency: S },
            feeCredit: { amount: fee, currency: S, baseAmount: 0, baseCurrencyCode: "" },
            status: "confirmed",
            payerWalletAfter: walletAfter(payerWallet),
            treasuryWalletAfter: treasuryWallet
              ? { walletId: String(treasuryWallet._id), currency: S, amount: 0, availableAmount: 0, reservedAmount: 0 }
              : null,
            meta: { settlementKind: "cagnotte_participation_settlement", source: "app" },
            schemaVersion: 2,
            cagnotteId,
            vaultId,
            quoteId,
            source: { amount: gross, currency: S },
            fee: { amount: fee, currency: S },
            netSource,
            destination: { amount: netTarget, currency: target },
            fx: {
              required: Boolean(quote.fx?.required),
              appliedRate: quote.fx?.appliedRate ?? null,
              marketRate: quote.fx?.marketRate ?? null,
              revenue: fxRevenue,
              provider: quote.fx?.provider || null,
              rateSource: quote.fx?.rateSource || null,
              asOf: quote.fx?.asOf || null,
            },
            refunded: { source: 0, target: 0 },
          },
        ],
        { session }
      );

      /**
       * ⚠️ LE GRAND LIVRE, DANS LA MÊME TRANSACTION, AVEC LA SESSION. Un échec
       * ici annule le débit, le crédit de position et la consommation du devis.
       */
      await postCagnotteLotEntries({
        settlementId: settlement._id,
        reference: ref,
        lots,
        session,
        metadata: { settlementKind: "cagnotte_participation_settlement", cagnotteId, vaultId, quoteId },
      });

      return { settlement, position };
    });

    if (result.replay) {
      return res.status(200).json({ success: true, alreadyProcessed: true, data: settlementToJSON(result.replay) });
    }

    return res.status(201).json({ success: true, data: settlementToJSON(result.settlement, result.position) });
  } catch (err) {
    if (err?.code === 11000) {
      const done = await Settlement.findOne({ reference: ref }).lean();
      if (done) {
        return res.status(200).json({ success: true, alreadyProcessed: true, data: settlementToJSON(done) });
      }
    }
    return sendError(res, err, "règlement");
  } finally {
    try {
      session.endSession();
    } catch {}
  }
});

/* -------------------------------------------------------------------------- */
/* 3. Remboursement                                                           */
/* -------------------------------------------------------------------------- */

const refundCagnotteParticipation = asyncHandler(async (req, res) => {
  const { txConn, TxWalletBalance, Settlement, Position, Refund } = models();

  const ref = str(req.body?.reference);
  const idem = str(req.body?.idempotencyKey);
  const participationReference = str(req.body?.participationReference);
  const initiatedByUserId = str(req.body?.initiatedByUserId);
  const reason = str(req.body?.reason).slice(0, 500);
  const requestedTarget = req.body?.amount == null ? null : Number(req.body.amount);

  if (!ref || !idem || !participationReference || !initiatedByUserId) {
    return sendError(
      res,
      httpError(400, "INVALID_REQUEST", "reference, idempotencyKey, participationReference et initiatedByUserId sont requis."),
      "remboursement"
    );
  }

  if (refuseWithoutAtomicSession(res, ref, "remboursement")) return undefined;

  const settlementId = settlementObjectIdFromReference(ref, "cagnotte.refund");

  const existing = await Refund.findOne({ reference: ref }).lean();
  if (existing) {
    return res.status(200).json({ success: true, alreadyProcessed: true, data: existing });
  }

  const session = await txConn.startSession();

  try {
    const result = await runWithTransaction(session, async () => {
      const again = await Refund.findOne({ reference: ref }).session(session);
      if (again) return { replay: again };

      const original = await Settlement.findOne({ reference: participationReference }).session(session);

      if (!original) {
        throw httpError(404, "PARTICIPATION_NOT_FOUND", "Participation introuvable.");
      }

      if (Number(original.schemaVersion || 1) < 2 || !original.destination || !original.source) {
        throw httpError(
          409,
          "LEGACY_SETTLEMENT_NOT_REFUNDABLE",
          "Participation antérieure au devis Tx-Core : son taux n'a pas été figé, elle " +
            "ne peut pas être remboursée automatiquement. Traiter par ajustement manuel audité."
        );
      }

      const S = original.source.currency;
      const T = original.destination.currency;
      const refundedSource = Number(original.refunded?.source || 0);
      const refundedTarget = Number(original.refunded?.target || 0);

      const amounts = computeRefundAmounts({
        sourceCurrency: S,
        targetCurrency: T,
        netSource: original.netSource,
        netTarget: original.destination.amount,
        refundedSource,
        refundedTarget,
        requestedTarget,
      });

      const lots = buildCagnotteRefundLots({
        payerUserId: original.userId,
        sourceCurrency: S,
        targetCurrency: T,
        refundSource: amounts.refundSource,
        refundTarget: amounts.refundTarget,
      });

      // Garde de concurrence : deux remboursements simultanés ne partent pas
      // tous les deux du même cumul.
      const guard = await Settlement.updateOne(
        { _id: original._id, "refunded.source": refundedSource, "refunded.target": refundedTarget },
        {
          $set: {
            "refunded.source": roundMoney(refundedSource + amounts.refundSource, S),
            "refunded.target": roundMoney(refundedTarget + amounts.refundTarget, T),
          },
        },
        { session }
      );

      if (!guard?.modifiedCount) {
        throw httpError(409, "CONCURRENT_REFUND", "Un autre remboursement est en cours sur cette participation. Réessayer.");
      }

      const position = await debitPosition({
        Model: Position,
        vaultId: original.vaultId,
        currency: T,
        amount: amounts.refundTarget,
        kind: "REFUND",
        forbidClosed: true,
        session,
      });

      const wallet = await TxWalletBalance.findOneAndUpdate(
        { currency: S, $or: [{ user: original.userId }, { userId: original.userId }] },
        {
          $inc: {
            amount: decimal(amounts.refundSource, S),
            availableAmount: decimal(amounts.refundSource, S),
          },
        },
        { new: true, session }
      );

      if (!wallet) {
        throw httpError(
          409,
          "PAYER_WALLET_NOT_FOUND",
          `Le portefeuille ${S} du participant est introuvable : remboursement refusé, rien n'a bougé.`
        );
      }

      const [refund] = await Refund.create(
        [
          {
            _id: settlementId,
            reference: ref,
            idempotencyKey: idem,
            participationReference,
            participationSettlementId: String(original._id),
            cagnotteId: original.cagnotteId,
            vaultId: original.vaultId,
            payerUserId: original.userId,
            initiatedByUserId,
            reason,
            refundTarget: { amount: amounts.refundTarget, currency: T },
            refundSource: { amount: amounts.refundSource, currency: S },
            isFinal: amounts.isFinal,
            status: "confirmed",
            payerWalletAfter: walletAfter(wallet),
            meta: { settlementKind: "cagnotte_participation_refund" },
          },
        ],
        { session }
      );

      await postCagnotteLotEntries({
        settlementId: refund._id,
        reference: ref,
        lots,
        session,
        metadata: {
          settlementKind: "cagnotte_participation_refund",
          participationReference,
          cagnotteId: original.cagnotteId,
          vaultId: original.vaultId,
        },
      });

      return { refund, position };
    });

    if (result.replay) {
      return res.status(200).json({ success: true, alreadyProcessed: true, data: result.replay });
    }

    return res.status(201).json({
      success: true,
      data: {
        ...(result.refund.toObject ? result.refund.toObject() : result.refund),
        position: positionToJSON(result.position),
      },
    });
  } catch (err) {
    if (err?.code === 11000) {
      const done = await Refund.findOne({ reference: ref }).lean();
      if (done) return res.status(200).json({ success: true, alreadyProcessed: true, data: done });
    }
    return sendError(res, err, "remboursement");
  } finally {
    try {
      session.endSession();
    } catch {}
  }
});

/* -------------------------------------------------------------------------- */
/* 4. Position du coffre                                                      */
/* -------------------------------------------------------------------------- */

/** Ouverture idempotente, à la création de la cagnotte : la devise est figée dès le premier jour. */
const openCagnotteVaultPosition = asyncHandler(async (req, res) => {
  const { Position } = models();

  try {
    const currency = assertSupportedCagnotteCurrency(req.body?.currency, process.env, "devise du coffre");
    const doc = await openPosition({
      Model: Position,
      vaultId: req.body?.vaultId,
      cagnotteId: req.body?.cagnotteId,
      currency,
    });
    return res.status(200).json({ success: true, data: positionToJSON(doc) });
  } catch (err) {
    return sendError(res, err, "ouverture-position");
  }
});

const getCagnotteVaultPosition = asyncHandler(async (req, res) => {
  const { Position } = models();
  const doc = await getPosition({ Model: Position, vaultId: req.params.vaultId });

  if (!doc) {
    return res.status(404).json({
      success: false,
      code: "VAULT_POSITION_MISSING",
      error: "Aucune position Tx-Core pour ce coffre.",
    });
  }

  return res.status(200).json({ success: true, data: positionToJSON(doc) });
});

module.exports = {
  attachCagnotteParticipant,
  quoteCagnotteParticipation,
  settleCagnotteParticipation,
  refundCagnotteParticipation,
  openCagnotteVaultPosition,
  getCagnotteVaultPosition,
  // Exportés pour les tests.
  quoteToJSON,
  settlementToJSON,
  loadParticipant,
  QUOTE_TTL_MS,
};
