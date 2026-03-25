"use strict";

const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const { getTxConn } = require("../config/db");
const buildTxWalletBalanceModel = require("../models/TxWalletBalance");
const buildTxSystemBalanceModel = require("../models/TxSystemBalance");
const buildCagnotteSettlementModel = require("../models/CagnotteSettlement");
const {
  resolveTreasuryFromSystemType,
  normalizeTreasurySystemType,
} = require("../services/ledgerService");

const CAGNOTTE_TREASURY_SYSTEM_TYPE = "CAGNOTTE_FEES_TREASURY";
const CAGNOTTE_TREASURY_LABEL = "Cagnotte Fees Treasury";

function normalizeCurrencyCode(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return "";
  const cleaned = s.replace(/[^A-Z]/g, "");
  if (cleaned === "US" || cleaned === "USDOLLAR") return "USD";
  if (cleaned === "CAD" || cleaned.endsWith("CAD")) return "CAD";
  if (cleaned === "EUR") return "EUR";
  if (cleaned === "XOF" || cleaned.includes("CFA")) return "XOF";
  if (cleaned === "XAF") return "XAF";
  if (cleaned.length >= 3) return cleaned.slice(0, 3);
  return cleaned;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function toUserClauses(userId) {
  const id = String(userId || "").trim();
  if (!id) return [];

  const clauses = [
    { userId: id },
    { user: id },
    { ownerId: id },
    { owner: id },
  ];

  if (mongoose.Types.ObjectId.isValid(id)) {
    const oid = new mongoose.Types.ObjectId(id);
    clauses.push(
      { userId: oid },
      { user: oid },
      { ownerId: oid },
      { owner: oid }
    );
  }

  return clauses;
}

function isRetryableMongoTxError(err) {
  const msg = String(err?.message || "").toLowerCase();

  if (Array.isArray(err?.errorLabels)) {
    if (err.errorLabels.includes("TransientTransactionError")) return true;
    if (err.errorLabels.includes("UnknownTransactionCommitResult")) return true;
  }

  return (
    msg.includes("please retry the operation") ||
    msg.includes("please retry your operation") ||
    msg.includes("multi-document transaction") ||
    msg.includes("transienttransactionerror") ||
    msg.includes("unknowntransactioncommitresult") ||
    msg.includes("unable to write to collection") ||
    msg.includes("due to catalog changes")
  );
}

async function runWithMongoTxRetry(work, { retries = 3, backoffMs = 150 } = {}) {
  let lastErr = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await work(attempt);
    } catch (err) {
      lastErr = err;

      if (!isRetryableMongoTxError(err) || attempt >= retries) {
        throw err;
      }

      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }

  throw lastErr;
}

async function findUserWallet({ TxWalletBalance, userId, currency, session }) {
  const cur = normalizeCurrencyCode(currency);
  return TxWalletBalance.findOne({
    currency: cur,
    $or: toUserClauses(userId),
  }).session(session);
}

function resolveCagnotteTreasuryMeta(input = {}) {
  const treasurySystemType = normalizeTreasurySystemType(
    input.treasurySystemType || CAGNOTTE_TREASURY_SYSTEM_TYPE
  );

  if (treasurySystemType !== CAGNOTTE_TREASURY_SYSTEM_TYPE) {
    throw new Error('treasurySystemType doit être "CAGNOTTE_FEES_TREASURY".');
  }

  const treasuryUserId = String(
    input.treasuryUserId || resolveTreasuryFromSystemType(treasurySystemType) || ""
  ).trim();

  if (!treasuryUserId) {
    throw new Error(
      "Aucun treasuryUserId configuré pour CAGNOTTE_FEES_TREASURY."
    );
  }

  return {
    treasuryUserId,
    treasurySystemType,
    treasuryLabel: String(input.treasuryLabel || CAGNOTTE_TREASURY_LABEL).trim(),
  };
}

async function creditTreasurySystemWallet({
  TxSystemBalance,
  treasuryUserId,
  treasurySystemType,
  treasuryLabel,
  currency,
  amount,
  session,
}) {
  const cur = normalizeCurrencyCode(currency);
  const amt = round2(amount);

  const updated = await TxSystemBalance.credit(
    treasuryUserId,
    treasurySystemType,
    cur,
    amt,
    {
      session,
      fullName: treasuryLabel,
      historyMetadata: {
        source: "settleCagnotteParticipation",
        treasurySystemType,
      },
    }
  );

  const currentBalance = round2(updated?.balances?.[cur] || 0);

  return {
    walletId: String(updated._id),
    currency: cur,
    amount: currentBalance,
    availableAmount: currentBalance,
    reservedAmount: 0,
    balances: updated?.balances || {},
    systemType: updated?.systemType || treasurySystemType,
  };
}

exports.settleCagnotteParticipation = asyncHandler(async (req, res) => {
  const txConn = getTxConn();
  const TxWalletBalance = buildTxWalletBalanceModel(txConn);
  const TxSystemBalance = buildTxSystemBalanceModel(txConn);
  const CagnotteSettlement = buildCagnotteSettlementModel(txConn);

  const {
    reference,
    idempotencyKey,
    userId,
    treasuryUserId,
    treasurySystemType,
    treasuryLabel,
    payer,
    feeCredit,
    meta,
  } = req.body || {};

  const ref = String(reference || "").trim();
  const idem = String(idempotencyKey || "").trim();
  const payerId = String(userId || "").trim();

  const payerAmount = round2(payer?.amount);
  const payerCurrency = normalizeCurrencyCode(payer?.currency);
  const feeAmount = round2(feeCredit?.amount || 0);
  const feeCurrency = normalizeCurrencyCode(feeCredit?.currency);

  if (!ref || !idem || !payerId) {
    return res.status(400).json({
      success: false,
      error: "reference, idempotencyKey et userId sont requis.",
    });
  }

  if (!payerCurrency || payerAmount <= 0) {
    return res.status(400).json({
      success: false,
      error: "payer.amount/payer.currency invalides.",
    });
  }

  if (feeAmount > 0 && !feeCurrency) {
    return res.status(400).json({
      success: false,
      error: "feeCredit.currency est requis si feeCredit.amount > 0.",
    });
  }

  let treasuryMeta = null;
  try {
    treasuryMeta =
      feeAmount > 0
        ? resolveCagnotteTreasuryMeta({
            treasuryUserId,
            treasurySystemType,
            treasuryLabel,
          })
        : null;
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }

  const existing = await CagnotteSettlement.findOne({ reference: ref }).lean();
  if (existing) {
    return res.status(200).json({
      success: true,
      alreadyProcessed: true,
      data: existing,
    });
  }

  const result = await runWithMongoTxRetry(
    async () => {
      const session = await txConn.startSession();
      let committed = false;

      try {
        session.startTransaction();

        const existingInTx = await CagnotteSettlement.findOne({
          reference: ref,
        }).session(session);

        if (existingInTx) {
          try {
            await session.abortTransaction();
          } catch {}

          return {
            statusCode: 200,
            body: {
              success: true,
              alreadyProcessed: true,
              data: existingInTx.toObject ? existingInTx.toObject() : existingInTx,
            },
          };
        }

        const payerWallet = await findUserWallet({
          TxWalletBalance,
          userId: payerId,
          currency: payerCurrency,
          session,
        });

        if (!payerWallet) {
          try {
            await session.abortTransaction();
          } catch {}

          return {
            statusCode: 404,
            body: {
              success: false,
              error: `Wallet payeur introuvable en ${payerCurrency}.`,
            },
          };
        }

        const currentAmount = round2(payerWallet.amount);
        const currentAvailable = round2(
          payerWallet.availableAmount != null
            ? payerWallet.availableAmount
            : payerWallet.amount
        );

        if (currentAmount < payerAmount || currentAvailable < payerAmount) {
          try {
            await session.abortTransaction();
          } catch {}

          return {
            statusCode: 400,
            body: {
              success: false,
              error: "Solde insuffisant.",
              details: {
                walletCurrency: payerCurrency,
                amount: currentAmount,
                availableAmount: currentAvailable,
                required: payerAmount,
              },
            },
          };
        }

        const updatedPayerWallet = await TxWalletBalance.findOneAndUpdate(
          {
            _id: payerWallet._id,
            amount: { $gte: payerAmount },
            availableAmount: { $gte: payerAmount },
          },
          {
            $inc: {
              amount: -payerAmount,
              availableAmount: -payerAmount,
            },
          },
          { new: true, session }
        );

        if (!updatedPayerWallet) {
          try {
            await session.abortTransaction();
          } catch {}

          return {
            statusCode: 409,
            body: {
              success: false,
              error: "Le wallet payeur a changé pendant le règlement. Réessaie.",
            },
          };
        }

        let updatedTreasuryWallet = null;

        if (feeAmount > 0) {
          updatedTreasuryWallet = await creditTreasurySystemWallet({
            TxSystemBalance,
            treasuryUserId: treasuryMeta.treasuryUserId,
            treasurySystemType: treasuryMeta.treasurySystemType,
            treasuryLabel: treasuryMeta.treasuryLabel,
            currency: feeCurrency,
            amount: feeAmount,
            session,
          });
        }

        const settlementDocs = await CagnotteSettlement.create(
          [
            {
              reference: ref,
              idempotencyKey: idem,
              userId: payerId,
              treasuryUserId: treasuryMeta?.treasuryUserId || undefined,
              treasurySystemType: treasuryMeta?.treasurySystemType || undefined,
              treasuryLabel: treasuryMeta?.treasuryLabel || undefined,
              payer: {
                amount: payerAmount,
                currency: payerCurrency,
              },
              feeCredit: {
                amount: feeAmount,
                currency: feeCurrency || undefined,
                baseAmount: round2(feeCredit?.baseAmount || 0),
                baseCurrencyCode: normalizeCurrencyCode(
                  feeCredit?.baseCurrencyCode
                ),
              },
              status: "confirmed",
              payerWalletAfter: {
                walletId: String(updatedPayerWallet._id),
                currency: updatedPayerWallet.currency,
                amount: round2(updatedPayerWallet.amount),
                availableAmount: round2(updatedPayerWallet.availableAmount),
                reservedAmount: round2(updatedPayerWallet.reservedAmount || 0),
              },
              treasuryWalletAfter: updatedTreasuryWallet,
              meta: {
                ...(meta || {}),
                settlementKind: "cagnotte_participation_settlement",
                walletSeparation: {
                  payerWalletModel: "TxWalletBalance",
                  treasuryWalletModel: "TxSystemBalance",
                },
              },
            },
          ],
          { session }
        );

        const settlement = settlementDocs[0];

        await session.commitTransaction();
        committed = true;

        return {
          statusCode: 201,
          body: {
            success: true,
            data: settlement.toObject ? settlement.toObject() : settlement,
          },
        };
      } catch (err) {
        try {
          if (!committed) await session.abortTransaction();
        } catch {}
        throw err;
      } finally {
        try {
          session.endSession();
        } catch {}
      }
    },
    { retries: 3, backoffMs: 150 }
  );

  return res.status(result.statusCode).json(result.body);
});