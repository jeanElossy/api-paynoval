"use strict";

/**
 * ============================================================================
 * RÈGLEMENT D'UNE PARTICIPATION PAR LIEN PUBLIC — LE PAYEUR N'A PAS DE COMPTE
 * ============================================================================
 *
 * Jumeau externe de `cagnotteSettlementController.js` : même poseur de lots,
 * même position de coffre, même moteur de prix. UNE différence : l'origine des
 * fonds est l'entrée prestataire du rail, pas un portefeuille.
 *
 * ── Ce qui a changé le 2026-09-10 ──────────────────────────────────────────
 *
 *   · Les FRAIS et la CONVERSION sont calculés ICI (`PricingRule`), et non plus
 *     reçus du backend. Celui-ci ne transmet que ce que le prestataire a
 *     encaissé — montant et devise, lus sur le rappel signé.
 *   · Le coffre est crédité dans la devise de la CAGNOTTE, via la position de
 *     change si l'invité a payé dans une autre devise (R-16).
 *   · L'ancienne écriture portait un type (`SYSTEM_TRANSFER`) absent de
 *     l'énumération de `LedgerEntry` : chaque règlement invité échouait à
 *     l'insertion. Le type est désormais déclaré, et le lot est construit par
 *     le module pur prouvé corridor par corridor.
 *
 * ── Un encaissement n'est JAMAIS refusé pour « objectif atteint » ──────────
 *
 * L'argent est déjà prélevé chez le payeur : refuser le règlement le laisserait
 * encaissé et non crédité. Le contrôle d'objectif et de statut appartient à
 * l'initiation (`/collections/initiate`) ; ici on crédite, et un crédit arrivé
 * après la clôture est marqué `lateCredit` pour l'exploitation.
 *
 * ── Ce qu'il ne fait PAS ────────────────────────────────────────────────────
 *
 * Il ne vérifie aucune signature : il est appelé APRÈS l'authentification du
 * rappel, par le backend, jeton interne à l'appui. Il n'enregistre aucune
 * donnée personnelle du payeur (règle B.4) — `providerReference` suffit au
 * rapprochement.
 */

const asyncHandler = require("express-async-handler");

const { getTxConn, getUsersConn } = require("../config/db");
const buildTxSystemBalanceModel = require("../models/TxSystemBalance");
const buildCagnotteExternalSettlementModel = require("../models/CagnotteExternalSettlement");
const buildCagnotteVaultPositionModel = require("../models/CagnotteVaultPosition");
const { runWithTransaction } = require("../utils/transactionRunner");
const { canUseSharedSession } = require("../utils/sharedSession");
const {
  settlementObjectIdFromReference,
  postCagnotteLotEntries,
  getTreasuryUserIdBySystemType,
} = require("../services/ledgerService");
const { buildCagnotteCreditLots } = require("../services/ledger/cagnotteLegs");
const { computeCagnottePricing, TX_TYPES } = require("../services/cagnotte/participationPricing");
const { assertSupportedCagnotteCurrency } = require("../services/cagnotte/currencies");
const { openPosition, creditPosition, positionToJSON } = require("../services/cagnotte/vaultPosition");
const logger = require("../utils/logger");

const CAGNOTTE_FEES = "CAGNOTTE_FEES_TREASURY";
const FX_MARGIN = "FX_MARGIN_TREASURY";

/** Rails autorisés. Table CLOSE — alignée sur `CagnotteExternalSettlement`. */
const RAILS = Object.freeze({
  mobilemoney: Object.freeze(["wave", "orange", "mtn", "moov"]),
  card: Object.freeze(["visa_direct"]),
});

function low(v) {
  return String(v || "").trim().toLowerCase();
}

function str(v) {
  return String(v ?? "").trim();
}

function httpError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function sendError(res, err) {
  const status = Number(err?.statusCode || err?.status || 500);
  const named = Boolean(err?.code) && typeof err.code === "string";

  if (!named || status >= 500) {
    logger.error(`[cagnotte][participation-externe] ${err?.message || err}`, {
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

function treasuryFor(systemType) {
  try {
    return { userId: getTreasuryUserIdBySystemType(systemType), systemType };
  } catch {
    throw httpError(
      500,
      "TREASURY_UNCONFIGURED",
      `Trésorerie ${systemType} non configurée : des fonds sans compte de destination ` +
        "ne s'encaissent pas « quelque part »."
    );
  }
}

/**
 * POST /api/v1/cagnotte/external-participation/settle
 *
 *   reference          identifiant PayNoval du règlement (unique, dérive le _id)
 *   idempotencyKey     clé du rappel
 *   rail, provider     table close
 *   providerReference  clé de rapprochement prestataire
 *   cagnotteId, vaultId, cagnotteCurrency
 *   collected          { amount, currency }  ce que le prestataire a encaissé
 */
const settleExternalParticipation = asyncHandler(async (req, res) => {
  const txConn = getTxConn();
  const TxSystemBalance = buildTxSystemBalanceModel(txConn);
  const Settlement = buildCagnotteExternalSettlementModel(txConn);
  const Position = buildCagnotteVaultPositionModel(txConn);

  const ref = str(req.body?.reference);
  const idem = str(req.body?.idempotencyKey);
  const rail = low(req.body?.rail);
  const provider = low(req.body?.provider).replace(/-/g, "_");
  const providerReference = str(req.body?.providerReference);
  const cagnotteId = str(req.body?.cagnotteId);
  const vaultId = str(req.body?.vaultId);
  const collectedAmount = Number(req.body?.collected?.amount);

  let source;
  let target;

  try {
    if (!ref || !idem || !cagnotteId || !vaultId) {
      throw httpError(400, "INVALID_REQUEST", "reference, idempotencyKey, cagnotteId et vaultId sont requis.");
    }

    if (!RAILS[rail]) {
      throw httpError(
        400,
        "UNKNOWN_RAIL",
        `Rail « ${req.body?.rail} » inconnu. Le rail décide du compte de compensation ` +
          "d'entrée, donc du relevé auquel ce règlement sera rapproché.",
        { accepted: Object.keys(RAILS) }
      );
    }

    if (!RAILS[rail].includes(provider)) {
      throw httpError(400, "UNKNOWN_PROVIDER", `Opérateur « ${req.body?.provider} » inconnu sur le rail ${rail}.`, {
        accepted: RAILS[rail],
      });
    }

    if (!Number.isFinite(collectedAmount) || collectedAmount <= 0) {
      throw httpError(400, "INVALID_AMOUNT", "collected.amount doit être positif.");
    }

    source = assertSupportedCagnotteCurrency(req.body?.collected?.currency, process.env, "devise encaissée");
    target = assertSupportedCagnotteCurrency(req.body?.cagnotteCurrency, process.env, "devise de la cagnotte");
  } catch (err) {
    return sendError(res, err);
  }

  /**
   * ⚠️ REFUS EN FERMETURE SANS SESSION ATOMIQUE : sans elle, les écritures
   * partiraient hors de la transaction qui porte le crédit de position et de
   * trésorerie. Un grand livre faux est pire qu'un grand livre absent.
   */
  if (!canUseSharedSession(getUsersConn, getTxConn)) {
    logger.error("[cagnotte][participation-externe] REFUS : session atomique indisponible", {
      reference: ref,
      rail,
      provider,
      consequence: "le grand livre s'écrirait hors transaction ; aucun mouvement n'a eu lieu",
    });

    return res.status(503).json({
      success: false,
      code: "ATOMIC_SESSION_UNAVAILABLE",
      error:
        "Règlement refusé : les deux bases ne partagent pas de session Mongo, " +
        "l'écriture au grand livre et le crédit du coffre ne peuvent donc pas " +
        "être atomiques. Vérifier MONGO_SHARE_CLIENT.",
    });
  }

  const settlementId = settlementObjectIdFromReference(ref, "cagnotte.participation.external");

  const existing = await Settlement.findOne({ reference: ref }).lean();
  if (existing) {
    return res.status(200).json({ success: true, alreadyProcessed: true, data: existing });
  }

  let pricing;
  let lots;
  let feesTreasury = null;
  let fxMarginTreasury = null;

  try {
    // Hors transaction : ouverture idempotente et prix (réseau possible).
    await openPosition({ Model: Position, vaultId, cagnotteId, currency: target });

    pricing = await computeCagnottePricing({
      txType: TX_TYPES.PARTICIPATION,
      method: rail === "card" ? "CARD" : "MOBILEMONEY",
      provider,
      amount: collectedAmount,
      sourceCurrency: source,
      targetCurrency: target,
      country: str(req.body?.country) || null,
      requestId: ref,
    });

    if (pricing.fee.amount > 0) feesTreasury = treasuryFor(CAGNOTTE_FEES);
    if (pricing.fx.revenue.amount > 0) fxMarginTreasury = treasuryFor(FX_MARGIN);

    lots = buildCagnotteCreditLots({
      origin: { kind: "PROVIDER_INBOUND", rail },
      sourceCurrency: source,
      targetCurrency: target,
      gross: pricing.source.amount,
      fee: pricing.fee.amount,
      netSource: pricing.netSource,
      netTarget: pricing.destination.amount,
      fxRevenue: pricing.fx.revenue.amount,
      feesTreasury,
      fxMarginTreasury,
    });
  } catch (err) {
    /**
     * L'argent est encaissé chez le prestataire mais pas encore crédité : c'est
     * un écart à rattraper, pas un détail. Le backend rend une erreur au
     * prestataire, qui réémettra le rappel — le règlement est idempotent.
     */
    logger.error("[cagnotte][participation-externe] prix ou position indisponible — encaissement NON crédité", {
      reference: ref,
      code: err?.code || null,
    });
    return sendError(res, err);
  }

  const session = await txConn.startSession();

  try {
    const result = await runWithTransaction(session, async () => {
      const again = await Settlement.findOne({ reference: ref }).session(session);
      if (again) return { replay: again };

      const position = await creditPosition({
        Model: Position,
        vaultId,
        currency: target,
        amount: pricing.destination.amount,
        goalCap: null,
        allowClosed: true,
        session,
      });

      let treasuryWalletAfter = null;

      if (feesTreasury) {
        const t = await TxSystemBalance.credit(feesTreasury.userId, CAGNOTTE_FEES, source, pricing.fee.amount, {
          session,
          reference: ref,
          historyMetadata: { source: "settleExternalParticipation", cagnotteId },
        });
        treasuryWalletAfter = { walletId: String(t?._id || ""), systemType: CAGNOTTE_FEES, currency: source };
      }

      if (fxMarginTreasury) {
        await TxSystemBalance.credit(fxMarginTreasury.userId, FX_MARGIN, target, pricing.fx.revenue.amount, {
          session,
          reference: ref,
          historyMetadata: { source: "settleExternalParticipation", cagnotteId },
        });
      }

      const [settlement] = await Settlement.create(
        [
          {
            _id: settlementId,
            reference: ref,
            idempotencyKey: idem,
            rail,
            provider,
            providerReference,
            cagnotteId,
            vaultId,
            collected: { amount: pricing.source.amount, currency: source },
            feeCredit: { amount: pricing.fee.amount, currency: pricing.fee.amount > 0 ? source : "" },
            netToVault: { amount: pricing.destination.amount, currency: target },
            treasuryUserId: feesTreasury?.userId || "",
            treasurySystemType: feesTreasury ? CAGNOTTE_FEES : "",
            treasuryLabel: feesTreasury ? "Cagnotte Fees Treasury" : "",
            status: "confirmed",
            treasuryWalletAfter,
            meta: { settlementKind: "cagnotte_external_participation_settlement" },
            schemaVersion: 2,
            netSource: pricing.netSource,
            fx: {
              required: pricing.fx.required,
              appliedRate: pricing.fx.appliedRate,
              marketRate: pricing.fx.marketRate,
              revenue: pricing.fx.revenue.amount,
              provider: pricing.fx.provider,
              rateSource: pricing.fx.rateSource,
              asOf: pricing.fx.asOf,
            },
            lateCredit: Boolean(position.closedAt),
          },
        ],
        { session }
      );

      /**
       * ⚠️ LE GRAND LIVRE, DANS LA MÊME TRANSACTION, AVEC LA SESSION.
       */
      await postCagnotteLotEntries({
        settlementId: settlement._id,
        reference: ref,
        lots,
        session,
        metadata: {
          settlementKind: "cagnotte_external_participation_settlement",
          cagnotteId,
          vaultId,
          provider,
          providerReference: providerReference || null,
        },
      });

      return { settlement, position };
    });

    if (result.replay) {
      return res.status(200).json({ success: true, alreadyProcessed: true, data: result.replay });
    }

    if (result.settlement.lateCredit) {
      logger.warn("[cagnotte][participation-externe] crédit arrivé APRÈS la clôture", {
        reference: ref,
        cagnotteId,
        vaultId,
        consequence: "coffre crédité après le calcul des frais de clôture ; retrait complémentaire possible",
      });
    }

    return res.status(201).json({
      success: true,
      data: {
        ...(result.settlement.toObject ? result.settlement.toObject() : result.settlement),
        position: positionToJSON(result.position),
      },
    });
  } catch (err) {
    if (err?.code === 11000) {
      const done = await Settlement.findOne({ reference: ref }).lean();
      if (done) return res.status(200).json({ success: true, alreadyProcessed: true, data: done });
    }
    return sendError(res, err);
  } finally {
    try {
      session.endSession();
    } catch {}
  }
});

/**
 * POST /api/v1/cagnotte/external-participation/quote
 *
 * Devis INDICATIF montré à l'invité avant qu'il paie : même moteur, mêmes
 * règles que le règlement. Rien n'est figé ni écrit — le règlement recalcule
 * au rappel prestataire, car c'est alors seulement que le montant encaissé est
 * connu. Aucune donnée du payeur n'est reçue ici.
 */
const quoteExternalParticipation = asyncHandler(async (req, res) => {
  const rail = low(req.body?.rail);
  const provider = low(req.body?.provider).replace(/-/g, "_");

  try {
    if (!RAILS[rail] || !RAILS[rail].includes(provider)) {
      throw httpError(400, "UNKNOWN_PROVIDER", "Rail ou opérateur inconnu.", { accepted: RAILS });
    }

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, "INVALID_AMOUNT", "Montant invalide.");

    const target = assertSupportedCagnotteCurrency(req.body?.cagnotteCurrency, process.env, "devise de la cagnotte");
    const source = assertSupportedCagnotteCurrency(req.body?.currency || target, process.env, "devise du paiement");

    const pricing = await computeCagnottePricing({
      txType: TX_TYPES.PARTICIPATION,
      method: rail === "card" ? "CARD" : "MOBILEMONEY",
      provider,
      amount,
      sourceCurrency: source,
      targetCurrency: target,
    });

    return res.status(200).json({
      success: true,
      data: {
        source: pricing.source,
        fee: pricing.fee,
        netSource: pricing.netSource,
        fx: pricing.fx.required
          ? { required: true, rate: pricing.fx.appliedRate, marketRate: pricing.fx.marketRate, provider: pricing.fx.provider, timestamp: pricing.fx.asOf }
          : { required: false },
        destination: pricing.destination,
      },
    });
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = {
  settleExternalParticipation,
  quoteExternalParticipation,
  RAILS,
};
