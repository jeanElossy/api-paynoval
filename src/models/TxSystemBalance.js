"use strict";

const mongoose = require("mongoose");

const {
  balancesAsNumbers,
  covers,
  readExact,
  toDecimal128,
} = require("../services/ledger/systemBalanceAmounts");

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
        // Pas d'`index: true` ici : l'index unique partiel déclaré plus bas
        // porte la même clé, et deux index sur une même clé sont interdits
        // (`test/indexDeclarations.test.js`). Les lectures par type portent
        // sur les comptes actifs, que cet index couvre.
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

      /**
       * MONTANTS EXACTS EN BASE — `Decimal128` (2026-09-22).
       *
       * Ils étaient stockés en flottants et incrémentés par `$inc` : mesuré en
       * base, `CAD: 16.150000000000002` et `97.91000000000001`. Les
       * portefeuilles clients étaient déjà exacts, pas les comptes internes.
       *
       * L'accesseur rend des NOMBRES pour que les lecteurs existants
       * (`Number(wallet.balances[CUR])`) continuent de fonctionner — les
       * décisions monétaires, elles, passent par `readExact`.
       */
      balances: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
        get: balancesAsNumbers,
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
      // Sans cela, une réponse d'API sérialiserait les soldes en `Decimal128`
      // bruts (`{ $numberDecimal: "97.91" }`) au lieu de nombres.
      toJSON: { getters: true },
      toObject: { getters: true },
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

  /**
   * UNE SEULE TRÉSORERIE ACTIVE PAR TYPE (2026-09-17).
   *
   * Mesuré sur les bases -test : deux `OPERATIONS_TREASURY` actives, et les
   * frais / la marge de change crédités sur des trésoreries dont le
   * propriétaire n'existait plus. L'index `{userId, systemType}` n'empêche pas
   * cela : il suffit d'un autre `userId`. Réparation :
   * `scripts/relinkSystemTreasuries.js`, puis `npm run indexes:apply`.
   */
  TxSystemBalanceSchema.index(
    { systemType: 1 },
    {
      unique: true,
      partialFilterExpression: { isActive: true },
      name: "one_active_system_wallet_per_type",
    }
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

      const brut = this.get("balances", null, { getters: false }) || this.balances;

      for (const [curRaw, amountRaw] of Object.entries(brut)) {
        const cur = cleanCurrency(curRaw);
        const amount = toDecimal128(amountRaw, cur);

        if (this.managedCurrency !== "MULTI" && cur !== this.managedCurrency) {
          throw new Error(
            `Le treasury ${this.systemType} est mono-devise ${this.managedCurrency}, balance ${cur} interdite`
          );
        }

        brut[cur] = amount;
      }

      if (brut[this.defaultCurrency] == null) {
        brut[this.defaultCurrency] = toDecimal128(0, this.defaultCurrency);
      }

      this.set("balances", brut);
      this.markModified("balances");

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
    // Une trésorerie archivée (`isActive: false`) ne reçoit ni ne rend d'argent.
    const query = {
      $and: [{ $or: buildOwnerClauses(userId, systemType) }, { isActive: { $ne: false } }],
    };
    return this.findOne(query).session(session);
  };

  /**
   * ⚠️ NE CRÉE RIEN PAR DÉFAUT (2026-09-17).
   *
   * Appelée par `credit` et `debit`, elle créait une trésorerie pour N'IMPORTE
   * QUEL `userId` reçu. Une variable `*_TREASURY_USER_ID` restée sur un ancien
   * identifiant fabriquait donc, au premier crédit, une trésorerie orpheline —
   * et l'argent partait dessus, sans erreur. Une trésorerie est un compte
   * PROVISIONNÉ : absente ⇒ `SYSTEM_WALLET_NOT_PROVISIONED` (règle B.2). Seul
   * un provisionnement explicite passe `allowCreate: true`.
   *
   * Devise obligatoire : plus de repli sur `CAD`.
   */
  TxSystemBalanceSchema.statics.ensureSystemWallet = async function (
    userId,
    systemType,
    currency,
    opts = {}
  ) {
    const session = opts.session || null;
    const fullName = String(opts.fullName || systemType || "").trim();
    const email = String(opts.email || "").trim().toLowerCase();
    const metadata =
      opts.metadata && typeof opts.metadata === "object" && !Array.isArray(opts.metadata)
        ? opts.metadata
        : {};

    const cur = cleanCurrency(currency, null);
    const sys = cleanSystemType(systemType);
    const id = cleanId(userId, "userId");

    let doc = await this.findSystemWallet(id, sys, { session });

    if (doc) {
      assertManagedCurrencyCompatibility(doc, cur);

      if (!doc.balances || typeof doc.balances !== "object") {
        doc.balances = {};
      }

      if (readExact(doc, cur) === "0" && doc.balances?.[cur] == null) {
        const brut = doc.get("balances", null, { getters: false }) || {};
        brut[cur] = toDecimal128(0, cur);
        doc.set("balances", brut);
        doc.markModified("balances");
        await doc.save({ session });
      }

      return doc;
    }

    if (opts.allowCreate !== true) {
      const err = new Error(
        `Trésorerie ${sys} non provisionnée pour ${id} : aucune opération effectuée.`
      );
      err.code = "SYSTEM_WALLET_NOT_PROVISIONED";
      err.statusCode = 503;
      err.systemType = sys;
      throw err;
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
          balances: { [cur]: toDecimal128(0, cur) },
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
    const cur = cleanCurrency(currency, null);
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
        // `$inc` avec un `Decimal128` : MongoDB rend un décimal, donc plus
        // aucune queue de flottant ne s'accumule au fil des mouvements.
        $inc: { [balancePath]: toDecimal128(amt, cur) },
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
    const cur = cleanCurrency(currency, null);
    const amt = cleanAmount(amount, cur, { allowZero: false });

    const wallet = await this.ensureSystemWallet(userId, systemType, cur, {
      session,
      fullName: opts.fullName,
      email: opts.email,
      metadata: opts.metadata,
      managedCurrency: opts.managedCurrency,
    });

    assertManagedCurrencyCompatibility(wallet, cur);

    /**
     * Comparaison EXACTE (`covers`) : un `Number()` sur un `Decimal128` vaut
     * `NaN`, et `NaN < amt` est faux — le contrôle de solde aurait donc laissé
     * passer tous les débits sans jamais lever (règle B.2).
     */
    const current = readExact(wallet, cur);

    if (current === null) {
      throw new Error(
        `Solde illisible sur ${systemType} en ${cur} : aucun débit n'est effectué.`
      );
    }

    if (!covers(current, amt)) {
      throw new Error(
        `Solde insuffisant sur ${systemType} en ${cur}. Disponible=${current}, requis=${amt}`
      );
    }

    const balancePath = `balances.${cur}`;

    const updated = await this.findOneAndUpdate(
      {
        _id: wallet._id,
        [balancePath]: { $gte: toDecimal128(amt, cur) },
      },
      {
        $inc: { [balancePath]: toDecimal128(-amt, cur) },
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