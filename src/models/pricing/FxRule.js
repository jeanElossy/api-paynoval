"use strict";

/**
 * ============================================================================
 * FxRule — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
 * ============================================================================
 *
 * Marge de change appliquée à un corridor.
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

const fxRuleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    active: { type: Boolean, default: true, index: true },
    priority: { type: Number, default: 0, index: true },

    txType: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
      enum: ["TRANSFER", "DEPOSIT", "WITHDRAW", ""],
      index: true,
    },

    method: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
      enum: ["MOBILEMONEY", "CARD", "INTERNAL", ""],
      index: true,
    },

    provider: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      index: true,
    },

    // country = scope général facultatif
    country: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      index: true,
    },

    fromCountry: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      index: true,
    },

    toCountry: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      index: true,
    },

    fromCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    toCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    minAmount: { type: Number, default: 0, min: 0 },
    maxAmount: { type: Number, default: null, min: 0 },

    mode: {
      type: String,
      enum: ["PASS_THROUGH", "OVERRIDE", "MARKUP_PERCENT", "DELTA_PERCENT", "DELTA_ABS"],
      default: "PASS_THROUGH",
      index: true,
    },

    overrideRate: { type: Number, default: null },
    markupPercent: { type: Number, default: 0 },
    percent: { type: Number, default: 0 },
    deltaAbs: { type: Number, default: 0 },

    lastUsedAt: { type: Date, default: null },
    notes: { type: String, default: "", trim: true },
  },
  { timestamps: true, versionKey: false }
);

fxRuleSchema.index({
  active: 1,
  txType: 1,
  method: 1,
  provider: 1,
  country: 1,
  fromCountry: 1,
  toCountry: 1,
  fromCurrency: 1,
  toCurrency: 1,
  priority: -1,
  updatedAt: -1,
});

fxRuleSchema.pre("validate", function (next) {
  try {
    if (this.txType) this.txType = String(this.txType).trim().toUpperCase();
    if (this.method) this.method = String(this.method).trim().toUpperCase();
    if (this.provider) this.provider = String(this.provider).trim().toLowerCase();
    if (this.country) this.country = String(this.country).trim().toLowerCase();
    if (this.fromCountry) this.fromCountry = String(this.fromCountry).trim().toLowerCase();
    if (this.toCountry) this.toCountry = String(this.toCountry).trim().toLowerCase();
    if (this.fromCurrency) this.fromCurrency = String(this.fromCurrency).trim().toUpperCase();
    if (this.toCurrency) this.toCurrency = String(this.toCurrency).trim().toUpperCase();

    if (
      this.maxAmount !== null &&
      this.maxAmount !== undefined &&
      Number(this.minAmount || 0) > Number(this.maxAmount)
    ) {
      return next(new Error("minAmount ne peut pas être supérieur à maxAmount"));
    }

    if (this.mode === "OVERRIDE" && !(Number(this.overrideRate) > 0)) {
      return next(new Error("overrideRate doit être > 0 en mode OVERRIDE"));
    }

    next();
  } catch (e) {
    next(e);
  }
});

module.exports = function buildFxRuleModel(conn) {
  if (!conn) {
    throw new Error(
      "FxRule : connexion Mongoose requise (base tarification)."
    );
  }

  if (conn.models.FxRule) return conn.models.FxRule;

  return conn.model("FxRule", fxRuleSchema);
};