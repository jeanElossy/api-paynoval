"use strict";

/**
 * ============================================================================
 * POSITION D'UN COFFRE DE CAGNOTTE — CE QUE TX-CORE DOIT RÉELLEMENT
 * ============================================================================
 *
 * ── Le défaut que ce modèle ferme (R-14 / R-15, 2026-09-10) ─────────────────
 *
 * Le retrait d'un coffre créditait le bénéficiaire du montant ENVOYÉ PAR LE
 * BACKEND, sans aucun plafond. Or le solde du coffre backend pouvait être
 * gonflé (taux fourni par le client) ou re-libellé (changement de devise de la
 * cagnotte, 750 000 XOF devenant 750 000 EUR). Tx-Core, le moteur d'argent,
 * payait donc ce qu'on lui disait de payer.
 *
 * Désormais Tx-Core tient SA position de chaque coffre, écrite dans la même
 * transaction que le grand livre :
 *
 *   · un crédit (participation) l'augmente ;
 *   · un débit (retrait, frais de clôture, remboursement) est CONDITIONNEL —
 *     `balance >= montant` dans le filtre de la mise à jour. Aucun retrait ne
 *     peut dépasser ce qui a été réellement réglé.
 *
 * Le `Vault` du backend devient une projection ; un écart entre les deux est
 * un défaut détectable (réconciliation).
 *
 * ── La devise est IMMUABLE ──────────────────────────────────────────────────
 *
 * Fixée à l'ouverture de la position, `immutable` + `strict: "throw"` : une
 * mise à jour qui tenterait de la changer LÈVE au lieu d'être ignorée en
 * silence. Toute opération présente la devise attendue, et une divergence est
 * refusée (`VAULT_CURRENCY_MISMATCH`).
 *
 * Montants en `Decimal128` : un solde en `double` ne représente pas 0,10.
 */

const mongoose = require("mongoose");

const zero = () => mongoose.Types.Decimal128.fromString("0");

module.exports = function buildCagnotteVaultPositionModel(conn) {
  if (!conn) {
    throw new Error("CagnotteVaultPosition : connexion Mongoose requise (base transactions).");
  }

  const modelName = "CagnotteVaultPosition";
  if (conn.models[modelName]) return conn.models[modelName];

  const D = mongoose.Schema.Types.Decimal128;

  const schema = new mongoose.Schema(
    {
      vaultId: { type: String, required: true, trim: true, immutable: true },
      cagnotteId: { type: String, required: true, trim: true, immutable: true },
      currency: {
        type: String,
        required: true,
        trim: true,
        uppercase: true,
        immutable: true,
        match: /^[A-Z]{3}$/,
      },

      /** Disponible dans le coffre. */
      balance: { type: D, required: true, default: zero },
      /**
       * Net collecté (participations − remboursements). Base de l'objectif et
       * des frais de clôture — ce n'est PAS le solde : les retraits et frais ne
       * le diminuent pas.
       */
      collected: { type: D, required: true, default: zero },
      credited: { type: D, required: true, default: zero },
      refunded: { type: D, required: true, default: zero },
      withdrawn: { type: D, required: true, default: zero },
      closureFees: { type: D, required: true, default: zero },

      /** Posé par le règlement des frais de clôture. Conditionne tout retrait. */
      closedAt: { type: Date, default: null },
      lastMovementAt: { type: Date, default: null },

      /** `backfill` : position reconstruite depuis les règlements historiques. */
      origin: { type: String, enum: ["live", "backfill"], default: "live" },
    },
    {
      collection: "tx_cagnotte_vault_positions",
      timestamps: true,
      strict: "throw",
      minimize: false,
    }
  );

  schema.index({ vaultId: 1 }, { unique: true, name: "uniq_cagnotte_vault_position" });
  schema.index({ cagnotteId: 1 });
  schema.index({ currency: 1, closedAt: 1 });

  return conn.model(modelName, schema);
};
