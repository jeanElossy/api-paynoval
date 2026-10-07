// File: models/AMLLog.js
"use strict";

const mongoose = require("mongoose");

const AMLLogSchema = new mongoose.Schema(
  {
    /**
     * Mode du compte concerné (2026-10-06) — `utils/accountMode.js`. Les
     * entrées des comptes de simulation sont conservées (traçabilité) mais
     * écartées des files et rapports de conformité, qui filtrent sur
     * `mode != "sandbox"`. `null` : mode non résolu au moment de l'écriture
     * (compte illisible) — compté comme production, la direction prudente
     * pour un rapport de conformité.
     */
    mode:          { type: String, enum: ["live", "sandbox", null], default: null },
    userId:        { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
    /**
     * ⚠️ `auto_cancel` ajouté le 2026-09-03.
     *
     * `transactionAutoCancelService.js:537` écrit ce type depuis toujours. Il
     * n'était pas dans l'énumération : CHAQUE annulation automatique échouait
     * donc à écrire son entrée d'audit — et le `catch` de `aml.logTransaction`
     * avalait l'erreur, si bien que rien ne le signalait. Observé en clair sur
     * le banc du 2026-09-03 : « AMLLog validation failed: type: `auto_cancel`
     * is not a valid enum value ».
     *
     * Une auto-annulation LIBÈRE DES FONDS RÉSERVÉS. C'est un mouvement
     * d'argent sans trace d'audit — invariant 4.
     */
    type:          { type: String, enum: ["initiate", "confirm", "cancel", "auto_cancel"], required: true },
    provider:      { type: String, required: true },
    amount:        { type: Number, required: true },
    currency:      { type: String, default: null }, // ISO recommandé (XOF, EUR, USD...)
    toEmail:       { type: String, default: "" },
    details:       { type: Object, default: null },

    flagged:       { type: Boolean, default: false },
    flagReason:    { type: String, default: "" },

    reviewed:      { type: Boolean, default: false },
    reviewedBy:    { type: String, default: null },
    reviewComment: { type: String, default: null },

    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null },
    ip:            { type: String, default: null },

    loggedAt:      { type: Date, default: Date.now },
  },
  { timestamps: true }
);

AMLLogSchema.index({ userId: 1, createdAt: -1 });
AMLLogSchema.index({ flagged: 1, createdAt: -1 });
AMLLogSchema.index({ mode: 1, flagged: 1, createdAt: -1 });
AMLLogSchema.index({ provider: 1, createdAt: -1 });

module.exports = mongoose.models.AMLLog || mongoose.model("AMLLog", AMLLogSchema);
