"use strict";

/**
 * ============================================================================
 * PricingRuleVersion — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
 * ============================================================================
 *
 * Historique versionné d'un barème — l'auditabilité des prix.
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

/**
 * SNAPSHOT IMMUABLE D'UNE RÈGLE TARIFAIRE PUBLIÉE
 * -----------------------------------------------------------------------------
 * Un document par publication, jamais modifié après création. Cette collection
 * est à la fois le versionnage et le journal : l'historique d'un prix se lit en
 * lisant ses versions. Il n'existe pas de collection d'audit séparée.
 *
 * L'index unique {ruleId, versionNumber} est ce qui rend le rejeu d'une
 * application interrompue idempotent (voir governanceService.applyChangeRequest).
 */

const mongoose = require("mongoose");

/** Même forme que `paynoval-backend/models/AdminAdjustment.js`. */
const actorSchema = new mongoose.Schema(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    email: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Le snapshot est volontairement `Mixed` : c'est une photographie de la règle
 * telle qu'elle était, pas une entité vivante. La contraindre par un schéma la
 * rendrait illisible le jour où `PricingRule` évoluera — or un journal doit
 * rester lisible même quand le modèle courant a changé.
 */
const pricingRuleVersionSchema = new mongoose.Schema(
  {
    ruleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PricingRule",
      required: true,
      index: true,
    },

    versionNumber: { type: Number, required: true, min: 1 },

    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },

    changeRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PricingChangeRequest",
      default: null,
    },

    publishedBy: { type: actorSchema, required: true },
    publishedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true, versionKey: false }
);

// Arbitre du rejeu : une même version ne peut pas être écrite deux fois.
pricingRuleVersionSchema.index(
  { ruleId: 1, versionNumber: -1 },
  { unique: true, name: "uniq_rule_version" }
);

module.exports = function buildPricingRuleVersionModel(conn) {
  if (!conn) {
    throw new Error(
      "PricingRuleVersion : connexion Mongoose requise (base tarification)."
    );
  }

  if (conn.models.PricingRuleVersion) return conn.models.PricingRuleVersion;

  return conn.model("PricingRuleVersion", pricingRuleVersionSchema);
};

module.exports.actorSchema = actorSchema;
