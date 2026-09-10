"use strict";

/**
 * ============================================================================
 * PricingQuote — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
 * ============================================================================
 *
 * Devis émis, avec son verrou de prix (`lock`).
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

const PricingQuoteSchema = new mongoose.Schema(
  {
    quoteId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "USED", "EXPIRED"],
      default: "ACTIVE",
      index: true,
    },

    request: {
      txType: {
        type: String,
        required: true,
        uppercase: true,
      },

      method: {
        type: String,
        default: null,
        uppercase: true,
      },

      amount: {
        type: Number,
        required: true,
        min: 0,
      },

      fromCurrency: {
        type: String,
        required: true,
        uppercase: true,
      },

      toCurrency: {
        type: String,
        required: true,
        uppercase: true,
      },

      country: {
        type: String,
        default: null,
        uppercase: true,
      },

      fromCountry: {
        type: String,
        default: null,
        uppercase: true,
      },

      toCountry: {
        type: String,
        default: null,
        uppercase: true,
      },

      operator: {
        type: String,
        default: null,
        lowercase: true,
      },

      provider: {
        type: String,
        default: null,
        lowercase: true,
      },
    },

    result: {
      marketRate: {
        type: Number,
        default: null,
      },

      appliedRate: {
        type: Number,
        required: true,
      },

      fee: {
        type: Number,
        required: true,
        default: 0,
      },

      feeBreakdown: {
        type: Object,
        default: {},
      },

      grossFrom: {
        type: Number,
        required: true,
      },

      netFrom: {
        type: Number,
        required: true,
      },

      netTo: {
        type: Number,
        required: true,
      },

      feeRevenue: {
        sourceCurrency: {
          type: String,
          default: null,
          uppercase: true,
        },

        amount: {
          type: Number,
          default: 0,
        },

        adminCurrency: {
          type: String,
          default: "CAD",
          uppercase: true,
        },

        amountCAD: {
          type: Number,
          default: 0,
        },

        conversionRateToCAD: {
          type: Number,
          default: 0,
        },

        calculatedAt: {
          type: Date,
          default: null,
        },
      },

      fxRevenue: {
        toCurrency: {
          type: String,
          default: null,
          uppercase: true,
        },

        amount: {
          type: Number,
          default: 0,
        },

        rawAmount: {
          type: Number,
          default: 0,
        },

        idealNetTo: {
          type: Number,
          default: 0,
        },

        actualNetTo: {
          type: Number,
          default: 0,
        },

        adminCurrency: {
          type: String,
          default: "CAD",
          uppercase: true,
        },

        amountCAD: {
          type: Number,
          default: 0,
        },

        conversionRateToCAD: {
          type: Number,
          default: 0,
        },

        calculatedAt: {
          type: Date,
          default: null,
        },
      },
    },

    ruleApplied: {
      type: Object,
      default: null,
    },

    fxRuleApplied: {
      type: Object,
      default: null,
    },

    debug: {
      type: Object,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

/**
 * Index TTL :
 * MongoDB supprimera automatiquement le document quand expiresAt est dépassé.
 * Ne pas ajouter `index: true` directement sur expiresAt, sinon Mongoose affiche :
 * Duplicate schema index on {"expiresAt":1}
 */
PricingQuoteSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

/**
 * Index utile pour retrouver rapidement les quotes actives d’un utilisateur.
 */
PricingQuoteSchema.index({
  userId: 1,
  status: 1,
  createdAt: -1,
});

module.exports = function buildPricingQuoteModel(conn) {
  if (!conn) {
    throw new Error(
      "PricingQuote : connexion Mongoose requise (base tarification)."
    );
  }

  if (conn.models.PricingQuote) return conn.models.PricingQuote;

  return conn.model("PricingQuote", PricingQuoteSchema);
};