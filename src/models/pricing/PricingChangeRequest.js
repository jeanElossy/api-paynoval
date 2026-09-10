"use strict";

/**
 * ============================================================================
 * PricingChangeRequest — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
 * ============================================================================
 *
 * Demande de changement de barème et son circuit d'approbation.
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
 * DEMANDE DE CHANGEMENT TARIFAIRE, SOUMISE À DOUBLE VALIDATION
 * -----------------------------------------------------------------------------
 * Modifier un prix touche TOUTES les transactions des corridors concernés, là
 * où un ajustement de solde n'en touche qu'une. La capacité est donc traitée
 * comme une demande, sur le modèle de `AdminAdjustment`, et non comme une
 * action immédiate.
 *
 * Règle centrale : **`approvedBy` ne peut jamais être égal à `requestedBy`**,
 * sauf dérogation break-glass, réservée au superadmin et motivée. La dérogation
 * est un état visible dans le journal, jamais un contournement silencieux.
 *
 * `PricingRule` ne contient que du tarif publié : tant qu'une demande n'est pas
 * approuvée, son brouillon vit ici et nulle part ailleurs.
 */

const mongoose = require("mongoose");
const { actorSchema } = require("./PricingRuleVersion");

const ACTIONS = ["create", "update", "archive"];

const STATUSES = [
  "pending_approval", // déposée, en attente d'un second valideur
  "approved", // validée, application en cours
  "applied", // publiée, version écrite
  "rejected", // refusée par un second valideur
  "cancelled", // retirée par son auteur
  "failed", // validée mais l'application a échoué
];

const diffEntrySchema = new mongoose.Schema(
  {
    path: { type: String, required: true },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const pricingChangeRequestSchema = new mongoose.Schema(
  {
    action: { type: String, enum: ACTIONS, required: true },

    /** `null` pour une création : la règle n'existe pas encore. */
    ruleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PricingRule",
      default: null,
      index: true,
    },

    /** `null` pour une action `archive` : rien n'est proposé, seul l'état change. */
    proposed: { type: mongoose.Schema.Types.Mixed, default: null },

    /**
     * Version sur laquelle s'appuie la demande. `null` pour une création.
     * Si elle ne correspond plus à `PricingRule.currentVersion` au moment
     * d'appliquer, la demande échoue : deux admins ne peuvent pas s'écraser.
     */
    baseVersion: { type: Number, default: null },

    /**
     * Figé au dépôt. Informatif : c'est `baseVersion` qui fait autorité.
     * L'écran de validation doit signaler un diff périmé plutôt que de
     * l'afficher comme s'il était à jour.
     */
    diff: { type: [diffEntrySchema], default: [] },

    status: {
      type: String,
      enum: STATUSES,
      default: "pending_approval",
      index: true,
    },

    reason: { type: String, required: true, trim: true, maxlength: 1000 },

    requestedBy: { type: actorSchema, required: true },
    approvedBy: { type: actorSchema, default: null },
    rejectedBy: { type: actorSchema, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 1000, default: null },

    breakGlass: {
      used: { type: Boolean, default: false },
      reason: { type: String, trim: true, maxlength: 1000, default: null },
    },

    appliedAt: { type: Date, default: null },
    appliedVersionNumber: { type: Number, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true, versionKey: false }
);

// File d'attente des validations : écran principal du module.
pricingChangeRequestSchema.index({ status: 1, createdAt: -1 });
// Historique des demandes portant sur une règle donnée.
pricingChangeRequestSchema.index({ ruleId: 1, createdAt: -1 });

pricingChangeRequestSchema.statics.ACTIONS = ACTIONS;
pricingChangeRequestSchema.statics.STATUSES = STATUSES;

module.exports = function buildPricingChangeRequestModel(conn) {
  if (!conn) {
    throw new Error(
      "PricingChangeRequest : connexion Mongoose requise (base tarification)."
    );
  }

  if (conn.models.PricingChangeRequest) return conn.models.PricingChangeRequest;

  return conn.model("PricingChangeRequest", pricingChangeRequestSchema);
};

module.exports.ACTIONS = ACTIONS;
module.exports.STATUSES = STATUSES;
