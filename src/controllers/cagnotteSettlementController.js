"use strict";

const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const { getTxConn } = require("../config/db");
const buildTxWalletBalanceModel = require("../models/TxWalletBalance");
const buildCagnotteSettlementModel = require("../models/CagnotteSettlement");

function normalizeCurrencyCode(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return "";
  const cleaned = s.replace(/[^A-Z]/g, "");
  if (cleaned === "US" || cleaned === "USDOLLAR") return "USD";
  if (cleaned === "CAD" || cleaned.endsWith("CAD")) return "CAD";
  if (cleaned === "EUR") return "EUR";
  if (cleaned === "XOF" || cleaned.includes("CFA")) return "XOF";
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

  wallet = await TxWalletBalance.create(
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

  return wallet[0];
}

exports.settleCagnotteParticipation = asyncHandler(async (req, res) => {
  const txConn = getTxConn();
  const TxWalletBalance = buildTxWalletBalanceModel(txConn);
  const CagnotteSettlement = buildCagnotteSettlementModel(txConn);

  const {
    reference,
    idempotencyKey,
    userId,
    adminUserId,
    payer,
    feeCredit,
    meta,
  } = req.body || {};

  const ref = String(reference || "").trim();
  const idem = String(idempotencyKey || "").trim();
  const payerId = String(userId || "").trim();
  const adminId = String(adminUserId || "").trim();

  const payerAmount = round2(payer?.amount);
  const payerCurrency = normalizeCurrencyCode(payer?.currency);
  const feeAmount = round2(feeCredit?.amount || 0);
  const feeCurrency = normalizeCurrencyCode(feeCredit?.currency);

  if (!ref || !idem || !payerId || !adminId) {
    return res.status(400).json({
      success: false,
      error: "reference, idempotencyKey, userId et adminUserId sont requis.",
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

  const existing = await CagnotteSettlement.findOne({ reference: ref }).lean();
  if (existing) {
    return res.status(200).json({
      success: true,
      alreadyProcessed: true,
      data: existing,
    });
  }

  const session = await txConn.startSession();
  let committed = false;

  try {
    session.startTransaction();

    const payerWallet = await findWalletForUser({
      TxWalletBalance,
      userId: payerId,
      currency: payerCurrency,
      session,
    });

    if (!payerWallet) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        error: `Wallet payeur introuvable en ${payerCurrency}.`,
      });
    }

    const currentAmount = round2(payerWallet.amount);
    const currentAvailable = round2(
      payerWallet.availableAmount != null
        ? payerWallet.availableAmount
        : payerWallet.amount
    );

    if (currentAmount < payerAmount || currentAvailable < payerAmount) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: "Solde insuffisant.",
        details: {
          walletCurrency: payerCurrency,
          amount: currentAmount,
          availableAmount: currentAvailable,
          required: payerAmount,
        },
      });
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
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        error: "Le wallet payeur a changé pendant le règlement. Réessaie.",
      });
    }

    let updatedAdminWallet = null;

    if (feeAmount > 0) {
      const adminWallet = await ensureWalletForUser({
        TxWalletBalance,
        userId: adminId,
        currency: feeCurrency,
        session,
      });

      updatedAdminWallet = await TxWalletBalance.findOneAndUpdate(
        { _id: adminWallet._id },
        {
          $inc: {
            amount: feeAmount,
            availableAmount: feeAmount,
          },
        },
        { new: true, session }
      );
    }

    const settlementDocs = await CagnotteSettlement.create(
      [
        {
          reference: ref,
          idempotencyKey: idem,
          userId: payerId,
          adminUserId: adminId,
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
          adminWalletAfter: updatedAdminWallet
            ? {
                walletId: String(updatedAdminWallet._id),
                currency: updatedAdminWallet.currency,
                amount: round2(updatedAdminWallet.amount),
                availableAmount: round2(updatedAdminWallet.availableAmount),
                reservedAmount: round2(updatedAdminWallet.reservedAmount || 0),
              }
            : null,
          meta: meta || {},
        },
      ],
      { session }
    );

    const settlement = settlementDocs[0];

    await session.commitTransaction();
    committed = true;

    return res.status(201).json({
      success: true,
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