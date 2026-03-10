// // File: src/models/Balance.js

// const mongoose = require('mongoose');
// const logger   = require('../utils/logger');

// // Schéma de la balance utilisateur
// const balanceSchema = new mongoose.Schema({
//   user: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'User',
//     required: [true, "L'identifiant utilisateur est requis"]
//   },
//   amount: {
//     type: mongoose.Schema.Types.Decimal128,
//     required: [true, "Le montant du solde est requis"],
//     default: 0,
//     min: [0, "Le montant du solde ne peut pas être négatif"]
//   }
// }, {
//   timestamps: true,
//   versionKey: '__v',
//   optimisticConcurrency: true
// });

// // Index unique sur l’utilisateur
// balanceSchema.index({ user: 1 }, { unique: true });

// /**
//  * Ajoute un montant au solde de l’utilisateur (upsert si n’existe pas)
//  */
// balanceSchema.statics.addToBalance = async function(userId, amount) {
//   if (amount <= 0) throw new Error('Le montant à ajouter doit être positif');
//   const result = await this.findOneAndUpdate(
//     { user: userId },
//     { $inc: { amount } },
//     { new: true, upsert: true, setDefaultsOnInsert: true }
//   );
//   logger.info(`Balance mise à jour pour user=${userId}, new amount=${result.amount}`);
//   return result;
// };

// /**
//  * Retire un montant du solde de l’utilisateur (avec transaction)
//  */
// balanceSchema.statics.withdrawFromBalance = async function(userId, amount) {
//   if (amount <= 0) throw new Error('Le montant à retirer doit être positif');
//   const session = await mongoose.startSession();
//   session.startTransaction();
//   try {
//     const bal = await this.findOne({ user: userId }).session(session);
//     if (!bal || parseFloat(bal.amount.toString()) < amount) {
//       throw new Error('Fonds insuffisants pour le retrait');
//     }
//     // Utiliser Decimal128 pour éviter les erreurs de précision
//     bal.amount = mongoose.Types.Decimal128.fromString(
//       (parseFloat(bal.amount.toString()) - amount).toFixed(2)
//     );
//     await bal.save({ session });
//     await session.commitTransaction();
//     logger.info(`Retrait de ${amount} pour user=${userId}, remaining=${bal.amount}`);
//     return bal;
//   } catch (err) {
//     await session.abortTransaction();
//     logger.error(`Erreur retrait balance pour user=${userId}: ${err.message}`);
//     throw err;
//   } finally {
//     session.endSession();
//   }
// };

// // Hooks de logging
// balanceSchema.post('save', function(doc) {
//   logger.info(`Balance sauvegardée pour user=${doc.user}, amount=${doc.amount}`);
// });
// balanceSchema.post('remove', function(doc) {
//   logger.info(`Balance supprimée pour user=${doc.user}`);
// });

// // Factory pour multi-connexion
// module.exports = (conn = mongoose) =>
//   conn.models.Balance || conn.model('Balance', balanceSchema);






"use strict";

const mongoose = require("mongoose");
const logger = require("../utils/logger");

function normCurrency(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return "CAD";
  return s;
}

function toFixedAmount(amount, currency = "CAD") {
  const n = Number(amount || 0);
  const decimals = ["XOF", "XAF", "JPY"].includes(normCurrency(currency)) ? 0 : 2;
  return mongoose.Types.Decimal128.fromString(n.toFixed(decimals));
}

const balanceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "L'identifiant utilisateur est requis"],
      index: true,
    },

    currency: {
      type: String,
      required: true,
      default: "CAD",
      uppercase: true,
      trim: true,
      maxlength: 4,
      index: true,
    },

    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: [true, "Le montant du solde est requis"],
      default: () => mongoose.Types.Decimal128.fromString("0"),
    },

    reservedAmount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      default: () => mongoose.Types.Decimal128.fromString("0"),
    },

    availableAmount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      default: () => mongoose.Types.Decimal128.fromString("0"),
    },

    status: {
      type: String,
      enum: ["active", "locked"],
      default: "active",
      index: true,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: "__v",
    optimisticConcurrency: true,
  }
);

balanceSchema.index({ user: 1, currency: 1 }, { unique: true });

balanceSchema.pre("validate", function (next) {
  this.currency = normCurrency(this.currency);

  const amount = Number(this.amount?.toString?.() || 0);
  const reserved = Number(this.reservedAmount?.toString?.() || 0);

  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const safeReserved = Number.isFinite(reserved) ? reserved : 0;
  const available = Math.max(0, safeAmount - safeReserved);

  this.amount = toFixedAmount(safeAmount, this.currency);
  this.reservedAmount = toFixedAmount(safeReserved, this.currency);
  this.availableAmount = toFixedAmount(available, this.currency);

  next();
});

balanceSchema.statics.findWallet = async function (userId, currency, opts = {}) {
  return this.findOne({
    user: userId,
    currency: normCurrency(currency),
  }, null, opts);
};

balanceSchema.statics.ensureWallet = async function (userId, currency, opts = {}) {
  const cur = normCurrency(currency);

  const doc = await this.findOneAndUpdate(
    { user: userId, currency: cur },
    {
      $setOnInsert: {
        user: userId,
        currency: cur,
        amount: toFixedAmount(0, cur),
        reservedAmount: toFixedAmount(0, cur),
        availableAmount: toFixedAmount(0, cur),
        status: "active",
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      ...opts,
    }
  );

  return doc;
};

balanceSchema.statics.credit = async function (userId, currency, amount, opts = {}) {
  const cur = normCurrency(currency);
  const n = Number(amount || 0);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Le montant à créditer doit être positif");

  await this.ensureWallet(userId, cur, opts);

  const doc = await this.findOneAndUpdate(
    { user: userId, currency: cur, status: "active" },
    { $inc: { amount: n, availableAmount: n } },
    { new: true, ...opts }
  );

  logger.info(`[Balance.credit] user=${userId} currency=${cur} amount=${n}`);
  return doc;
};

balanceSchema.statics.debit = async function (userId, currency, amount, opts = {}) {
  const cur = normCurrency(currency);
  const n = Number(amount || 0);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Le montant à débiter doit être positif");

  await this.ensureWallet(userId, cur, opts);

  const doc = await this.findOneAndUpdate(
    {
      user: userId,
      currency: cur,
      status: "active",
      availableAmount: { $gte: n },
      amount: { $gte: n },
    },
    {
      $inc: {
        amount: -n,
        availableAmount: -n,
      },
    },
    { new: true, ...opts }
  );

  if (!doc) {
    throw new Error(`Solde insuffisant pour ${cur}`);
  }

  logger.info(`[Balance.debit] user=${userId} currency=${cur} amount=${n}`);
  return doc;
};

balanceSchema.statics.reserve = async function (userId, currency, amount, opts = {}) {
  const cur = normCurrency(currency);
  const n = Number(amount || 0);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Le montant à réserver doit être positif");

  await this.ensureWallet(userId, cur, opts);

  const doc = await this.findOneAndUpdate(
    {
      user: userId,
      currency: cur,
      status: "active",
      availableAmount: { $gte: n },
    },
    {
      $inc: {
        reservedAmount: n,
        availableAmount: -n,
      },
    },
    { new: true, ...opts }
  );

  if (!doc) {
    throw new Error(`Fonds disponibles insuffisants pour réserve ${cur}`);
  }

  logger.info(`[Balance.reserve] user=${userId} currency=${cur} amount=${n}`);
  return doc;
};

balanceSchema.statics.releaseReserve = async function (userId, currency, amount, opts = {}) {
  const cur = normCurrency(currency);
  const n = Number(amount || 0);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Le montant à libérer doit être positif");

  const doc = await this.findOneAndUpdate(
    {
      user: userId,
      currency: cur,
      status: "active",
      reservedAmount: { $gte: n },
    },
    {
      $inc: {
        reservedAmount: -n,
        availableAmount: n,
      },
    },
    { new: true, ...opts }
  );

  if (!doc) {
    throw new Error(`Réserve insuffisante pour ${cur}`);
  }

  logger.info(`[Balance.releaseReserve] user=${userId} currency=${cur} amount=${n}`);
  return doc;
};

balanceSchema.statics.captureReserve = async function (userId, currency, amount, opts = {}) {
  const cur = normCurrency(currency);
  const n = Number(amount || 0);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Le montant à capturer doit être positif");

  const doc = await this.findOneAndUpdate(
    {
      user: userId,
      currency: cur,
      status: "active",
      reservedAmount: { $gte: n },
      amount: { $gte: n },
    },
    {
      $inc: {
        reservedAmount: -n,
        amount: -n,
      },
    },
    { new: true, ...opts }
  );

  if (!doc) {
    throw new Error(`Réserve insuffisante pour capture ${cur}`);
  }

  logger.info(`[Balance.captureReserve] user=${userId} currency=${cur} amount=${n}`);
  return doc;
};

balanceSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id;
    ret.amount = Number(ret.amount?.toString?.() || 0);
    ret.reservedAmount = Number(ret.reservedAmount?.toString?.() || 0);
    ret.availableAmount = Number(ret.availableAmount?.toString?.() || 0);
    delete ret._id;
    return ret;
  },
});

module.exports = (conn = mongoose) =>
  conn.models.Balance || conn.model("Balance", balanceSchema);