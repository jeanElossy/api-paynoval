"use strict";

/**
 * ============================================================================
 * PricingRule — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
 * ============================================================================
 *
 * Barème : la règle de tarification elle-même.
 *
 * ── Pourquoi ce modèle a changé de dépôt ────────────────────────────────────
 *
 * Il vivait dans l'API Gateway, avec sept autres modèles de tarification. La
 * passerelle possédait donc le domaine des prix — et Tx-Core, le moteur
 * d'argent, l'appelait en HTTP pour obtenir un devis
 * (`services/transactions/shared/pricing.js`).
 *
 * Cette dépendance remontait : le cœur appelait le bord. Tx-Core l'annonçait
 * lui-même au démarrage — « GATEWAY_URL absente ⇒ toute transaction nécessitant
 * un devis échouera en 503 ». Autrement dit, **une panne de la passerelle
 * arrêtait les virements depuis l'intérieur du moteur**, et la passerelle ne
 * pouvait plus être déployée ni redémarrée indépendamment.
 *
 * Stripe, PayPal et Adyen tiennent tous la même règle : les dépendances
 * DESCENDENT. Le bord appelle les services, les services appellent le moteur,
 * jamais l'inverse. Le bord ne possède aucun domaine et ne détient aucune base.
 *
 * ── Forme FABRIQUE, et non modèle global ────────────────────────────────────
 *
 * Le fichier d'origine faisait `mongoose.model(...)`, qui lie le modèle à la
 * connexion GLOBALE. Tx-Core n'utilise pas la connexion globale pour ses
 * domaines : il ouvre des connexions nommées (`users`, `transactions`, et
 * désormais `pricing`). Un modèle global s'y rattacherait à la mauvaise base,
 * silencieusement — il lirait une collection vide au lieu d'échouer.
 *
 * D'où la fabrique `(conn) => Model`, la forme déjà retenue par tous les
 * modèles de ce dépôt.
 */

const mongoose = require("mongoose");

const AmountRangeSchema = new mongoose.Schema(
  {
    min: { type: Number, default: 0, min: 0 },
    max: { type: Number, default: null },
  },
  { _id: false }
);

const FeeSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ["NONE", "FIXED", "PERCENT", "MIXED"],
      default: "NONE",
    },
    fixed: { type: Number, default: 0, min: 0 },
    percent: { type: Number, default: 0, min: 0 },
    minFee: { type: Number, default: null, min: 0 },
    maxFee: { type: Number, default: null, min: 0 },
  },
  { _id: false }
);

const FxSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ["PASS_THROUGH", "OVERRIDE", "MARKUP_PERCENT", "DELTA_PERCENT", "DELTA_ABS"],
      default: "PASS_THROUGH",
    },

    // OVERRIDE
    overrideRate: { type: Number, default: null },

    // MARKUP_PERCENT => client rate = marketRate * (1 - markupPercent/100)
    markupPercent: { type: Number, default: 0 },

    // DELTA_PERCENT => client rate = marketRate * (1 + percent/100)
    percent: { type: Number, default: 0 },

    // DELTA_ABS => client rate = marketRate + deltaAbs
    deltaAbs: { type: Number, default: 0 },

    notes: { type: String, default: "" },
  },
  { _id: false }
);

const ScopeSchema = new mongoose.Schema(
  {
    txType: {
      type: String,
      /**
       * `CAGNOTTE_PARTICIPATION` / `CAGNOTTE_CLOSURE` (2026-09-10) : les frais
       * de cagnotte étaient codés en dur (0,25 % et 0,5 %) dans le backend.
       * Ils relèvent désormais des mêmes règles gouvernées que les virements.
       */
      /**
       * `CANCELLATION` (2026-09-16) : les frais d'annulation étaient codés en
       * dur dans `config/cancellationFees.js` pour DEUX pays (Canada 2,99 CAD,
       * Côte d'Ivoire 300 XOF), pendant que l'écran de simulation les lisait
       * dans une TROISIÈME source (la collection `Fee`). Un utilisateur pouvait
       * donc voir un montant d'annulation et s'en voir prélever un autre.
       * Ils relèvent désormais des mêmes barèmes gouvernés que le reste.
       */
      enum: [
        "TRANSFER",
        "DEPOSIT",
        "WITHDRAW",
        "CANCELLATION",
        "CAGNOTTE_PARTICIPATION",
        "CAGNOTTE_CLOSURE",
        "ALL",
      ],
      default: "ALL",
      index: true,
    },

    method: {
      type: String,
      enum: ["MOBILEMONEY", "CARD", "INTERNAL", "ALL"],
      default: "ALL",
      index: true,
    },

    provider: {
      type: String,
      trim: true,
      lowercase: true,
      default: "all",
      index: true,
    },

    country: {
      type: String,
      trim: true,
      uppercase: true,
      default: "ALL",
      index: true,
    },

    fromCountry: {
      type: String,
      trim: true,
      uppercase: true,
      default: "ALL",
      index: true,
    },

    toCountry: {
      type: String,
      trim: true,
      uppercase: true,
      default: "ALL",
      index: true,
    },

    fromCurrency: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      index: true,
    },

    toCurrency: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      index: true,
    },
  },
  { _id: false }
);

const PricingRuleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      index: true,
    },

    code: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 80,
      sparse: true,
      index: true,
    },

    description: {
      type: String,
      trim: true,
      default: "",
      maxlength: 500,
    },

    notes: {
      type: String,
      trim: true,
      default: "",
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },

    priority: {
      type: Number,
      default: 0,
      index: true,
    },

    category: {
      type: String,
      enum: ["fee", "fx", "pricing", "other"],
      default: "pricing",
      index: true,
    },

    service: {
      type: String,
      trim: true,
      default: "all",
      index: true,
    },

    scope: {
      type: ScopeSchema,
      required: true,
    },

    countries: [
      {
        type: String,
        trim: true,
        uppercase: true,
      },
    ],

    operators: [
      {
        type: String,
        trim: true,
        lowercase: true,
      },
    ],

    amountRange: {
      type: AmountRangeSchema,
      default: () => ({ min: 0, max: null }),
    },

    fee: {
      type: FeeSchema,
      default: () => ({ mode: "NONE" }),
    },

    fx: {
      type: FxSchema,
      default: () => ({ mode: "PASS_THROUGH" }),
    },

    startsAt: {
      type: Date,
      default: null,
      index: true,
    },

    endsAt: {
      type: Date,
      default: null,
      index: true,
    },

    version: {
      type: Number,
      default: 1,
    },

    /**
     * Numéro de version courant, incrémenté à chaque publication.
     *
     * Remplace `version` ci-dessus, que `pickPayload` remettait à 1 à chaque
     * mise à jour — ce n'était donc pas un versionnage. `version` est conservé
     * pour compatibilité de lecture mais n'est plus écrit par le workflow.
     *
     * C'est aussi le jeton de concurrence : la publication est un $inc gardé
     * sur ce champ.
     */
    currentVersion: {
      type: Number,
      default: 1,
      min: 1,
    },

    /**
     * L'archivage remplace la suppression physique. Une règle supprimée était
     * irrécupérable, et sa disparition changeait instantanément ce que payaient
     * les clients.
     */
    archivedAt: { type: Date, default: null, index: true },
    archivedBy: {
      type: new mongoose.Schema(
        {
          staffId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
          email: { type: String, trim: true, default: "" },
          name: { type: String, trim: true, default: "" },
          at: { type: Date, default: Date.now },
        },
        { _id: false }
      ),
      default: null,
    },

    /** Demande ayant produit l'état courant. */
    lastChangeRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PricingChangeRequest",
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

/**
 * ✅ Index principal de matching
 */
PricingRuleSchema.index(
  {
    active: 1,
    "scope.txType": 1,
    "scope.method": 1,
    "scope.provider": 1,
    "scope.country": 1,
    "scope.fromCountry": 1,
    "scope.toCountry": 1,
    "scope.fromCurrency": 1,
    "scope.toCurrency": 1,
    priority: -1,
    updatedAt: -1,
  },
  { name: "pricing_rule_match_idx" }
);

PricingRuleSchema.pre("validate", function (next) {
  try {
    if (this.code) this.code = String(this.code).trim().toUpperCase();

    if (this.scope) {
      if (this.scope.provider) this.scope.provider = String(this.scope.provider).trim().toLowerCase();
      if (this.scope.country) this.scope.country = String(this.scope.country).trim().toUpperCase();
      if (this.scope.fromCountry) this.scope.fromCountry = String(this.scope.fromCountry).trim().toUpperCase();
      if (this.scope.toCountry) this.scope.toCountry = String(this.scope.toCountry).trim().toUpperCase();
      if (this.scope.fromCurrency) this.scope.fromCurrency = String(this.scope.fromCurrency).trim().toUpperCase();
      if (this.scope.toCurrency) this.scope.toCurrency = String(this.scope.toCurrency).trim().toUpperCase();
    }

    if (this.service) {
      this.service = String(this.service).trim().toLowerCase();
    }

    if (Array.isArray(this.countries)) {
      this.countries = this.countries.map((x) => String(x).trim().toUpperCase()).filter(Boolean);
    }

    if (Array.isArray(this.operators)) {
      this.operators = this.operators.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    }

    if (this.startsAt && this.endsAt && this.endsAt < this.startsAt) {
      return next(new Error("endsAt must be greater than or equal to startsAt"));
    }

    if (
      this.amountRange &&
      this.amountRange.max != null &&
      this.amountRange.min > this.amountRange.max
    ) {
      return next(new Error("amountRange.min cannot be greater than amountRange.max"));
    }

    if (
      this.fee &&
      this.fee.minFee != null &&
      this.fee.maxFee != null &&
      this.fee.minFee > this.fee.maxFee
    ) {
      return next(new Error("fee.minFee cannot be greater than fee.maxFee"));
    }

    next();
  } catch (err) {
    next(err);
  }
});

module.exports = function buildPricingRuleModel(conn) {
  if (!conn) {
    throw new Error(
      "PricingRule : connexion Mongoose requise (base tarification)."
    );
  }

  if (conn.models.PricingRule) return conn.models.PricingRule;

  return conn.model("PricingRule", PricingRuleSchema);
};