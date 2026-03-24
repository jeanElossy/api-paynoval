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


// exports.settleCagnotteVaultWithdrawal = asyncHandler(async (req, res) => {
//   const txConn = getTxConn();
//   const TxWalletBalance = buildTxWalletBalanceModel(txConn);
//   const CagnotteVaultWithdrawalSettlement =
//     buildCagnotteVaultWithdrawalSettlementModel(txConn);

//   const {
//     reference,
//     idempotencyKey,
//     userId,
//     adminUserId,
//     vaultId,
//     cagnotteId,
//     cagnotteName,
//     mode,
//     credit,
//     feeDebit,
//     meta,
//   } = req.body || {};

//   const ref = String(reference || "").trim();
//   const idem = String(idempotencyKey || "").trim();
//   const beneficiaryUserId = String(userId || "").trim();
//   const adminId = String(adminUserId || "").trim();
//   const vId = String(vaultId || "").trim();
//   const cId = String(cagnotteId || "").trim();
//   const m = String(mode || "").trim().toLowerCase();

//   const creditAmount = round2(credit?.amount);
//   const creditCurrency = normalizeCurrencyCode(credit?.currency);

//   const feeAmount = round2(feeDebit?.amount || 0);
//   const feeCurrency = normalizeCurrencyCode(feeDebit?.currency);

//   if (!ref || !idem || !beneficiaryUserId || !vId || !cId) {
//     return res.status(400).json({
//       success: false,
//       error:
//         "reference, idempotencyKey, userId, vaultId et cagnotteId sont requis.",
//     });
//   }

//   if (!["full", "partial"].includes(m)) {
//     return res.status(400).json({
//       success: false,
//       error: "mode invalide. Valeurs autorisées: full, partial.",
//     });
//   }

//   if (!creditCurrency || creditAmount <= 0) {
//     return res.status(400).json({
//       success: false,
//       error: "credit.amount/credit.currency invalides.",
//     });
//   }

//   if (feeAmount > 0 && !feeCurrency) {
//     return res.status(400).json({
//       success: false,
//       error: "feeDebit.currency est requis si feeDebit.amount > 0.",
//     });
//   }

//   if (feeAmount > creditAmount) {
//     return res.status(400).json({
//       success: false,
//       error: "feeDebit.amount ne peut pas dépasser credit.amount.",
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
//         existingByReference?.userWalletAfter?.availableAmount ??
//         existingByReference?.userWalletAfter?.amount ??
//         null,
//       data: existingByReference,
//     });
//   }

//   const existingByIdem =
//     await CagnotteVaultWithdrawalSettlement.findOne({
//       userId: beneficiaryUserId,
//       idempotencyKey: idem,
//     }).lean();

//   if (existingByIdem) {
//     return res.status(200).json({
//       success: true,
//       alreadyProcessed: true,
//       transactionId: String(existingByIdem._id),
//       reference: existingByIdem.reference,
//       newBalance:
//         existingByIdem?.userWalletAfter?.availableAmount ??
//         existingByIdem?.userWalletAfter?.amount ??
//         null,
//       data: existingByIdem,
//     });
//   }

//   const session = await txConn.startSession();
//   let committed = false;

//   try {
//     session.startTransaction();

//     // 1) Créditer wallet utilisateur
//     const userWallet = await ensureWalletForUser({
//       TxWalletBalance,
//       userId: beneficiaryUserId,
//       currency: creditCurrency,
//       session,
//     });

//     const updatedUserWallet = await TxWalletBalance.findOneAndUpdate(
//       { _id: userWallet._id },
//       {
//         $inc: {
//           amount: creditAmount,
//           availableAmount: creditAmount,
//         },
//       },
//       { new: true, session }
//     );

//     if (!updatedUserWallet) {
//       await session.abortTransaction();
//       return res.status(409).json({
//         success: false,
//         error: "Impossible de créditer le wallet utilisateur.",
//       });
//     }

//     // 2) Créditer admin pour les frais si fournis
//     let updatedAdminWallet = null;

//     if (feeAmount > 0) {
//       if (!adminId) {
//         await session.abortTransaction();
//         return res.status(400).json({
//           success: false,
//           error: "adminUserId est requis si feeDebit.amount > 0.",
//         });
//       }

//       const adminWallet = await ensureWalletForUser({
//         TxWalletBalance,
//         userId: adminId,
//         currency: feeCurrency,
//         session,
//       });

//       updatedAdminWallet = await TxWalletBalance.findOneAndUpdate(
//         { _id: adminWallet._id },
//         {
//           $inc: {
//             amount: feeAmount,
//             availableAmount: feeAmount,
//           },
//         },
//         { new: true, session }
//       );
//     }

//     // 3) Historiser règlement
//     const settlementDocs = await CagnotteVaultWithdrawalSettlement.create(
//       [
//         {
//           reference: ref,
//           idempotencyKey: idem,
//           userId: beneficiaryUserId,
//           adminUserId: adminId || undefined,
//           vaultId: vId,
//           cagnotteId: cId,
//           cagnotteName: String(cagnotteName || "").trim(),
//           mode: m,
//           credit: {
//             amount: creditAmount,
//             currency: creditCurrency,
//           },
//           feeDebit: {
//             amount: feeAmount,
//             currency: feeCurrency || undefined,
//             baseAmount: round2(feeDebit?.baseAmount || 0),
//             baseCurrencyCode: normalizeCurrencyCode(feeDebit?.baseCurrencyCode),
//           },
//           status: "confirmed",
//           userWalletAfter: {
//             walletId: String(updatedUserWallet._id),
//             currency: updatedUserWallet.currency,
//             amount: round2(updatedUserWallet.amount),
//             availableAmount: round2(updatedUserWallet.availableAmount),
//             reservedAmount: round2(updatedUserWallet.reservedAmount || 0),
//           },
//           adminWalletAfter: updatedAdminWallet
//             ? {
//                 walletId: String(updatedAdminWallet._id),
//                 currency: updatedAdminWallet.currency,
//                 amount: round2(updatedAdminWallet.amount),
//                 availableAmount: round2(updatedAdminWallet.availableAmount),
//                 reservedAmount: round2(updatedAdminWallet.reservedAmount || 0),
//               }
//             : null,
//           meta: meta || {},
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
//         settlement?.userWalletAfter?.availableAmount ??
//         settlement?.userWalletAfter?.amount ??
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

exports.settleCagnotteVaultWithdrawal = asyncHandler(async (req, res) => {
  const txConn = getTxConn();
  const TxWalletBalance = buildTxWalletBalanceModel(txConn);
  const CagnotteVaultWithdrawalSettlement =
    buildCagnotteVaultWithdrawalSettlementModel(txConn);

  const {
    reference,
    idempotencyKey,
    userId,
    vaultId,
    cagnotteId,
    cagnotteName,
    mode,
    credit,
    meta,
  } = req.body || {};

  const ref = String(reference || "").trim();
  const idem = String(idempotencyKey || "").trim();
  const beneficiaryUserId = String(userId || "").trim();
  const vId = String(vaultId || "").trim();
  const cId = String(cagnotteId || "").trim();
  const m = String(mode || "").trim().toLowerCase();

  const creditAmount = round2(credit?.amount);
  const creditCurrency = normalizeCurrencyCode(credit?.currency);

  if (!ref || !idem || !beneficiaryUserId || !vId || !cId) {
    return res.status(400).json({
      success: false,
      error:
        "reference, idempotencyKey, userId, vaultId et cagnotteId sont requis.",
    });
  }

  if (!["full", "partial"].includes(m)) {
    return res.status(400).json({
      success: false,
      error: "mode invalide. Valeurs autorisées: full, partial.",
    });
  }

  if (!creditCurrency || creditAmount <= 0) {
    return res.status(400).json({
      success: false,
      error: "credit.amount/credit.currency invalides.",
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
        existingByReference?.userWalletAfter?.availableAmount ??
        existingByReference?.userWalletAfter?.amount ??
        null,
      data: existingByReference,
    });
  }

  const existingByIdem =
    await CagnotteVaultWithdrawalSettlement.findOne({
      userId: beneficiaryUserId,
      idempotencyKey: idem,
    }).lean();

  if (existingByIdem) {
    return res.status(200).json({
      success: true,
      alreadyProcessed: true,
      transactionId: String(existingByIdem._id),
      reference: existingByIdem.reference,
      newBalance:
        existingByIdem?.userWalletAfter?.availableAmount ??
        existingByIdem?.userWalletAfter?.amount ??
        null,
      data: existingByIdem,
    });
  }

  const session = await txConn.startSession();
  let committed = false;

  try {
    session.startTransaction();

    const userWallet = await ensureWalletForUser({
      TxWalletBalance,
      userId: beneficiaryUserId,
      currency: creditCurrency,
      session,
    });

    const updatedUserWallet = await TxWalletBalance.findOneAndUpdate(
      { _id: userWallet._id },
      {
        $inc: {
          amount: creditAmount,
          availableAmount: creditAmount,
        },
      },
      { new: true, session }
    );

    if (!updatedUserWallet) {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        error: "Impossible de créditer le wallet utilisateur.",
      });
    }

    const settlementDocs = await CagnotteVaultWithdrawalSettlement.create(
      [
        {
          reference: ref,
          idempotencyKey: idem,
          userId: beneficiaryUserId,
          vaultId: vId,
          cagnotteId: cId,
          cagnotteName: String(cagnotteName || "").trim(),
          mode: m,
          credit: {
            amount: creditAmount,
            currency: creditCurrency,
          },
          feeDebit: {
            amount: 0,
            currency: undefined,
            baseAmount: 0,
            baseCurrencyCode: undefined,
          },
          status: "confirmed",
          userWalletAfter: {
            walletId: String(updatedUserWallet._id),
            currency: updatedUserWallet.currency,
            amount: round2(updatedUserWallet.amount),
            availableAmount: round2(updatedUserWallet.availableAmount),
            reservedAmount: round2(updatedUserWallet.reservedAmount || 0),
          },
          treasuryWalletAfter: null,
          meta: {
            ...(meta || {}),
            settlementKind: "cagnotte_vault_withdrawal",
            noFeeApplied: true,
            walletSeparation: {
              payerWalletModel: "TxWalletBalance",
              treasuryWalletModel: null,
            },
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
        settlement?.userWalletAfter?.availableAmount ??
        settlement?.userWalletAfter?.amount ??
        null,
      data: settlement.toObject ? settlement.toObject() : settlement,
    });
  } catch (err) {
    try {
      if (!committed) await session.abortTransaction();
    } catch {}

    return res.status(500).json({
      success: false,
      error: err?.message || "Erreur interne TX Core.",
    });
  } finally {
    try {
      session.endSession();
    } catch {}
  }
});