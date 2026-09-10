"use strict";

/**
 * ============================================================================
 * PricingCoverageGap — DÉPLACÉ DEPUIS L'API GATEWAY LE 2026-09-10
 * ============================================================================
 *
 * Corridor demandé qu'aucun barème ne couvre.
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
 * CORRIDOR DEMANDÉ SANS RÈGLE APPLICABLE — CONSTATÉ, JAMAIS SUPPOSÉ
 * -----------------------------------------------------------------------------
 * On n'invente aucune matrice théorique de corridors « attendus » : on
 * enregistre les échecs réels du moteur. Chaque ligne est un fait — ce
 * périmètre a été demandé, N fois, et aucune règle ne le couvrait.
 */

const mongoose = require("mongoose");

const pricingCoverageGapSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },

    /** La requête normalisée, telle que le moteur l'a reçue. */
    request: { type: mongoose.Schema.Types.Mixed, required: true },

    occurrences: { type: Number, default: 1, min: 1 },

    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now, index: true },

    /** Posé quand une règle couvrant ce périmètre est publiée. */
    resolvedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, versionKey: false }
);

pricingCoverageGapSchema.index({ resolvedAt: 1, lastSeenAt: -1 });

module.exports = function buildPricingCoverageGapModel(conn) {
  if (!conn) {
    throw new Error(
      "PricingCoverageGap : connexion Mongoose requise (base tarification)."
    );
  }

  if (conn.models.PricingCoverageGap) return conn.models.PricingCoverageGap;

  return conn.model("PricingCoverageGap", pricingCoverageGapSchema);
};
