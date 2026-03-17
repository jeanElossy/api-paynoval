"use strict";

const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const { getTxConn } = require("../config/db");
const buildTxWalletBalanceModel = require("../models/TxWalletBalance");
const buildCagnotteVaultWithdrawalSettlementModel = require("../models/CagnotteVaultWithdrawalSettlement");

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

async function findWalletForUser({ TxWalletBalance, userId, currency, session }) {
  const cur = normalizeCurrencyCode(currency);
  return TxWalletBalance.findOne({
    currency: cur,
    $or: toUserClauses(userId),
  }).session(session);
}

async function ensureWalletForUser({ TxWalletBalance, userId, currency, session }) {
  let wallet = await findWalletForUser({
    TxWalletBalance,
    userId,
    currency,
    session,
  });

  if (wallet) return wallet;

  const docs = await TxWalletBalance.create(
    [
      {
        userId: String(userId),
        currency: normalizeCurrencyCode(currency),
        amount: 0,
        availableAmount: 0,
        reservedAmount: 0,
        status: "ACTIVE",
        isActive: true,
      },
    ],
    { session }
  );

  return docs[0];
}

exports.settleCagnotteClosureFees = asyncHandler(async (req, res) => {
  const txConn = getTxConn();
  const TxWalletBalance = buildTxWalletBalanceModel(txConn);
  const CagnotteVaultWithdrawalSettlement =
    buildCagnotteVaultWithdrawalSettlementModel(txConn);

  const {
    reference,
    idempotencyKey,
    cagnotteId,
    vaultId,
    initiatedByUserId,
    adminUserId,
    feeCredit,
    meta,
  } = req.body || {};

  const ref = String(reference || "").trim();
  const idem = String(idempotencyKey || "").trim();
  const cId = String(cagnotteId || "").trim();
  const vId = String(vaultId || "").trim();
  const initiatorId = String(initiatedByUserId || "").trim();
  const adminId = String(adminUserId || "").trim();

  const feeAmount = round2(feeCredit?.amount);
  const feeCurrency = normalizeCurrencyCode(feeCredit?.currency);
  const feeBaseAmount = round2(feeCredit?.baseAmount || 0);
  const feeBaseCurrencyCode = normalizeCurrencyCode(feeCredit?.baseCurrencyCode);

  if (!ref || !idem || !cId || !vId || !initiatorId || !adminId) {
    return res.status(400).json({
      success: false,
      error:
        "reference, idempotencyKey, cagnotteId, vaultId, initiatedByUserId et adminUserId sont requis.",
    });
  }

  if (!feeCurrency || feeAmount <= 0) {
    return res.status(400).json({
      success: false,
      error: "feeCredit.amount/feeCredit.currency invalides.",
    });
  }

  const existingByReference =
    await CagnotteVaultWithdrawalSettlement.findOne({ reference: ref }).lean();

  if (existingByReference) {
    return res.status(200).json({
      success: true,
      alreadyProcessed: true,
      transactionId: String(existingByReference._id),
      reference: existingByReference.reference,
      newBalance:
        existingByReference?.adminWalletAfter?.availableAmount ??
        existingByReference?.adminWalletAfter?.amount ??
        null,
      data: existingByReference,
    });
  }

  const existingByIdem =
    await CagnotteVaultWithdrawalSettlement.findOne({
      adminUserId: adminId,
      idempotencyKey: idem,
    }).lean();

  if (existingByIdem) {
    return res.status(200).json({
      success: true,
      alreadyProcessed: true,
      transactionId: String(existingByIdem._id),
      reference: existingByIdem.reference,
      newBalance:
        existingByIdem?.adminWalletAfter?.availableAmount ??
        existingByIdem?.adminWalletAfter?.amount ??
        null,
      data: existingByIdem,
    });
  }

  const session = await txConn.startSession();
  let committed = false;

  try {
    session.startTransaction();

    const adminWallet = await ensureWalletForUser({
      TxWalletBalance,
      userId: adminId,
      currency: feeCurrency,
      session,
    });

    const updatedAdminWallet = await TxWalletBalance.findOneAndUpdate(
      { _id: adminWallet._id },
      {
        $inc: {
          amount: feeAmount,
          availableAmount: feeAmount,
        },
      },
      { new: true, session }
    );

    if (!updatedAdminWallet) {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        error: "Impossible de créditer le wallet admin.",
      });
    }

    const settlementDocs = await CagnotteVaultWithdrawalSettlement.create(
      [
        {
          reference: ref,
          idempotencyKey: idem,
          userId: initiatorId,
          adminUserId: adminId,
          vaultId: vId,
          cagnotteId: cId,
          cagnotteName: String(meta?.cagnotteName || "").trim(),
          mode: "partial",
          credit: {
            amount: 0,
            currency: feeCurrency,
          },
          feeDebit: {
            amount: feeAmount,
            currency: feeCurrency,
            baseAmount: feeBaseAmount,
            baseCurrencyCode: feeBaseCurrencyCode,
          },
          status: "confirmed",
          userWalletAfter: null,
          adminWalletAfter: {
            walletId: String(updatedAdminWallet._id),
            currency: updatedAdminWallet.currency,
            amount: round2(updatedAdminWallet.amount),
            availableAmount: round2(updatedAdminWallet.availableAmount),
            reservedAmount: round2(updatedAdminWallet.reservedAmount || 0),
          },
          meta: {
            ...(meta || {}),
            settlementKind: "cagnotte_closure_fee_credit",
            initiatedByUserId: initiatorId,
          },
        },
      ],
      { session }
    );

    const settlement = settlementDocs[0];

    await session.commitTransaction();
    committed = true;

    return res.status(201).json({
      success: true,
      transactionId: String(settlement._id),
      reference: settlement.reference,
      newBalance:
        settlement?.adminWalletAfter?.availableAmount ??
        settlement?.adminWalletAfter?.amount ??
        null,
      data: settlement.toObject ? settlement.toObject() : settlement,
    });
  } catch (err) {
    try {
      if (!committed) await session.abortTransaction();
    } catch (_) {}

    return res.status(500).json({
      success: false,
      error: err?.message || "Erreur interne TX Core.",
    });
  } finally {
    try {
      session.endSession();
    } catch (_) {}
  }
});