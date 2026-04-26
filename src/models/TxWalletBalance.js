// // File: models/TxWalletBalance.js

// "use strict";

// const mongoose = require("mongoose");
// const logger = require("../utils/logger");

// function normCurrency(v) {
//   const s = String(v || "").trim().toUpperCase();
//   if (!s) return "CAD";
//   return s;
// }

// function toFixedAmount(amount, currency = "CAD") {
//   const n = Number(amount || 0);
//   const decimals = ["XOF", "XAF", "JPY"].includes(normCurrency(currency)) ? 0 : 2;
//   return mongoose.Types.Decimal128.fromString(n.toFixed(decimals));
// }


// module.exports = (conn = mongoose) => {
//   if (conn.models.TxWalletBalance) return conn.models.TxWalletBalance;

//   const Schema = mongoose.Schema;

//   const balanceSchema = new Schema(
//     {
//       user: {
//         type: Schema.Types.ObjectId,
//         ref: "User",
//         required: [true, "L'identifiant utilisateur est requis"],
//         index: true,
//       },

//       currency: {
//         type: String,
//         required: true,
//         default: "CAD",
//         uppercase: true,
//         trim: true,
//         maxlength: 4,
//         index: true,
//       },

//       amount: {
//         type: mongoose.Schema.Types.Decimal128,
//         required: true,
//         default: () => mongoose.Types.Decimal128.fromString("0"),
//       },

//       reservedAmount: {
//         type: mongoose.Schema.Types.Decimal128,
//         required: true,
//         default: () => mongoose.Types.Decimal128.fromString("0"),
//       },

//       availableAmount: {
//         type: mongoose.Schema.Types.Decimal128,
//         required: true,
//         default: () => mongoose.Types.Decimal128.fromString("0"),
//       },

//       status: {
//         type: String,
//         enum: ["active", "locked"],
//         default: "active",
//         index: true,
//       },

//       metadata: {
//         type: mongoose.Schema.Types.Mixed,
//         default: null,
//       },
//     },
//     {
//       timestamps: true,
//       versionKey: "__v",
//       optimisticConcurrency: true,
//       collection: "tx_wallet_balances",
//     }
//   );

//   balanceSchema.index({ user: 1, currency: 1 }, { unique: true });

//   balanceSchema.pre("validate", function (next) {
//     this.currency = normCurrency(this.currency);

//     const amount = Number(this.amount?.toString?.() || 0);
//     const reserved = Number(this.reservedAmount?.toString?.() || 0);

//     const safeAmount = Number.isFinite(amount) ? amount : 0;
//     const safeReserved = Number.isFinite(reserved) ? reserved : 0;
//     const available = Math.max(0, safeAmount - safeReserved);

//     this.amount = toFixedAmount(safeAmount, this.currency);
//     this.reservedAmount = toFixedAmount(safeReserved, this.currency);
//     this.availableAmount = toFixedAmount(available, this.currency);

//     next();
//   });

//   balanceSchema.statics.findWallet = async function (userId, currency, opts = {}) {
//     return this.findOne(
//       { user: userId, currency: normCurrency(currency) },
//       null,
//       opts
//     );
//   };

//   balanceSchema.statics.ensureWallet = async function (userId, currency, opts = {}) {
//     const cur = normCurrency(currency);

//     return this.findOneAndUpdate(
//       { user: userId, currency: cur },
//       {
//         $setOnInsert: {
//           user: userId,
//           currency: cur,
//           amount: toFixedAmount(0, cur),
//           reservedAmount: toFixedAmount(0, cur),
//           availableAmount: toFixedAmount(0, cur),
//           status: "active",
//         },
//       },
//       {
//         new: true,
//         upsert: true,
//         setDefaultsOnInsert: true,
//         ...opts,
//       }
//     );
//   };

//   balanceSchema.statics.credit = async function (userId, currency, amount, opts = {}) {
//     const cur = normCurrency(currency);
//     const n = Number(amount || 0);

//     if (!Number.isFinite(n) || n <= 0) {
//       throw new Error("Le montant à créditer doit être positif");
//     }

//     await this.ensureWallet(userId, cur, opts);

//     const doc = await this.findOneAndUpdate(
//       { user: userId, currency: cur, status: "active" },
//       { $inc: { amount: n, availableAmount: n } },
//       { new: true, ...opts }
//     );

//     logger.info(`[TxWalletBalance.credit] user=${userId} currency=${cur} amount=${n}`);
//     return doc;
//   };

//   balanceSchema.statics.debit = async function (userId, currency, amount, opts = {}) {
//     const cur = normCurrency(currency);
//     const n = Number(amount || 0);

//     if (!Number.isFinite(n) || n <= 0) {
//       throw new Error("Le montant à débiter doit être positif");
//     }

//     await this.ensureWallet(userId, cur, opts);

//     const doc = await this.findOneAndUpdate(
//       {
//         user: userId,
//         currency: cur,
//         status: "active",
//         availableAmount: { $gte: n },
//         amount: { $gte: n },
//       },
//       {
//         $inc: {
//           amount: -n,
//           availableAmount: -n,
//         },
//       },
//       { new: true, ...opts }
//     );

//     if (!doc) throw new Error(`Solde insuffisant pour ${cur}`);

//     logger.info(`[TxWalletBalance.debit] user=${userId} currency=${cur} amount=${n}`);
//     return doc;
//   };

//   balanceSchema.statics.reserve = async function (userId, currency, amount, opts = {}) {
//     const cur = normCurrency(currency);
//     const n = Number(amount || 0);

//     if (!Number.isFinite(n) || n <= 0) {
//       throw new Error("Le montant à réserver doit être positif");
//     }

//     await this.ensureWallet(userId, cur, opts);

//     const doc = await this.findOneAndUpdate(
//       {
//         user: userId,
//         currency: cur,
//         status: "active",
//         availableAmount: { $gte: n },
//       },
//       {
//         $inc: {
//           reservedAmount: n,
//           availableAmount: -n,
//         },
//       },
//       { new: true, ...opts }
//     );

//     if (!doc) throw new Error(`Fonds disponibles insuffisants pour réserve ${cur}`);

//     logger.info(`[TxWalletBalance.reserve] user=${userId} currency=${cur} amount=${n}`);
//     return doc;
//   };

//   balanceSchema.statics.releaseReserve = async function (userId, currency, amount, opts = {}) {
//     const cur = normCurrency(currency);
//     const n = Number(amount || 0);

//     if (!Number.isFinite(n) || n <= 0) {
//       throw new Error("Le montant à libérer doit être positif");
//     }

//     const doc = await this.findOneAndUpdate(
//       {
//         user: userId,
//         currency: cur,
//         status: "active",
//         reservedAmount: { $gte: n },
//       },
//       {
//         $inc: {
//           reservedAmount: -n,
//           availableAmount: n,
//         },
//       },
//       { new: true, ...opts }
//     );

//     if (!doc) throw new Error(`Réserve insuffisante pour ${cur}`);

//     logger.info(`[TxWalletBalance.releaseReserve] user=${userId} currency=${cur} amount=${n}`);
//     return doc;
//   };

//   balanceSchema.statics.captureReserve = async function (userId, currency, amount, opts = {}) {
//     const cur = normCurrency(currency);
//     const n = Number(amount || 0);

//     if (!Number.isFinite(n) || n <= 0) {
//       throw new Error("Le montant à capturer doit être positif");
//     }

//     const doc = await this.findOneAndUpdate(
//       {
//         user: userId,
//         currency: cur,
//         status: "active",
//         reservedAmount: { $gte: n },
//         amount: { $gte: n },
//       },
//       {
//         $inc: {
//           reservedAmount: -n,
//           amount: -n,
//         },
//       },
//       { new: true, ...opts }
//     );

//     if (!doc) throw new Error(`Réserve insuffisante pour capture ${cur}`);

//     logger.info(`[TxWalletBalance.captureReserve] user=${userId} currency=${cur} amount=${n}`);
//     return doc;
//   };

//   balanceSchema.set("toJSON", {
//     transform(_doc, ret) {
//       ret.id = ret._id;
//       ret.amount = Number(ret.amount?.toString?.() || 0);
//       ret.reservedAmount = Number(ret.reservedAmount?.toString?.() || 0);
//       ret.availableAmount = Number(ret.availableAmount?.toString?.() || 0);
//       delete ret._id;
//       return ret;
//     },
//   });

//   return conn.model("TxWalletBalance", balanceSchema);
// };






// File: models/TxWalletBalance.js

"use strict";

const mongoose = require("mongoose");
const logger = require("../utils/logger");

function normCurrency(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return "CAD";
  return s;
}

function currencyDecimals(currency = "CAD") {
  return ["XOF", "XAF", "JPY"].includes(normCurrency(currency)) ? 0 : 2;
}

function normalizeNumber(amount) {
  const n = Number(amount || 0);
  return Number.isFinite(n) ? n : 0;
}

function roundCurrencyAmount(amount, currency = "CAD") {
  const n = normalizeNumber(amount);
  return Number(n.toFixed(currencyDecimals(currency)));
}

function toFixedAmount(amount, currency = "CAD") {
  const n = normalizeNumber(amount);
  const decimals = currencyDecimals(currency);
  return mongoose.Types.Decimal128.fromString(n.toFixed(decimals));
}

module.exports = (conn = mongoose) => {
  if (conn.models.TxWalletBalance) return conn.models.TxWalletBalance;

  const Schema = mongoose.Schema;

  const balanceSchema = new Schema(
    {
      user: {
        type: Schema.Types.ObjectId,
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
        required: true,
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
      collection: "tx_wallet_balances",
    }
  );

  balanceSchema.index({ user: 1, currency: 1 }, { unique: true });

  balanceSchema.pre("validate", function (next) {
    this.currency = normCurrency(this.currency);

    const amount = normalizeNumber(this.amount?.toString?.() || 0);
    const reserved = normalizeNumber(this.reservedAmount?.toString?.() || 0);

    const safeAmount = roundCurrencyAmount(amount, this.currency);
    const safeReserved = roundCurrencyAmount(reserved, this.currency);
    const available = Math.max(0, safeAmount - safeReserved);

    this.amount = toFixedAmount(safeAmount, this.currency);
    this.reservedAmount = toFixedAmount(safeReserved, this.currency);
    this.availableAmount = toFixedAmount(available, this.currency);

    next();
  });

  balanceSchema.statics.findWallet = async function (
    userId,
    currency,
    opts = {}
  ) {
    return this.findOne(
      { user: userId, currency: normCurrency(currency) },
      null,
      opts
    );
  };

  balanceSchema.statics.ensureWallet = async function (
    userId,
    currency,
    opts = {}
  ) {
    const cur = normCurrency(currency);

    return this.findOneAndUpdate(
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
  };

  balanceSchema.statics.credit = async function (
    userId,
    currency,
    amount,
    opts = {}
  ) {
    const cur = normCurrency(currency);
    const n = roundCurrencyAmount(amount, cur);

    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("Le montant à créditer doit être positif");
    }

    await this.ensureWallet(userId, cur, opts);

    const doc = await this.findOneAndUpdate(
      { user: userId, currency: cur, status: "active" },
      {
        $inc: {
          amount: n,
          availableAmount: n,
        },
      },
      { new: true, ...opts }
    );

    logger.info(
      `[TxWalletBalance.credit] user=${userId} currency=${cur} amount=${n}`
    );

    return doc;
  };

  balanceSchema.statics.debit = async function (
    userId,
    currency,
    amount,
    opts = {}
  ) {
    const cur = normCurrency(currency);
    const n = roundCurrencyAmount(amount, cur);

    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("Le montant à débiter doit être positif");
    }

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

    if (!doc) throw new Error(`Solde insuffisant pour ${cur}`);

    logger.info(
      `[TxWalletBalance.debit] user=${userId} currency=${cur} amount=${n}`
    );

    return doc;
  };

  balanceSchema.statics.reserve = async function (
    userId,
    currency,
    amount,
    opts = {}
  ) {
    const cur = normCurrency(currency);
    const n = roundCurrencyAmount(amount, cur);

    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("Le montant à réserver doit être positif");
    }

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

    logger.info(
      `[TxWalletBalance.reserve] user=${userId} currency=${cur} amount=${n}`
    );

    return doc;
  };

  balanceSchema.statics.releaseReserve = async function (
    userId,
    currency,
    amount,
    opts = {}
  ) {
    const cur = normCurrency(currency);
    const n = roundCurrencyAmount(amount, cur);

    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("Le montant à libérer doit être positif");
    }

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

    if (!doc) throw new Error(`Réserve insuffisante pour ${cur}`);

    logger.info(
      `[TxWalletBalance.releaseReserve] user=${userId} currency=${cur} amount=${n}`
    );

    return doc;
  };

  balanceSchema.statics.captureReserve = async function (
    userId,
    currency,
    amount,
    opts = {}
  ) {
    const cur = normCurrency(currency);
    const n = roundCurrencyAmount(amount, cur);

    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("Le montant à capturer doit être positif");
    }

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

    if (!doc) throw new Error(`Réserve insuffisante pour capture ${cur}`);

    logger.info(
      `[TxWalletBalance.captureReserve] user=${userId} currency=${cur} amount=${n}`
    );

    return doc;
  };

  balanceSchema.statics.cancelReservedWithFee = async function (
    userId,
    currency,
    payload = {},
    opts = {}
  ) {
    const cur = normCurrency(currency);

    const refundAmount = roundCurrencyAmount(payload.refundAmount || 0, cur);
    const feeAmount = roundCurrencyAmount(payload.feeAmount || 0, cur);
    const totalReservedAmount = roundCurrencyAmount(
      payload.totalReservedAmount || refundAmount + feeAmount,
      cur
    );

    if (!Number.isFinite(refundAmount) || refundAmount < 0) {
      throw new Error("Le montant à rembourser est invalide");
    }

    if (!Number.isFinite(feeAmount) || feeAmount < 0) {
      throw new Error("Les frais d’annulation sont invalides");
    }

    if (!Number.isFinite(totalReservedAmount) || totalReservedAmount <= 0) {
      throw new Error("Le montant réservé total est invalide");
    }

    if (refundAmount + feeAmount > totalReservedAmount) {
      throw new Error(
        "Le remboursement et les frais dépassent le montant réservé"
      );
    }

    const update = {
      $inc: {
        reservedAmount: -totalReservedAmount,
      },
    };

    if (refundAmount > 0) {
      update.$inc.availableAmount = refundAmount;
    }

    if (feeAmount > 0) {
      update.$inc.amount = -feeAmount;
    }

    const doc = await this.findOneAndUpdate(
      {
        user: userId,
        currency: cur,
        status: "active",
        reservedAmount: { $gte: totalReservedAmount },
        amount: { $gte: feeAmount },
      },
      update,
      {
        new: true,
        ...opts,
      }
    );

    if (!doc) {
      throw new Error(
        `Réserve insuffisante pour annulation/remboursement en ${cur}`
      );
    }

    logger.info(
      `[TxWalletBalance.cancelReservedWithFee] user=${userId} currency=${cur} refund=${refundAmount} fee=${feeAmount} totalReserved=${totalReservedAmount}`
    );

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

  return conn.model("TxWalletBalance", balanceSchema);
};