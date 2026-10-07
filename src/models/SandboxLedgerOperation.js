"use strict";

/**
 * Opération de robinet d'un compte sandbox — le document PARENT des écritures
 * du grand livre qu'elle produit (`ledgerService.applySandboxFunding`).
 *
 * Toute écriture se rattache à un `transactionId` : une recharge de simulation
 * n'est pas une `Transaction` (elle n'apparaît pas dans l'historique du
 * client), elle a donc son propre parent, immuable et auditable — qui l'a
 * demandée, quand, combien, pourquoi.
 *
 * Unicité `{userId, idempotencyKey}` : un double appui sur « recharger » ne
 * crédite qu'une fois (invariant 3).
 */

const mongoose = require("mongoose");

const KINDS = Object.freeze(["FAUCET", "DRAIN", "RESET", "PROVISION"]);

const schema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ["sandbox"],
      required: true,
      immutable: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    kind: { type: String, enum: KINDS, required: true, immutable: true },
    direction: { type: String, enum: ["credit", "debit"], required: true, immutable: true },
    amount: { type: mongoose.Schema.Types.Decimal128, required: true, immutable: true },
    currency: { type: String, required: true, uppercase: true, immutable: true },
    reference: { type: String, required: true, immutable: true },
    idempotencyKey: { type: String, default: undefined, immutable: true },
    requestedBy: { type: String, default: null, immutable: true },
  },
  {
    timestamps: true,
    collection: "sandbox_ledger_operations",
  }
);

schema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);
schema.index({ userId: 1, createdAt: -1 });

module.exports = (conn = mongoose) =>
  conn.models.SandboxLedgerOperation ||
  conn.model("SandboxLedgerOperation", schema);

module.exports.KINDS = KINDS;
