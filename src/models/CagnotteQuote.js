"use strict";

/**
 * ============================================================================
 * DEVIS DE PARTICIPATION À UNE CAGNOTTE — LE PRIX AFFICHÉ EST LE PRIX PRÉLEVÉ
 * ============================================================================
 *
 * Le participant voit « Vous payez 100 CAD — la cagnotte reçoit 43 703 XOF »
 * AVANT de confirmer. Ce document fige ces montants : le règlement les RELIT,
 * il ne recalcule pas. Sans lui, le taux bougerait entre l'écran de
 * confirmation et l'écriture comptable.
 *
 * ── Pourquoi dans la base TRANSACTIONS, et pas `PricingQuote` ───────────────
 *
 * `PricingQuote` vit dans la base de tarification, sur une autre connexion.
 * Consommer le devis (ACTIVE → USED) et débiter le portefeuille doivent être
 * UNE seule transaction : sinon un rejeu concurrent consommerait deux fois le
 * même devis, ou un devis consommé resterait sans débit. Ici, la consommation
 * est une mise à jour conditionnelle dans la session du règlement.
 *
 * Un devis est lié à un utilisateur, une cagnotte et un coffre : il ne peut
 * pas servir ailleurs que là où il a été montré.
 */

const mongoose = require("mongoose");

module.exports = function buildCagnotteQuoteModel(conn) {
  if (!conn) {
    throw new Error("CagnotteQuote : connexion Mongoose requise (base transactions).");
  }

  const modelName = "CagnotteQuote";
  if (conn.models[modelName]) return conn.models[modelName];

  const money = new mongoose.Schema(
    {
      amount: { type: Number, required: true, min: 0 },
      currency: { type: String, required: true, uppercase: true, trim: true },
    },
    { _id: false }
  );

  const schema = new mongoose.Schema(
    {
      quoteId: { type: String, required: true, trim: true },
      userId: { type: String, required: true, trim: true },
      cagnotteId: { type: String, required: true, trim: true },
      vaultId: { type: String, required: true, trim: true },

      status: {
        type: String,
        enum: ["ACTIVE", "USED", "EXPIRED"],
        default: "ACTIVE",
      },

      expiresAt: { type: Date, required: true },
      usedAt: { type: Date, default: null },
      usedByReference: { type: String, default: null },

      source: { type: money, required: true },
      fee: { type: money, required: true },
      netSource: { type: Number, required: true, min: 0 },
      destination: { type: money, required: true },

      fx: {
        required: { type: Boolean, required: true },
        appliedRate: { type: Number, required: true },
        marketRate: { type: Number, default: null },
        revenue: { type: money, required: true },
        provider: { type: String, default: null },
        rateSource: { type: String, default: null },
        asOf: { type: Date, default: null },
      },

      rule: {
        ruleId: { type: String, default: null },
        version: { type: Number, default: null },
      },

      requestId: { type: String, default: null },

      /** Conservé 30 jours après expiration pour l'audit, puis purgé. */
      purgeAt: { type: Date, required: true },
    },
    { collection: "tx_cagnotte_quotes", timestamps: true }
  );

  schema.index({ quoteId: 1 }, { unique: true, name: "uniq_cagnotte_quote" });
  schema.index({ userId: 1, createdAt: -1 });
  schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0, name: "cagnotte_quote_ttl" });

  return conn.model(modelName, schema);
};
