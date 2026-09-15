// "use strict";

// const asyncHandler = require("express-async-handler");
// const mongoose = require("mongoose");
// const { getTxConn } = require("../config/db");
// const buildTxWalletBalanceModel = require("../models/TxWalletBalance");
// const buildCagnotteVaultWithdrawalSettlementModel = require("../models/CagnotteVaultWithdrawalSettlement");

// function normalizeCurrencyCode(raw) {
//   const s = String(raw || "").trim().toUpperCase();
//   if (!s) return "";
//   const cleaned = s.replace(/[^A-Z]/g, "");
//   if (cleaned === "US" || cleaned === "USDOLLAR") return "USD";
//   if (cleaned === "CAD" || cleaned.endsWith("CAD")) return "CAD";
//   if (cleaned === "EUR") return "EUR";
//   if (cleaned === "XOF" || cleaned.includes("CFA")) return "XOF";
//   if (cleaned === "XAF") return "XAF";
//   if (cleaned.length >= 3) return cleaned.slice(0, 3);
//   return cleaned;
// }

// function round2(n) {
//   return Math.round(Number(n || 0) * 100) / 100;
// }

// function toUserClauses(userId) {
//   const id = String(userId || "").trim();
//   if (!id) return [];

//   const clauses = [
//     { userId: id },
//     { user: id },
//     { ownerId: id },
//     { owner: id },
//   ];

//   if (mongoose.Types.ObjectId.isValid(id)) {
//     const oid = new mongoose.Types.ObjectId(id);
//     clauses.push(
//       { userId: oid },
//       { user: oid },
//       { ownerId: oid },
//       { owner: oid }
//     );
//   }

//   return clauses;
// }

// async function findWalletForUser({ TxWalletBalance, userId, currency, session }) {
//   const cur = normalizeCurrencyCode(currency);
//   return TxWalletBalance.findOne({
//     currency: cur,
//     $or: toUserClauses(userId),
//   }).session(session);
// }

// async function ensureWalletForUser({ TxWalletBalance, userId, currency, session }) {
//   let wallet = await findWalletForUser({
//     TxWalletBalance,
//     userId,
//     currency,
//     session,
//   });

//   if (wallet) return wallet;

//   const docs = await TxWalletBalance.create(
//     [
//       {
//         userId: String(userId),
//         currency: normalizeCurrencyCode(currency),
//         amount: 0,
//         availableAmount: 0,
//         reservedAmount: 0,
//         status: "ACTIVE",
//         isActive: true,
//       },
//     ],
//     { session }
//   );

//   return docs[0];
// }

// exports.settleCagnotteClosureFees = asyncHandler(async (req, res) => {
//   const txConn = getTxConn();
//   const TxWalletBalance = buildTxWalletBalanceModel(txConn);
//   const CagnotteVaultWithdrawalSettlement =
//     buildCagnotteVaultWithdrawalSettlementModel(txConn);

//   const {
//     reference,
//     idempotencyKey,
//     cagnotteId,
//     vaultId,
//     initiatedByUserId,
//     adminUserId,
//     feeCredit,
//     meta,
//   } = req.body || {};


//   const ref = String(reference || "").trim();
//   const idem = String(idempotencyKey || "").trim();
//   const cId = String(cagnotteId || "").trim();
//   const vId = String(vaultId || "").trim();
//   const initiatorId = String(initiatedByUserId || "").trim();
//   const adminId = String(adminUserId || "").trim();

//   const feeAmount = round2(feeCredit?.amount);
//   const feeCurrency = normalizeCurrencyCode(feeCredit?.currency);
//   const feeBaseAmount = round2(feeCredit?.baseAmount || 0);
//   const feeBaseCurrencyCode = normalizeCurrencyCode(feeCredit?.baseCurrencyCode);

//   if (!ref || !idem || !cId || !vId || !initiatorId || !adminId) {
//     return res.status(400).json({
//       success: false,
//       error:
//         "reference, idempotencyKey, cagnotteId, vaultId, initiatedByUserId et adminUserId sont requis.",
//     });
//   }

//   if (!feeCurrency || feeAmount <= 0) {
//     return res.status(400).json({
//       success: false,
//       error: "feeCredit.amount/feeCredit.currency invalides.",
//     });
//   }

//   const existingByReference =
//     await CagnotteVaultWithdrawalSettlement.findOne({ reference: ref }).lean();

//   if (existingByReference) {
//     return res.status(200).json({
//       success: true,
//       alreadyProcessed: true,
//       transactionId: String(existingByReference._id),
//       reference: existingByReference.reference,
//       newBalance:
//         existingByReference?.adminWalletAfter?.availableAmount ??
//         existingByReference?.adminWalletAfter?.amount ??
//         null,
//       data: existingByReference,
//     });
//   }

//   const existingByIdem =
//     await CagnotteVaultWithdrawalSettlement.findOne({
//       adminUserId: adminId,
//       idempotencyKey: idem,
//     }).lean();

//   if (existingByIdem) {
//     return res.status(200).json({
//       success: true,
//       alreadyProcessed: true,
//       transactionId: String(existingByIdem._id),
//       reference: existingByIdem.reference,
//       newBalance:
//         existingByIdem?.adminWalletAfter?.availableAmount ??
//         existingByIdem?.adminWalletAfter?.amount ??
//         null,
//       data: existingByIdem,
//     });
//   }

//   const session = await txConn.startSession();
//   let committed = false;

//   try {
//     session.startTransaction();

//     const adminWallet = await ensureWalletForUser({
//       TxWalletBalance,
//       userId: adminId,
//       currency: feeCurrency,
//       session,
//     });

//     const updatedAdminWallet = await TxWalletBalance.findOneAndUpdate(
//       { _id: adminWallet._id },
//       {
//         $inc: {
//           amount: feeAmount,
//           availableAmount: feeAmount,
//         },
//       },
//       { new: true, session }
//     );

//     if (!updatedAdminWallet) {
//       await session.abortTransaction();
//       return res.status(409).json({
//         success: false,
//         error: "Impossible de créditer le wallet admin.",
//       });
//     }

//     const settlementDocs = await CagnotteVaultWithdrawalSettlement.create(
//       [
//         {
//           reference: ref,
//           idempotencyKey: idem,
//           userId: initiatorId,
//           adminUserId: adminId,
//           vaultId: vId,
//           cagnotteId: cId,
//           cagnotteName: String(meta?.cagnotteName || "").trim(),
//           mode: "partial",
//           credit: {
//             amount: 0,
//             currency: feeCurrency,
//           },
//           feeDebit: {
//             amount: feeAmount,
//             currency: feeCurrency,
//             baseAmount: feeBaseAmount,
//             baseCurrencyCode: feeBaseCurrencyCode,
//           },
//           status: "confirmed",
//           userWalletAfter: null,
//           adminWalletAfter: {
//             walletId: String(updatedAdminWallet._id),
//             currency: updatedAdminWallet.currency,
//             amount: round2(updatedAdminWallet.amount),
//             availableAmount: round2(updatedAdminWallet.availableAmount),
//             reservedAmount: round2(updatedAdminWallet.reservedAmount || 0),
//           },
//           meta: {
//             ...(meta || {}),
//             settlementKind: "cagnotte_closure_fee_credit",
//             initiatedByUserId: initiatorId,
//           },
//         },
//       ],
//       { session }
//     );

//     const settlement = settlementDocs[0];

//     await session.commitTransaction();
//     committed = true;

//     return res.status(201).json({
//       success: true,
//       transactionId: String(settlement._id),
//       reference: settlement.reference,
//       newBalance:
//         settlement?.adminWalletAfter?.availableAmount ??
//         settlement?.adminWalletAfter?.amount ??
//         null,
//       data: settlement.toObject ? settlement.toObject() : settlement,
//     });
//   } catch (err) {
//     try {
//       if (!committed) await session.abortTransaction();
//     } catch (_) {}

//     return res.status(500).json({
//       success: false,
//       error: err?.message || "Erreur interne TX Core.",
//     });
//   } finally {
//     try {
//       session.endSession();
//     } catch (_) {}
//   }
// });








"use strict";

/**
 * ============================================================================
 * FRAIS DE CLÔTURE — CALCULÉS ICI, SUR LA POSITION DU COFFRE
 * ============================================================================
 *
 * ── Ce qui a changé le 2026-09-10 ──────────────────────────────────────────
 *
 * Le montant des frais arrivait du backend (`feeCredit.amount`), calculé là-bas
 * à 0,5 % codé en dur sur un total que le backend tenait lui-même. Tx-Core
 * encaissait ce qu'on lui annonçait, sans rien savoir du coffre.
 *
 * Désormais :
 *   · la base est le `collected` de la POSITION Tx-Core (ce qui a réellement
 *     été réglé, remboursements déduits) ;
 *   · le taux vient de la règle `CAGNOTTE_CLOSURE` du moteur de tarification —
 *     sans règle, la clôture est refusée (`PRICING_UNAVAILABLE`), jamais
 *     gratuite par défaut ;
 *   · les frais sont plafonnés au solde, débités CONDITIONNELLEMENT ;
 *   · la position est marquée close dans la même transaction : c'est ce qui
 *     autorise les retraits, et ce qui refuse toute nouvelle participation.
 *
 * Idempotent par référence : le backend dérive la référence de la cagnotte,
 * donc un rejeu ne prélève jamais deux fois.
 */

const asyncHandler = require("express-async-handler");
const { getTxConn, getUsersConn } = require("../config/db");
const buildTxSystemBalanceModel = require("../models/TxSystemBalance");
const buildCagnotteVaultWithdrawalSettlementModel = require("../models/CagnotteVaultWithdrawalSettlement");
const buildCagnotteVaultPositionModel = require("../models/CagnotteVaultPosition");
const { runWithTransaction } = require("../utils/transactionRunner");
const { canUseSharedSession } = require("../utils/sharedSession");
const {
  getTreasuryUserIdBySystemType,
  settlementObjectIdFromReference,
  postCagnotteClosureFeeEntries,
} = require("../services/ledgerService");
const { computeCagnottePricing, TX_TYPES } = require("../services/cagnotte/participationPricing");
const {
  getPosition,
  closePosition,
  debitPosition,
  positionToJSON,
  decToNumber,
  assertPositionIdentity,
} = require("../services/cagnotte/vaultPosition");
const { roundMoney } = require("../services/pricing/pricingEngine");
const logger = require("../utils/logger");

const CAGNOTTE_TREASURY_SYSTEM_TYPE = "CAGNOTTE_FEES_TREASURY";
const CAGNOTTE_TREASURY_LABEL = "Cagnotte Fees Treasury";

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
    logger.error(`[cagnotte][closure-fees] ${err?.message || err}`, { code: err?.code || null, status });
  }

  return res.status(status >= 400 && status < 600 ? status : 500).json({
    success: false,
    code: named ? err.code : "INTERNAL_ERROR",
    error: named ? err.message : "Erreur interne Tx-Core.",
    ...(err?.details ? { details: err.details } : {}),
  });
}

exports.settleCagnotteClosureFees = asyncHandler(async (req, res) => {
  const txConn = getTxConn();
  const TxSystemBalance = buildTxSystemBalanceModel(txConn);
  const CagnotteVaultWithdrawalSettlement = buildCagnotteVaultWithdrawalSettlementModel(txConn);
  const Position = buildCagnotteVaultPositionModel(txConn);

  const ref = str(req.body?.reference);
  const idem = str(req.body?.idempotencyKey);
  const cId = str(req.body?.cagnotteId);
  const vId = str(req.body?.vaultId);
  const initiatorId = str(req.body?.initiatedByUserId);

  if (!ref || !idem || !cId || !vId || !initiatorId) {
    return res.status(400).json({
      success: false,
      code: "INVALID_REQUEST",
      error: "reference, idempotencyKey, cagnotteId, vaultId et initiatedByUserId sont requis.",
    });
  }

  if (req.body?.feeCredit) {
    return res.status(410).json({
      success: false,
      code: "CLOSURE_FEE_AMOUNT_NOT_ACCEPTED",
      error:
        "Tx-Core calcule lui-même les frais de clôture sur la position du coffre ; " +
        "un montant fourni par l'appelant n'est plus accepté.",
    });
  }

  /**
   * ⚠️ REFUS EN FERMETURE QUAND AUCUNE TRANSACTION N'EST DISPONIBLE — voir la
   * justification détaillée dans `cagnotteSettlementController.js`.
   */
  if (!canUseSharedSession(getUsersConn, getTxConn)) {
    logger.error("[cagnotte][closure-fees] REFUS : session atomique indisponible", {
      reference: ref,
      consequence: "le grand livre s'écrirait hors transaction ; aucun mouvement n'a eu lieu",
    });

    return res.status(503).json({
      success: false,
      code: "ATOMIC_SESSION_UNAVAILABLE",
      error:
        "Règlement des frais de clôture refusé : les deux bases ne partagent " +
        "pas de session Mongo, le crédit de trésorerie et l'écriture au grand " +
        "livre ne peuvent donc pas être atomiques. Vérifier MONGO_SHARE_CLIENT.",
    });
  }

  const settlementId = settlementObjectIdFromReference(ref, "cagnotte.closureFee");

  const existingByReference = await CagnotteVaultWithdrawalSettlement.findOne({ reference: ref }).lean();

  if (existingByReference) {
    return res.status(200).json({
      success: true,
      alreadyProcessed: true,
      transactionId: String(existingByReference._id),
      reference: existingByReference.reference,
      data: existingByReference,
    });
  }

  let snapshot;
  let feeAmount = 0;
  let rule = null;

  try {
    snapshot = assertPositionIdentity(await getPosition({ Model: Position, vaultId: vId }), { cagnotteId: cId });

    if (snapshot.closedAt) {
      throw httpError(409, "VAULT_ALREADY_CLOSED", "Ce coffre est déjà clôturé : ses frais de clôture ont été réglés.");
    }

    const currency = snapshot.currency;
    const base = decToNumber(snapshot.collected);
    const balance = decToNumber(snapshot.balance);

    if (base > 0) {
      // Hors transaction : le moteur de prix peut lire un taux (même devise ⇒ 1).
      const pricing = await computeCagnottePricing({
        txType: TX_TYPES.CLOSURE,
        method: "INTERNAL",
        provider: "paynoval",
        amount: base,
        sourceCurrency: currency,
        targetCurrency: currency,
      });

      rule = pricing.rule;
      feeAmount = roundMoney(Math.min(pricing.fee.amount, balance), currency);
    }
  } catch (err) {
    return sendError(res, err);
  }

  const currency = snapshot.currency;
  const base = decToNumber(snapshot.collected);
  const treasuryUserId = feeAmount > 0 ? (() => {
    try {
      return getTreasuryUserIdBySystemType(CAGNOTTE_TREASURY_SYSTEM_TYPE);
    } catch {
      return null;
    }
  })() : null;

  if (feeAmount > 0 && !treasuryUserId) {
    return sendError(
      res,
      httpError(500, "TREASURY_UNCONFIGURED", "Trésorerie cagnotte non configurée (CAGNOTTE_FEES_TREASURY_USER_ID).")
    );
  }

  const session = await txConn.startSession();

  try {
    /**
     * Unité de travail rejouable : clôture de la position, débit conditionnel,
     * crédit de trésorerie, règlement et grand livre — tous sur la base
     * Transactions, aucun appel réseau, aucune réponse HTTP à l'intérieur.
     */
    const result = await runWithTransaction(session, async () => {
      const again = await CagnotteVaultWithdrawalSettlement.findOne({ reference: ref }).session(session);
      if (again) return { replay: again };

      const closed = await closePosition({ Model: Position, vaultId: vId, session });

      // La base a pu bouger entre la lecture et la clôture (crédit tardif) :
      // on refuse plutôt que de facturer sur un total périmé.
      if (roundMoney(decToNumber(closed.collected), currency) !== roundMoney(base, currency)) {
        throw httpError(409, "VAULT_POSITION_CONFLICT", "Le coffre a reçu un crédit pendant la clôture. Réessayer.");
      }

      let position = closed;
      let updatedTreasuryWallet = null;

      if (feeAmount > 0) {
        position = await debitPosition({
          Model: Position,
          vaultId: vId,
          currency,
          amount: feeAmount,
          kind: "CLOSURE_FEE",
          requireClosed: true,
          session,
        });

        const t = await TxSystemBalance.credit(treasuryUserId, CAGNOTTE_TREASURY_SYSTEM_TYPE, currency, feeAmount, {
          session,
          fullName: CAGNOTTE_TREASURY_LABEL,
          reference: ref,
          historyMetadata: { source: "settleCagnotteClosureFees", cagnotteId: cId },
        });

        updatedTreasuryWallet = t
          ? { walletId: String(t._id), currency, amount: 0, availableAmount: 0, reservedAmount: 0 }
          : null;
      }

      const settlementDocs = await CagnotteVaultWithdrawalSettlement.create(
        [
          {
            _id: settlementId,
            reference: ref,
            idempotencyKey: idem,
            userId: initiatorId,
            treasuryUserId: treasuryUserId || "",
            treasurySystemType: feeAmount > 0 ? CAGNOTTE_TREASURY_SYSTEM_TYPE : "",
            treasuryLabel: feeAmount > 0 ? CAGNOTTE_TREASURY_LABEL : "",
            vaultId: vId,
            cagnotteId: cId,
            cagnotteName: str(req.body?.cagnotteName),
            mode: "partial",
            credit: { amount: 0, currency },
            feeDebit: { amount: feeAmount, currency, baseAmount: base, baseCurrencyCode: currency },
            status: "confirmed",
            userWalletAfter: null,
            treasuryWalletAfter: updatedTreasuryWallet,
            meta: {
              settlementKind: "cagnotte_closure_fee_credit",
              initiatedByUserId: initiatorId,
              rule,
            },
          },
        ],
        { session }
      );

      /**
       * ⚠️ LE GRAND LIVRE, DANS LA MÊME TRANSACTION : les frais de clôture sont
       * prélevés SUR LE COFFRE (compensation cagnotte, devise de la cagnotte).
       */
      if (feeAmount > 0) {
        await postCagnotteClosureFeeEntries({
          settlementId: settlementDocs[0]._id,
          reference: ref,
          session,
          feeCredit: {
            treasuryUserId,
            treasurySystemType: CAGNOTTE_TREASURY_SYSTEM_TYPE,
            amount: feeAmount,
            currency,
          },
          metadata: { settlementKind: "cagnotte_closure_fee_credit", cagnotteId: cId, vaultId: vId },
        });
      }

      return { settlement: settlementDocs[0], position };
    });

    if (result.replay) {
      return res.status(200).json({ success: true, alreadyProcessed: true, data: result.replay });
    }

    return res.status(201).json({
      success: true,
      transactionId: String(result.settlement._id),
      reference: result.settlement.reference,
      data: {
        feeAmount,
        feeCurrency: currency,
        baseAmount: base,
        rule,
        position: positionToJSON(result.position),
      },
    });
  } catch (err) {
    if (err?.code === 11000) {
      const done = await CagnotteVaultWithdrawalSettlement.findOne({ reference: ref }).lean();
      if (done) return res.status(200).json({ success: true, alreadyProcessed: true, data: done });
    }
    return sendError(res, err);
  } finally {
    try {
      session.endSession();
    } catch {}
  }
});
