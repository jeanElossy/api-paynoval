"use strict";

/**
 * ============================================================================
 * ExchangeRate — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
 * ============================================================================
 *
 * Taux de change constaté, et son instantané daté.
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

const exchangeRateSchema = new mongoose.Schema(
  {
    from: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 4, trim: true },
    to: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 4, trim: true },

    rate: { type: Number, required: true, min: 0.00001, max: 999999 },

    // ✅ admin custom rate = active:true
    // ✅ snapshot fallback = active:false
    active: { type: Boolean, default: true },

    updatedBy: { type: String, trim: true, default: null }, // email admin

    // ✅ champs snapshot (optionnels)
    source: { type: String, trim: true, default: null },     // "snapshot" | "db-custom" | "backend:fx" | ...
    provider: { type: String, trim: true, default: null },   // "principal" | "exchangerate-api" | ...
    asOfDate: { type: Date, default: null },
    stale: { type: Boolean, default: false },
  },
  {
    timestamps: true, // ✅ createdAt / updatedAt auto
  }
);

// ✅ Unicité: un seul taux actif (ou snapshot) par pair
exchangeRateSchema.index({ from: 1, to: 1, active: 1 }, { unique: true, name: "uniq_from_to_active" });

module.exports = function buildExchangeRateModel(conn) {
  if (!conn) {
    throw new Error(
      "ExchangeRate : connexion Mongoose requise (base tarification)."
    );
  }

  if (conn.models.ExchangeRate) return conn.models.ExchangeRate;

  return conn.model("ExchangeRate", exchangeRateSchema);
};
