"use strict";

const mongoose = require("mongoose");

module.exports = function buildTxSystemBalanceModel(conn) {
  if (!conn) {
    throw new Error("TxSystemBalance: connexion Mongo requise");
  }

  const modelName = "TxSystemBalance";
  if (conn.models[modelName]) {
    return conn.models[modelName];
  }
  

  const SYSTEM_TYPES = [
    "REFERRAL_TREASURY",
    "FEES_TREASURY",
    "OPERATIONS_TREASURY",
    "CAGNOTTE_FEES_TREASURY",
    "FX_MARGIN_TREASURY",
  ];

  const SINGLE_CURRENCY_SYSTEM_TYPES = new Set([
    "REFERRAL_TREASURY",
  ]);

  function cleanId(value, fieldName = "userId") {
    const s = String(value || "").trim();
    if (!s) throw new Error(`${fieldName} requis`);
    return s;
  }

  function cleanCurrency(value, fallback = "CAD") {
    const s = String(value || fallback || "").trim().toUpperCase();
    if (!s || s.length < 3 || s.length > 6) {
      throw new Error(`Devise invalide: ${value}`);
    }
    return s;
  }

  function cleanAmount(value, currency = "CAD", { allowZero = true } = {}) {
    const cur = cleanCurrency(currency);
    const decimals = ["XOF", "XAF", "JPY"].includes(cur) ? 0 : 2;
    const factor = 10 ** decimals;
    const num = Number(value || 0);
    const rounded = Math.round(num * factor) / factor;

    if (!Number.isFinite(rounded)) {
      throw new Error(`Montant invalide: ${value}`);
    }

    if (allowZero ? rounded < 0 : rounded <= 0) {
      throw new Error(`Montant invalide (${rounded})`);
    }

    return rounded;
  }

  function cleanSystemType(value) {
    const s = String(value || "").trim().toUpperCase();
    if (!s) throw new Error("systemType requis");
    if (!SYSTEM_TYPES.includes(s)) {
      throw new Error(`systemType invalide: ${value}`);
    }
    return s;
  }

  function defaultManagedCurrencyForSystemType(systemType, defaultCurrency = "CAD") {
    const sys = cleanSystemType(systemType);
    const cur = cleanCurrency(defaultCurrency);
    return SINGLE_CURRENCY_SYSTEM_TYPES.has(sys) ? cur : "MULTI";
  }

  function buildOwnerClauses(userId, systemType) {
    const id = cleanId(userId, "userId");
    const sys = cleanSystemType(systemType);

    const clauses = [
      { userId: id, systemType: sys },
      { ownerId: id, systemType: sys },
    ];

    if (mongoose.Types.ObjectId.isValid(id)) {
      const oid = new mongoose.Types.ObjectId(id);
      clauses.push(
        { userId: oid, systemType: sys },
        { ownerId: oid, systemType: sys }
      );
    }

    return clauses;
  }

  function assertManagedCurrencyCompatibility(doc, currency) {
    const cur = cleanCurrency(currency);
    const managedCurrency = String(doc?.managedCurrency || "MULTI").trim().toUpperCase();
    const defaultCurrency = cleanCurrency(doc?.defaultCurrency || cur);

    if (managedCurrency === "MULTI") return true;

    if (managedCurrency !== cur) {
      throw new Error(
        `Le treasury ${doc?.systemType || ""} est géré en ${managedCurrency}, pas en ${cur}`
      );
    }

    if (defaultCurrency !== cur) {
      throw new Error(
        `Incohérence treasury ${doc?.systemType || ""}: defaultCurrency=${defaultCurrency}, opération en ${cur}`
      );
    }

    return true;
  }

  const BalanceHistorySchema = new mongoose.Schema(
    {
      type: {
        type: String,
        enum: ["credit", "debit", "adjustment"],
        required: true,
      },
      amount: { type: Number, required: true, min: 0 },
      currency: { type: String, required: true, trim: true, uppercase: true },
      reason: { type: String, trim: true, default: null },
      reference: { type: String, trim: true, default: null },
      metadata: { type: mongoose.Schema.Types.Mixed, default: null },
      createdAt: { type: Date, default: Date.now },
    },
    { _id: false }
  );

  const TxSystemBalanceSchema = new mongoose.Schema(
    {
      userId: {
        type: mongoose.Schema.Types.Mixed,
        required: true,
        index: true,
      },

      ownerId: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
        index: true,
      },

      systemType: {
        type: String,
        required: true,
        enum: SYSTEM_TYPES,
        uppercase: true,
        trim: true,
        index: true,
      },

      fullName: {
        type: String,
        trim: true,
        default: "",
      },

      email: {
        type: String,
        trim: true,
        lowercase: true,
        default: "",
      },

      isSystem: {
        type: Boolean,
        default: true,
      },

      managedCurrency: {
        type: String,
        trim: true,
        uppercase: true,
        default: "MULTI",
      },

      defaultCurrency: {
        type: String,
        trim: true,
        uppercase: true,
        default: "CAD",
      },

      balances: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },

      isActive: {
        type: Boolean,
        default: true,
        index: true,
      },

      metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },

      balanceHistory: {
        type: [BalanceHistorySchema],
        default: [],
      },
    },
    {
      timestamps: true,
      collection: "txsystembalances",
    }
  );

  TxSystemBalanceSchema.index(
    { userId: 1, systemType: 1 },
    { unique: true, sparse: true }
  );

  TxSystemBalanceSchema.index(
    { ownerId: 1, systemType: 1 },
    { sparse: true }
  );

  TxSystemBalanceSchema.pre("validate", function preValidate(next) {
    try {
      this.systemType = cleanSystemType(this.systemType);
      this.defaultCurrency = cleanCurrency(this.defaultCurrency || "CAD");

      if (!this.managedCurrency) {
        this.managedCurrency = defaultManagedCurrencyForSystemType(
          this.systemType,
          this.defaultCurrency
        );
      } else {
        this.managedCurrency = String(this.managedCurrency).trim().toUpperCase();
      }

      if (this.managedCurrency !== "MULTI") {
        this.managedCurrency = cleanCurrency(this.managedCurrency, this.defaultCurrency);
      }

      if (typeof this.balances !== "object" || this.balances == null || Array.isArray(this.balances)) {
        this.balances = {};
      }

      for (const [curRaw, amountRaw] of Object.entries(this.balances)) {
        const cur = cleanCurrency(curRaw);
        const amount = cleanAmount(amountRaw, cur, { allowZero: true });

        if (this.managedCurrency !== "MULTI" && cur !== this.managedCurrency) {
          throw new Error(
            `Le treasury ${this.systemType} est mono-devise ${this.managedCurrency}, balance ${cur} interdite`
          );
        }

        this.balances[cur] = amount;
      }

      if (this.balances[this.defaultCurrency] == null) {
        this.balances[this.defaultCurrency] = 0;
      }

      next();
    } catch (err) {
      next(err);
    }
  });

  TxSystemBalanceSchema.statics.findSystemWallet = async function (
    userId,
    systemType,
    opts = {}
  ) {
    const session = opts.session || null;
    const query = { $or: buildOwnerClauses(userId, systemType) };
    return this.findOne(query).session(session);
  };

  TxSystemBalanceSchema.statics.ensureSystemWallet = async function (
    userId,
    systemType,
    currency = "CAD",
    opts = {}
  ) {
    const session = opts.session || null;
    const fullName = String(opts.fullName || systemType || "").trim();
    const email = String(opts.email || "").trim().toLowerCase();
    const metadata =
      opts.metadata && typeof opts.metadata === "object" && !Array.isArray(opts.metadata)
        ? opts.metadata
        : {};

    const cur = cleanCurrency(currency);
    const sys = cleanSystemType(systemType);
    const id = cleanId(userId, "userId");

    let doc = await this.findSystemWallet(id, sys, { session });

    if (doc) {
      assertManagedCurrencyCompatibility(doc, cur);

      if (!doc.balances || typeof doc.balances !== "object") {
        doc.balances = {};
      }

      if (doc.balances[cur] == null) {
        doc.balances[cur] = 0;
        doc.markModified("balances");
        await doc.save({ session });
      }

      return doc;
    }

    const managedCurrency =
      opts.managedCurrency
        ? String(opts.managedCurrency).trim().toUpperCase()
        : defaultManagedCurrencyForSystemType(sys, cur);

    if (managedCurrency !== "MULTI" && managedCurrency !== cur) {
      throw new Error(
        `Création impossible: managedCurrency=${managedCurrency}, currency=${cur}`
      );
    }

    const [created] = await this.create(
      [
        {
          userId: id,
          ownerId: id,
          systemType: sys,
          fullName,
          email,
          isSystem: true,
          managedCurrency,
          defaultCurrency: cur,
          balances: { [cur]: 0 },
          isActive: true,
          metadata,
          balanceHistory: [],
        },
      ],
      { session }
    );

    return created;
  };

  TxSystemBalanceSchema.statics.credit = async function (
    userId,
    systemType,
    currency,
    amount,
    opts = {}
  ) {
    const session = opts.session || null;
    const cur = cleanCurrency(currency);
    const amt = cleanAmount(amount, cur, { allowZero: false });

    const wallet = await this.ensureSystemWallet(userId, systemType, cur, {
      session,
      fullName: opts.fullName,
      email: opts.email,
      metadata: opts.metadata,
      managedCurrency: opts.managedCurrency,
    });

    assertManagedCurrencyCompatibility(wallet, cur);

    const balancePath = `balances.${cur}`;

    const updated = await this.findOneAndUpdate(
      { _id: wallet._id },
      {
        $inc: { [balancePath]: amt },
        $set: {
          updatedAt: new Date(),
          defaultCurrency: wallet.defaultCurrency || cur,
          managedCurrency:
            wallet.managedCurrency ||
            defaultManagedCurrencyForSystemType(wallet.systemType, wallet.defaultCurrency || cur),
          isSystem: true,
          isActive: true,
        },
        $push: {
          balanceHistory: {
            type: "credit",
            amount: amt,
            currency: cur,
            reason: opts.reason || null,
            reference: opts.reference || null,
            metadata:
              opts.historyMetadata && typeof opts.historyMetadata === "object"
                ? opts.historyMetadata
                : null,
            createdAt: new Date(),
          },
        },
      },
      { new: true, session }
    );

    return updated;
  };

  TxSystemBalanceSchema.statics.debit = async function (
    userId,
    systemType,
    currency,
    amount,
    opts = {}
  ) {
    const session = opts.session || null;
    const cur = cleanCurrency(currency);
    const amt = cleanAmount(amount, cur, { allowZero: false });

    const wallet = await this.ensureSystemWallet(userId, systemType, cur, {
      session,
      fullName: opts.fullName,
      email: opts.email,
      metadata: opts.metadata,
      managedCurrency: opts.managedCurrency,
    });

    assertManagedCurrencyCompatibility(wallet, cur);

    const current = Number(wallet?.balances?.[cur] || 0);
    if (current < amt) {
      throw new Error(
        `Solde insuffisant sur ${systemType} en ${cur}. Disponible=${current}, requis=${amt}`
      );
    }

    const balancePath = `balances.${cur}`;

    const updated = await this.findOneAndUpdate(
      {
        _id: wallet._id,
        [balancePath]: { $gte: amt },
      },
      {
        $inc: { [balancePath]: -amt },
        $set: {
          updatedAt: new Date(),
        },
        $push: {
          balanceHistory: {
            type: "debit",
            amount: amt,
            currency: cur,
            reason: opts.reason || null,
            reference: opts.reference || null,
            metadata:
              opts.historyMetadata && typeof opts.historyMetadata === "object"
                ? opts.historyMetadata
                : null,
            createdAt: new Date(),
          },
        },
      },
      { new: true, session }
    );

    if (!updated) {
      throw new Error(
        `Débit impossible sur ${systemType} en ${cur}: concurrence ou solde insuffisant`
      );
    }

    return updated;
  };

  return conn.model(modelName, TxSystemBalanceSchema);
};